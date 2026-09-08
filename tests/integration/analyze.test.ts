/**
 * Analyze over the committed archive fixtures (04 Slice 4 verification:
 * tests/integration/analyze.test.ts). The refunds + edge-rows scenarios ship
 * pre-ingested envelope JSONL archives; analyze runs through the real app and
 * must reproduce the pre-authored golden projections
 * (tests/fixtures/expected/<scenario>/trees.json + analysis.json) EXACTLY.
 * Also verifies DEC-16 index outcome backfill and analyze idempotency.
 */

import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanon } from '../../src/app.js';
import type { CanonApp } from '../../src/app.js';
import { createCanonStore } from '../../src/store/index.js';
import type { CanonConfig } from '../../src/store/index.js';
import type { TraceSummary } from '../../src/store/archive.js';
import { rebuildTrees } from '../../src/analyze/tree.js';
import type { ObservationNode, TraceTree } from '../../src/analyze/tree.js';
import { extractDecisions } from '../../src/analyze/decisions.js';
import { buildProfiles } from '../../src/analyze/profiles.js';
import { divergenceGroups } from '../../src/analyze/divergence.js';
import type { LfObservationRow } from '../../src/trace/types.js';
import { REFUNDS, EDGE_ROWS } from '../fixtures/scenarios.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FROZEN = '2025-09-01T12:00:00.000Z';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-analyze-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(projectId: string): CanonConfig {
  return {
    schema: 'canon/config/v1',
    connection: {
      host: 'https://cloud.langfuse.com',
      baseUrl: 'https://cloud.langfuse.com/api/public',
      projectId,
      publicKey: 'pk',
      secretKey: 'sk',
      connectedAt: FROZEN,
    },
    settings: {
      environment: ['production'],
      redact: { ingest: false, views: true },
      operator: { name: '' },
      sync: { incrementalOverlapHours: 24, backfillWindowDays: 1, politeDelayMs: 0 },
      http: { requestTimeoutMs: 30_000, maxRetries: 5, retryBaseMs: 1_000 },
      decay: { proposalTtlDays: 90 },
      analysis: { minTraces: 3, maxProposalsPerRun: 25 },
    },
  };
}

/** Copy the committed archive JSONL into the store (raw copy — keeps corrupt lines). */
async function seedFromScenario(scenario: string, projectId: string): Promise<void> {
  await mkdir(join(dir, 'archive'), { recursive: true });
  await copyFile(
    join(FIXTURES, 'archive', scenario, 'observations.jsonl'),
    join(dir, 'archive', 'observations.jsonl'),
  );
  await copyFile(
    join(FIXTURES, 'archive', scenario, 'scores.jsonl'),
    join(dir, 'archive', 'scores.jsonl'),
  );
  const store = createCanonStore(dir);
  await store.open();
  await store.writeConfig(config(projectId));
  await store.rebuildIndex();
  await store.close();
}

function app(): CanonApp {
  return createCanon({ dir, clock: () => FROZEN });
}

/** Read the store archive back through the facade (project guard on). */
async function readTrees(): Promise<TraceTree[]> {
  const store = createCanonStore(dir);
  await store.open();
  const archive = await store.readArchiveRows();
  const report = rebuildTrees(
    archive.observations.map((l) => l.envelope.row),
    archive.scores.map((l) => l.envelope.row),
  );
  await store.close();
  return report.trees;
}

function flattenRows(nodes: ObservationNode[]): LfObservationRow[] {
  const out: LfObservationRow[] = [];
  const walk = (node: ObservationNode): void => {
    out.push(node.row);
    for (const child of node.children) walk(child);
  };
  for (const root of nodes) walk(root);
  return out;
}

/** Tree summary projection — must deep-equal the committed trees.json goldens. */
function projectionFor(trees: TraceTree[]): Record<string, unknown> {
  const byTrace: Record<string, unknown> = {};
  for (const tree of trees) {
    const rows = flattenRows(tree.nodes).sort((a, b) => {
      const at = a.startTime ?? '';
      const bt = b.startTime ?? '';
      if (at < bt) return -1;
      if (at > bt) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const tools = rows
      .filter((r) => r.type === 'TOOL' && r.name !== undefined && r.name.length > 0)
      .map((r) => r.name as string);
    const models = [
      ...new Set(
        rows
          .filter((r) => r.type === 'GENERATION' && r.model !== undefined && r.model.length > 0)
          .map((r) => r.model as string),
      ),
    ].sort();
    byTrace[tree.traceId] = {
      ...(tree.agentId !== undefined ? { agentId: tree.agentId } : {}),
      ...(tree.endTime !== undefined ? { endTime: tree.endTime } : {}),
      ...(tree.environment !== undefined ? { environment: tree.environment } : {}),
      models,
      outcome: tree.outcome,
      rootObservationId: tree.rootObservationId,
      rowCount: rows.length,
      scoreCount: tree.scores.length,
      ...(tree.startTime !== undefined ? { startTime: tree.startTime } : {}),
      taskKey: tree.taskKey,
      toolCalls: tools,
    };
  }
  return byTrace;
}

async function readGoldenJson(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(FIXTURES, 'expected', name), 'utf8')) as Record<string, unknown>;
}

