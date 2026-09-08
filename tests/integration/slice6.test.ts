/**
 * Slice 6 integration (04: Slice 6 verification) — export / audit export /
 * metrics over the committed refunds archive + governance flows: the
 * guard-rules pack from a promoted policy deep-equals the committed golden
 * (ids excluded — never keyed on generated ids), validates against the v1
 * schema, --verify-links is clean on an intact archive and fails on a
 * dangling trace, the audit export json digest equals the committed golden
 * and the markdown report carries policy → proposal → evidence chain lines,
 * and metrics computes TTRP + precision14 from the frozen audit sequence.
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
import type { Proposal } from '../../src/store/proposals.js';
import type { Policy } from '../../src/store/policies.js';
import { validateGuardRulesPack } from '../../src/export/schema-guard-rules-v1.js';
import { verifyEvidenceLinks } from '../../src/export/guardRules.js';
import type { GuardRulesPack } from '../../src/export/guardRules.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FROZEN = '2025-09-01T12:00:00.000Z';
const EARLIER = '2025-09-01T10:00:00.000Z'; // connect 2 h before the frozen run
const RETRY_KEY = 'side-effect-retry-chargeback-task-charge-reversal';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-slice6-'));
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

/** analyze (frozen) then promote the side-effect-retry proposal (no edit). */
async function analyzeAndPromoteRetry(): Promise<string> {
  const report = await frozenApp().analyze({});
  expect(report.proposed).toBe(3);
  const pending = await frozenApp().proposals({ status: 'pending' });
  const retry = pending.find((p) => p.kind === 'side-effect-retry')!;
  const res = await frozenApp().promote(retry.id, { actor: 'tester' });
  expect(res.version).toBe(1);
  return retry.id;
}

/** Strip generated ids from a pack rule (goldens are never keyed on them). */
function packProjection(pack: GuardRulesPack): unknown {
  const rules = pack.rules.map((r) => {
    const { proposalId: _proposalId, ...provenance } = r.provenance;
    return { ...r, provenance };
  });
  return { schema: pack.schema, meta: pack.meta, rules };
}

describe('slice 6: guard-rules export', () => {
  it('a single promote exports exactly one rule deep-equal to the committed golden (schema-valid)', async () => {
    await seedRefunds();
    await analyzeAndPromoteRetry();

    const { pack } = await frozenApp().exportGuardRules({ verifyLinks: true });
    expect(pack.rules).toHaveLength(1);
    expect(validateGuardRulesPack(pack)).toEqual([]);

    const golden = JSON.parse(
      await readFile(join(FIXTURES, 'expected/refunds/guardrules.json'), 'utf8'),
    );
    expect(packProjection(pack)).toEqual(golden);
  });

  it('--verify-links fails the export when an evidence trace vanishes from the archive', async () => {
    await seedRefunds();
    await analyzeAndPromoteRetry();
    const { pack } = await frozenApp().exportGuardRules({});
    expect(await verifyEvidenceLinks(pack, createCanonStore(dir))).toEqual([]);

    // remove tr_charge_3 from the archive (evidence of the ratified rule)
    const obsPath = join(dir, 'archive/observations.jsonl');
    const lines = (await readFile(obsPath, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    const kept = lines.filter((l) => !JSON.parse(l).row.traceId.startsWith('tr_charge_'));
    await (await import('node:fs/promises')).writeFile(obsPath, kept.join('\n'), 'utf8');

    const store = createCanonStore(dir);
    await store.open();
    const dangling = await verifyEvidenceLinks(pack, store);
    expect(dangling).toEqual([
      { ruleId: `${RETRY_KEY}.v1`, dangling: 7 },
    ]);
    await store.close();

    // and the app refuses the export when --verify-links is requested
    await expect(frozenApp().exportGuardRules({ verifyLinks: true })).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('evidence-link verification'),
    });
  });

  it('CLI: export --format guardrules-json --out --verify-links writes a schema-valid pack (exit 0)', async () => {
    await seedRefunds();
    await analyzeAndPromoteRetry();
    const outPath = join(dir, 'guardrules.json');
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    let code = 0;
    try {
      code = await runCli(['export', '--format', 'guardrules-json', '--out', outPath, '--verify-links', '--dir', dir]);
    } finally {
      vi.restoreAllMocks();
    }
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('evidence links verified (0 dangling)');
    const written = JSON.parse(await readFile(outPath, 'utf8')) as GuardRulesPack;
    expect(validateGuardRulesPack(written)).toEqual([]);
    expect(written.rules).toHaveLength(1);
    expect(written.meta.source).toEqual({ tool: 'canon', version: '0.1.0' });
  });
});

