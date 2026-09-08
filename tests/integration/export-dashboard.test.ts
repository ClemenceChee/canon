/**
 * Dashboard export integration (canon ↔ langfuse-cost-governance seam) —
 * `canon export --format json` over the committed refunds archive and over an
 * empty (connected-only) store:
 *
 *  - empty project → valid versioned document, empty arrays, `ttrpMs: null`;
 *  - ratified-policy project → metrics (TTRP + precision14) and the promoted
 *    policy mapped to the dashboard contract (ruleKey/kind/confidence/operator/
 *    evidenceTraces), plus divergence cells that sum to the corpus traces with
 *    exactly one divergent trace (the refund_task tool-choice divergence);
 *  - CLI writes the file and prints a summary (exit 0).
 */

import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import { createCanon } from '../../src/app.js';
import type { CanonApp } from '../../src/app.js';
import { createCanonStore } from '../../src/store/index.js';
import type { CanonConfig } from '../../src/store/index.js';
import { GOVERNANCE_EXPORT_VERSION } from '../../src/export/dashboard.js';
import type { GovernanceExport } from '../../src/export/dashboard.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FROZEN = '2025-09-01T12:00:00.000Z';
const EARLIER = '2025-09-01T10:00:00.000Z'; // connect 2 h before the frozen run

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-dashboard-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(projectId = REFUNDS.projectId): CanonConfig {
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

/** Seed a store with the committed refunds archive + config (raw copy). */
async function seedRefunds(projectId = REFUNDS.projectId): Promise<void> {
  await mkdir(join(dir, 'archive'), { recursive: true });
  await copyFile(
    join(FIXTURES, 'archive/refunds/observations.jsonl'),
    join(dir, 'archive/observations.jsonl'),
  );
  await copyFile(
    join(FIXTURES, 'archive/refunds/scores.jsonl'),
    join(dir, 'archive/scores.jsonl'),
  );
  const store = createCanonStore(dir);
  await store.open();
  await store.writeConfig(config(projectId));
  await store.rebuildIndex();
  await store.close();
}

function frozenApp(): CanonApp {
  return createCanon({ dir, clock: () => FROZEN });
}

describe('export --format json (dashboard contract)', () => {
  it('empty project: valid versioned document, empty arrays, ttrpMs null', async () => {
    const store = createCanonStore(dir);
    await store.open();
    await store.writeConfig(config());
    await store.close();

    const { document } = await frozenApp().exportGovernance({});

    expect(document.version).toBe(GOVERNANCE_EXPORT_VERSION);
    expect(document.project).toEqual({ id: REFUNDS.projectId, name: null });
    expect(document.exportedAt).toBe(FROZEN);
    expect(document.metrics.ttrpMs).toBeNull();
    expect(document.metrics.precision14).toEqual({ numerator: 0, denominator: 0, ratio: null });
    expect(document.metrics.proposals).toEqual({
      total: 0, pending: 0, ratified: 0, rejected: 0, decayed: 0,
    });
    expect(document.policies).toEqual([]);
    expect(document.divergence).toEqual([]);
  });

  it('ratified-policy project: metrics + policy mapped to the contract + divergence', async () => {
    await seedRefunds();
    const store = createCanonStore(dir);
    await store.open();
    // a real connect happened 2 h before the frozen analyze/promote run
    await store.appendAudit({
      at: EARLIER,
      actor: 'system',
      type: 'connect',
      projectId: REFUNDS.projectId,
      payload: {},
    });
    await store.close();

    const app = frozenApp();
    const report = await app.analyze({});
    expect(report.proposed).toBe(3);
    const pending = await app.proposals({ status: 'pending' });
    const retry = pending.find((p) => p.kind === 'side-effect-retry')!;
    await app.promote(retry.id, { actor: 'tester' });

    const { document } = await frozenApp().exportGovernance({});

    expect(document.version).toBe(GOVERNANCE_EXPORT_VERSION);
    expect(document.project).toEqual({ id: REFUNDS.projectId, name: null });
    expect(document.metrics.ttrpMs).toBe(2 * 3_600_000); // connect → first promote
    expect(document.metrics.precision14).toEqual({ numerator: 1, denominator: 1, ratio: 1 });
    expect(document.metrics.proposals).toEqual({
      total: 3, pending: 2, ratified: 1, rejected: 0, decayed: 0,
    });

    expect(document.policies).toHaveLength(1);
    const policy = document.policies[0]!;
    expect(policy.ruleKey).toBe('side-effect-retry-chargeback-task-charge-reversal');
    expect(policy.kind).toBe('side-effect-retry');
    expect(policy.status).toBe('ratified');
    expect(policy.confidence).toBe(0.5);
    expect(policy.promotedAt).toBe(FROZEN);
    expect(policy.operator).toBe('tester');
    expect(policy.evidenceTraces).toBe(7);

    // divergence: every corpus trace has exactly one GENERATION model, and the
    // only tool-choice divergence in the fixture is tr_refund_5 (refund_task).
    const totalTraces = document.divergence.reduce((s, c) => s + c.totalTraces, 0);
    const divergentTraces = document.divergence.reduce((s, c) => s + c.divergentTraces, 0);
    expect(totalTraces).toBe(REFUNDS.traces);
    expect(divergentTraces).toBe(1);
    const divergent = document.divergence.find((c) => c.divergentTraces > 0)!;
    expect(divergent.taskKey).toBe('refund_task');
    // deterministic ordering: model asc, then taskKey asc
    const sorted = [...document.divergence].sort((a, b) =>
      a.model !== b.model ? (a.model < b.model ? -1 : 1) : a.taskKey < b.taskKey ? -1 : 1,
    );
    expect(document.divergence).toEqual(sorted);
  });

  it('CLI: export --format json --out writes a versioned document (exit 0)', async () => {
    await seedRefunds();
    const outPath = join(dir, 'canon-state.json');
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    let code = 0;
    try {
      code = await runCli(['export', '--format', 'json', '--out', outPath, '--dir', dir]);
    } finally {
      vi.restoreAllMocks();
    }
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('exported 0 ratified policy(s)');
    const doc = JSON.parse(await readFile(outPath, 'utf8')) as GovernanceExport;
    expect(doc.version).toBe(GOVERNANCE_EXPORT_VERSION);
    expect(doc.project.id).toBe(REFUNDS.projectId);
    expect(doc.policies).toEqual([]);
  });

  it('--verify-links with --format json is a usage error (exit 2)', async () => {
    await seedRefunds();
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    let code = 0;
    try {
      code = await runCli(['export', '--format', 'json', '--verify-links', '--dir', dir]);
    } finally {
      vi.restoreAllMocks();
    }
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('--verify-links only applies to --format guardrules-json');
  });
});