describe('analyze over the refunds archive (slice 4)', () => {
  it('report counts, tree projections, facts and groups reproduce the pre-authored goldens', async () => {
    await seedFromScenario(REFUNDS.id, REFUNDS.projectId);
    const goldenTrees = await readGoldenJson('refunds/trees.json');
    const goldenAnalysis = (await readGoldenJson('refunds/analysis.json')) as unknown as {
      traces: number;
      facts: number;
      factsByKind: Record<string, number>;
      agents: string[];
      groups: Array<{ taskKey: string; environment: string; traces: number }>;
    };

    const report = await app().analyze({});
    expect(report.trees).toBe(goldenAnalysis.traces);
    expect(report.skipped).toBe(0);

    const trees = await readTrees();
    expect(Object.keys(projectionFor(trees))).toEqual(Object.keys(goldenTrees.trees as Record<string, unknown>));
    expect(projectionFor(trees)).toEqual(goldenTrees.trees);

    const facts = trees.flatMap((t) => extractDecisions(t));
    const byKind: Record<string, number> = {};
    for (const f of facts) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    expect(report.facts).toBe(goldenAnalysis.facts);
    expect(byKind).toEqual(goldenAnalysis.factsByKind);

    const profiles = buildProfiles(trees);
    expect(report.agents).toBe(goldenAnalysis.agents.length);
    expect(profiles.map((p) => p.agentId).sort()).toEqual(goldenAnalysis.agents);

    const groups = divergenceGroups(trees);
    expect(
      groups.map((g) => ({ taskKey: g.taskKey, environment: g.environment ?? '', traces: g.trees.length })),
    ).toEqual(goldenAnalysis.groups);
  });

  it('DEC-16: analyze back-fills inferred outcomes into the index, replacing unknown', async () => {
    await seedFromScenario(REFUNDS.id, REFUNDS.projectId);
    const store = createCanonStore(dir);
    await store.open();
    const before = await store.readIndex();
    expect(Object.values(before.traces).every((t) => t.outcome === 'unknown')).toBe(true);

    await app().analyze({});

    const after = await store.readIndex();
    const goldenTrees = (await readGoldenJson('refunds/trees.json')).trees as Record<
      string,
      { outcome: string }
    >;
    for (const [traceId, summary] of Object.entries(after.traces)) {
      expect(summary.outcome, traceId).toBe(goldenTrees[traceId]?.outcome);
    }
    expect(Object.values(after.traces).every((t: TraceSummary) => t.outcome !== 'unknown')).toBe(true);
    // geometry-only consumers stay intact: a rebuild resets outcomes to 'unknown'
    await store.rebuildIndex();
    const rebuilt = await store.readIndex();
    expect(Object.values(rebuilt.traces).every((t: TraceSummary) => t.outcome === 'unknown')).toBe(true);
    await store.close();
  });

  it('analyze is idempotent over a stable archive', async () => {
    await seedFromScenario(REFUNDS.id, REFUNDS.projectId);
    const r1 = await app().analyze({});
    const r2 = await app().analyze({});
    // stable geometry + facts across runs; proposals are created once (the
    // slice-5 queue dedupes pending ruleKeys — analyze never duplicates)
    expect(r1).toMatchObject({ trees: expect.any(Number), proposed: 3 });
    expect(r2).toMatchObject({
      trees: r1.trees,
      skipped: r1.skipped,
      facts: r1.facts,
      agents: r1.agents,
      divergenceGroups: r1.divergenceGroups,
      proposed: 0,
      decayed: 0,
    });
    expect(r2.runId).not.toBe(r1.runId);
    const store = createCanonStore(dir);
    await store.open();
    const audit = await store.readAudit();
    expect(audit.filter((e) => e.type === 'analysis.run')).toHaveLength(2);
    expect(audit.filter((e) => e.type === 'proposal.created')).toHaveLength(3);
    await store.close();
  });
});

describe('analyze over the edge-rows archive', () => {
  it('skips missing-traceId / orphan rows and folds the corrupted line into skipped', async () => {
    await seedFromScenario(EDGE_ROWS.id, EDGE_ROWS.projectId);
    const golden = (await readGoldenJson('edge-rows/trees.json')) as unknown as {
      trees: Record<string, unknown>;
      skipped: Array<{ reason: string; rowId?: string }>;
      corrupted: number[];
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await app().analyze({});
    warn.mockRestore();
    // the archive reader's corrupted line (line 8) counts as a skipped
    // 'unparseable' row on top of the row-level skips
    expect(report.skipped).toBe(golden.skipped.length + golden.corrupted.length);

    const trees = await readTrees();
    expect(projectionFor(trees)).toEqual(golden.trees);
    expect(report.trees).toBe(Object.keys(golden.trees).length);
  });
});