describe('slice 6: audit export', () => {
  /** Fixed-id governance fixture: deterministic proposal/policy ids + audit seq. */
  async function seedFixedGovernance(): Promise<void> {
    const store = createCanonStore(dir);
    await store.open();
    await store.writeConfig(config());
    const proposal: Proposal = {
      id: 'prop_r1',
      ruleKey: 'tool-choice-refund-task-refund-standard',
      kind: 'tool-choice',
      status: 'ratified',
      severity: 'advisory',
      title: 'title',
      ruleText: 'rule text',
      assertion: 'assertion',
      constraints: { tool: 'refund-standard', taskKeys: ['refund_task'] },
      confidence: 0.65,
      coverage: {
        traces: 7, observations: 8, agents: 2, sessions: 7,
        window: { from: '2025-08-31T09:15:00.000Z', to: '2025-08-31T23:20:12.000Z' },
        environments: ['production'], consistency: 1,
      },
      evidence: [{ role: 'supporting', traceId: 'tr_refund_1', observationIds: ['obs_refund_tool_1'] }],
      conflictsWith: [],
      createdAt: FROZEN,
      updatedAt: FROZEN,
      reviewedAt: FROZEN,
      reviewedBy: 'tester',
      reviewAction: 'promote',
      origin: { runId: 'run_r1', analyzerVersion: '0.1.0' },
    };
    await store.saveProposal(proposal);
    const policy: Policy = {
      id: 'pol_r1',
      ruleKey: proposal.ruleKey,
      version: 1,
      status: 'active',
      severity: 'advisory',
      ratifiedAt: FROZEN,
      ratifiedBy: 'tester',
      originProposalId: proposal.id,
      ruleText: 'rule text',
      assertion: 'assertion',
      constraints: { ...proposal.constraints },
      provenance: {
        confidence: proposal.confidence,
        coverage: proposal.coverage,
        evidence: proposal.evidence,
        proposalEdited: false,
        history: [],
      },
    };
    await store.writePolicy(policy);
    await store.appendAudit({ at: FROZEN, actor: 'system', type: 'connect', projectId: REFUNDS.projectId, payload: {} });
    await store.appendAudit({ at: FROZEN, actor: 'system', type: 'proposal.created', projectId: REFUNDS.projectId, payload: { proposalId: proposal.id, ruleKey: proposal.ruleKey, kind: proposal.kind, runId: 'run_r1' } });
    await store.appendAudit({ at: FROZEN, actor: 'tester', type: 'governance.promote', projectId: REFUNDS.projectId, payload: { proposalId: proposal.id, ruleKey: proposal.ruleKey, version: 1, policyId: policy.id } });
    await store.close();
  }

  it('json digest equals the committed golden; md report carries policy → proposal → evidence lines', async () => {
    await seedFixedGovernance();
    const { digest, markdown } = await frozenApp().exportAudit({ format: 'json' });

    const golden = JSON.parse(
      await readFile(join(FIXTURES, 'expected/refunds/audit-digest.json'), 'utf8'),
    );
    expect(digest).toEqual(golden);

    expect(markdown).toContain('# canon audit export');
    expect(markdown).toContain('## Policy chain');
    expect(markdown).toContain('### tool-choice-refund-task-refund-standard.v1');
    expect(markdown).toContain('- ruleKey: tool-choice-refund-task-refund-standard');
    expect(markdown).toContain('- reviewedBy: tester'); // e2e assertion shape
    expect(markdown).toContain('- originProposal: prop_r1');
    expect(markdown).toContain('- evidence: tr_refund_1');
    expect(markdown).toContain('- [3] 2025-09-01T12:00:00.000Z tester governance.promote proposal prop_r1');
  });

  it('CLI: audit export --format md --out writes the report; --format json --out writes the digest', async () => {
    await seedFixedGovernance();
    const mdPath = join(dir, 'audit.md');
    const jsonPath = join(dir, 'audit.json');
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    try {
      const mdCode = await runCli(['audit', 'export', '--format', 'md', '--out', mdPath, '--dir', dir]);
      expect(mdCode).toBe(0);
      const jsonCode = await runCli(['audit', 'export', '--format', 'json', '--out', jsonPath, '--dir', dir]);
      expect(jsonCode).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    const md = await readFile(mdPath, 'utf8');
    expect(md).toContain('reviewedBy: tester');
    const json = JSON.parse(await readFile(jsonPath, 'utf8'));
    expect(json.schema).toBe('canon/audit/v1');
    expect(json.policyChain).toHaveLength(1);
  });

  it('invalid --format is a usage error (exit 2)', async () => {
    await seedFixedGovernance();
    const err: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    let code = 0;
    try {
      code = await runCli(['audit', 'export', '--format', 'xml', '--dir', dir]);
    } finally {
      vi.restoreAllMocks();
    }
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('--format must be json | md');
  });
});

describe('slice 6: metrics', () => {
  it('computes TTRP and precision14 from the frozen connect → analyze → promote sequence', async () => {
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

    await analyzeAndPromoteRetry();
    const m = await frozenApp().metrics();
    expect(m.projectId).toBe(REFUNDS.projectId);
    expect(m.connectedAt).toBe(EARLIER);
    expect(m.firstPromoteAt).toBe(FROZEN);
    expect(m.ttrp).toEqual({ ms: 2 * 3_600_000 }); // hand-computed: connect → first promote
    // one ratified proposal whose decision fell within its 14-day window
    expect(m.precision14).toEqual({ numerator: 1, denominator: 1, ratio: 1 });
    expect(m.proposals).toEqual({ total: 3, pending: 2, ratified: 1, rejected: 0, decayed: 0 });
  });

  it('CLI metrics --json prints the reading points; human view hints when ttrp is null', async () => {
    await seedRefunds();
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    try {
      const code = await runCli(['metrics', '--json', '--dir', dir]);
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.ttrp).toBeNull(); // no connect/promote events yet
      expect(parsed.proposals.total).toBe(0);
      expect(parsed.precision14.ratio).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
