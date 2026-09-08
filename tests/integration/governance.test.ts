/**
 * Slice 5 integration (04: tests/integration/governance.test.ts) — analyze
 * over the committed refunds archive must produce EXACTLY the pre-authored
 * golden proposal trio (expected/refunds/proposals.json, keyed by kind/
 * ruleKey/coverage/evidence — never by generated ids), then the governance
 * + canon CLI flows work end to end: proposals list/show, promote (--as,
 * --set severity=mandatory), reject, version bump on a re-proposal, canon
 * show, and the decay sweep on the analyze/proposals-list boundaries.
 */

import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import { createCanon } from '../../src/app.js';
import type { CanonApp } from '../../src/app.js';
import type { CanonConfig } from '../../src/store/index.js';
import { createCanonStore } from '../../src/store/index.js';
import type { Proposal } from '../../src/store/proposals.js';
import type { CanonError } from '../../src/core/errors.js';
import { addDays } from '../../src/core/time.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FROZEN = '2025-09-01T12:00:00.000Z';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-slice5-'));
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
async function seedRefunds(): Promise<void> {
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
  await store.writeConfig(config());
  await store.rebuildIndex();
  await store.close();
}

function frozenApp(): CanonApp {
  return createCanon({ dir, clock: () => FROZEN });
}

/** Project a Proposal onto the fields the golden encodes (no ids/runIds). */
function goldenProjection(p: Proposal): Record<string, unknown> {
  return {
    kind: p.kind,
    ruleKey: p.ruleKey,
    severity: p.severity,
    title: p.title,
    ruleText: p.ruleText,
    assertion: p.assertion,
    constraints: p.constraints,
    confidence: p.confidence,
    coverage: p.coverage,
    evidence: p.evidence,
  };
}

async function readGoldenProposals(): Promise<Array<Record<string, unknown>>> {
  const raw = JSON.parse(
    await readFile(join(FIXTURES, 'expected/refunds/proposals.json'), 'utf8'),
  ) as { proposals: Array<Record<string, unknown>> };
  return raw.proposals;
}

describe('slice 5: analyze emits the pre-authored golden trio', () => {
  it('the refunds archive produces exactly the golden proposals (engine reproduces the expectation)', async () => {
    await seedRefunds();
    const report = await frozenApp().analyze({});
    expect(report.trees).toBe(REFUNDS.traces);
    expect(report.proposed).toBe(3);

    const all = await frozenApp().proposals({ status: 'all' });
    expect(all).toHaveLength(3);
    const projected = [...all].sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : 1)).map(goldenProjection);
    expect(projected).toEqual(await readGoldenProposals());

    // advisory by default on every proposal
    for (const p of all) expect(p.severity).toBe('advisory');
  });

  it('analyze is idempotent: a second run proposes nothing new (pending dedupe)', async () => {
    await seedRefunds();
    const r1 = await frozenApp().analyze({});
    const r2 = await frozenApp().analyze({});
    expect(r1.proposed).toBe(3);
    expect(r2.proposed).toBe(0);
    expect(await frozenApp().proposals({ status: 'all' })).toHaveLength(3);
  });

  it('settings.analysis.maxProposalsPerRun is the live breaker cap (DEC-20): lowering it below the corpus output truncates the run', async () => {
    await seedRefunds();
    const store = createCanonStore(dir);
    await store.open();
    const cfg = (await store.readConfig())!;
    cfg.settings.analysis.maxProposalsPerRun = 2; // corpus produces 3 specs
    await store.writeConfig(cfg);
    await store.close();

    const report = await frozenApp().analyze({});
    // best-confidence first: tool-choice 0.65 + side-effect-retry 0.50 kept,
    // model-usage 0.45 dropped by the breaker (on top of the corpus's standing
    // floor/consistency drops — the refunds archive emits 5 specs, 3 finalise)
    expect(report.proposed).toBe(2);
    const all = await frozenApp().proposals({ status: 'all' });
    expect(all).toHaveLength(2);
    expect(all.every((p) => p.kind !== 'model-usage')).toBe(true);

    // the breaker drop is counted into the analysis.run audit payload: 2
    // standing floor/consistency drops + 1 breaker drop
    const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const runEvent = audit.find((e) => e.type === 'analysis.run')!;
    expect(runEvent.payload.proposed).toBe(2);
    expect(runEvent.payload.dropped).toBe(3);
  });
});

describe('slice 5: governance + canon CLI flows', () => {
  async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    try {
      const code = await runCli(argv);
      return { code, stdout: out.join('\n'), stderr: err.join('\n') };
    } finally {
      vi.restoreAllMocks();
    }
  }

  async function pendingProposals(): Promise<Proposal[]> {
    return frozenApp().proposals({ status: 'pending' });
  }

  /** seed the refunds archive, then run analyze THROUGH the CLI (real clock). */
  async function seedAndAnalyzeViaCli(): Promise<void> {
    await seedRefunds();
    const res = await cli(['analyze', '--dir', dir]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('proposals created 3');
  }

  it('proposals list/show, promote → canon file, canon show (04 slice-5 walk)', async () => {
    await seedAndAnalyzeViaCli();
    const pending = await pendingProposals();
    const retryId = pending.find((p) => p.kind === 'side-effect-retry')!.id;

    // list shows exactly 3 pending, confidence-descending order
    const list = await cli(['proposals', 'list', '--dir', dir]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('proposals (3 pending)');
    const ordered = [...pending].sort((a, b) => b.confidence - a.confidence).map((p) => p.id);
    const printedIds = list.stdout.split('\n').slice(1).map((l) => l.split('\t')[0]);
    expect(printedIds).toEqual(ordered);

    // show detail
    const show = await cli(['proposals', 'show', retryId, '--dir', dir]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('side-effect-retry');
    expect(show.stdout).toContain('evidence 7 link(s)');

    // promote (attributed) writes the canon policy file
    const promote = await cli([
      'governance', 'promote', retryId, '--as', 'tester', '--dir', dir,
    ]);
    expect(promote.code).toBe(0);
    expect(promote.stdout).toContain('side-effect-retry-chargeback-task-charge-reversal.v1.json');

    const policyRaw = await readFile(
      join(dir, 'canon/side-effect-retry-chargeback-task-charge-reversal.v1.json'),
      'utf8',
    );
    const policy = JSON.parse(policyRaw) as { severity: string; provenance: { proposalEdited: boolean }; ratifiedBy: string };
    expect(policy.severity).toBe('advisory'); // human may set mandatory; canon carries ratified severity
    expect(policy.provenance.proposalEdited).toBe(false);
    expect(policy.ratifiedBy).toBe('tester');

    // promote the SAME id again → invalid-state exit 1
    const again = await cli(['governance', 'promote', retryId, '--as', 'tester', '--dir', dir]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('only pending proposals can be promoted');

    // canon show lists the effective rule
    const canon = await cli(['canon', 'show', '--dir', dir]);
    expect(canon.code).toBe(0);
    expect(canon.stdout).toContain('side-effect-retry-chargeback-task-charge-reversal.v1');
    expect(canon.stdout).toContain('advisory');
  });

  it('promote without --as → exit 2 (attribution is mandatory)', async () => {
    await seedAndAnalyzeViaCli();
    const pending = await pendingProposals();
    const res = await cli(['governance', 'promote', pending[0]!.id, '--dir', dir]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--as');
  });

  it('SHOULD-2: settings.operator.name is the effective reviewer via the CLI when --as and CANON_OPERATOR are absent', async () => {
    const previous = process.env.CANON_OPERATOR;
    delete process.env.CANON_OPERATOR;
    try {
      await seedAndAnalyzeViaCli();
      const pending = await pendingProposals();
      const store = createCanonStore(dir);
      await store.open();
      const cfg = (await store.readConfig())!;
      cfg.settings.operator = { name: 'config-reviewer' };
      await store.writeConfig(cfg);
      await store.close();

      const target = pending[0]!;
      const res = await cli(['governance', 'promote', target.id, '--dir', dir]);
      expect(res.code).toBe(0); // no --as, no env — the config handle attributes
      expect(res.stdout).toContain(target.ruleKey);
      const policy = JSON.parse(
        await readFile(join(dir, 'canon', `${target.ruleKey}.v1.json`), 'utf8'),
      ) as { ratifiedBy: string; version: number };
      expect(policy.ratifiedBy).toBe('config-reviewer');
      expect(policy.version).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CANON_OPERATOR;
      else process.env.CANON_OPERATOR = previous;
    }
  });

  it('--edit --set severity=mandatory ratifies a mandatory policy and records the edit', async () => {
    await seedAndAnalyzeViaCli();
    const pending = await pendingProposals();
    const toolId = pending.find((p) => p.kind === 'tool-choice')!.id;
    const res = await cli([
      'governance', 'promote', toolId, '--as', 'tester', '--edit',
      '--set', 'severity=mandatory', '--note', 'evidence ok', '--dir', dir,
    ]);
    expect(res.code).toBe(0);
    const policy = JSON.parse(
      await readFile(join(dir, 'canon/tool-choice-refund-task-refund-standard.v1.json'), 'utf8'),
    ) as { severity: string; provenance: { proposalEdited: boolean }; ruleText: string };
    expect(policy.severity).toBe('mandatory');
    expect(policy.provenance.proposalEdited).toBe(true);
    // edited rule text stays structural (nothing else was edited)
    expect(policy.ruleText).toContain('refund-standard');

    const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const ev = audit.find((e) => e.type === 'governance.promote' && e.payload?.ruleKey === 'tool-choice-refund-task-refund-standard')!;
    expect(ev.payload.editedFields).toEqual(['severity']);
    expect(JSON.stringify(ev.payload)).not.toContain('evidence ok'); // notes never enter audit
    // the note is recorded on the proposal itself
    const proposal = await frozenApp().showProposal(toolId);
    expect(proposal.reviewNote).toBe('evidence ok');
    expect(proposal.reviewedBy).toBe('tester');
  });

  it('re-analyzing after a ratify creates a NEW pending proposal for the same ruleKey (v2 path)', async () => {
    await seedAndAnalyzeViaCli();
    const pending = await pendingProposals();
    const retryId = pending.find((p) => p.kind === 'side-effect-retry')!.id;
    await cli(['governance', 'promote', retryId, '--as', 'tester', '--dir', dir]);
    const v1 = await readFile(join(dir, 'canon/side-effect-retry-chargeback-task-charge-reversal.v1.json'), 'utf8');

    // re-analyze (CLI): the two still-pending kinds are deduped; the
    // ratified ruleKey is re-proposed as a NEW pending proposal (v2 path)
    const again = await cli(['analyze', '--dir', dir]);
    expect(again.stdout).toContain('proposals created 1');
    const fresh = (await frozenApp().proposals({ status: 'pending' })).find(
      (p) => p.kind === 'side-effect-retry',
    )!;
    const bump = await cli(['governance', 'promote', fresh.id, '--as', 'tester', '--dir', dir]);
    expect(bump.code).toBe(0);
    expect(bump.stdout).toContain('side-effect-retry-chargeback-task-charge-reversal.v2.json');
    // v1 immutable: byte-identical to before the v2 ratify
    expect(await readFile(join(dir, 'canon/side-effect-retry-chargeback-task-charge-reversal.v1.json'), 'utf8')).toBe(v1);
    const canon = await cli(['canon', 'show', '--json', '--dir', dir]);
    const policies = JSON.parse(canon.stdout) as Array<{ ruleKey: string; version: number }>;
    // effective canon: latest version per ruleKey
    const effective = policies.filter((p) => p.ruleKey === 'side-effect-retry-chargeback-task-charge-reversal');
    expect(effective).toHaveLength(1);
    expect(effective[0]!.version).toBe(2);
  });

  it('DEC-23: two store instances racing to promote one id — exactly one ratifies, the second fails cleanly, no duplicate policy version', async () => {
    await seedAndAnalyzeViaCli();
    const pending = await pendingProposals();
    const retryId = pending.find((p) => p.kind === 'side-effect-retry')!.id;

    // two INDEPENDENT app instances (each owns its own store object + lock
    // handle) over the same dir — the cross-process shape, in-process
    const appA = createCanon({ dir, clock: () => FROZEN });
    const appB = createCanon({ dir, clock: () => FROZEN });

    const results = await Promise.allSettled([
      appA.promote(retryId, { actor: 'tester-a' }),
      appB.promote(retryId, { actor: 'tester-b' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = (rejected[0] as PromiseRejectedResult).reason as CanonError;
    // clean failure: either the loser hit the O_EXCL lock while the winner
    // held it, or it acquired the lock after the winner flipped the proposal
    // and its under-lock reload saw 'ratified' (invalid-state). Never a
    // second ratification.
    expect(err.code === 'locked' || err.code === 'invalid-state').toBe(true);

    // exactly one ratification: one policy version, one promote audit line
    const canonDir = join(dir, 'canon');
    const files = (await readdir(canonDir)).filter((n) => n.startsWith('side-effect-retry-chargeback-task-charge-reversal') && n.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('side-effect-retry-chargeback-task-charge-reversal.v1.json');
    const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    expect(
      audit.filter((e) => e.type === 'governance.promote' && e.payload?.proposalId === retryId),
    ).toHaveLength(1);
    const final = await appA.showProposal(retryId);
    expect(final.status).toBe('ratified');
    expect(['tester-a', 'tester-b']).toContain(final.reviewedBy);
  });

  it('DEC-23: a stale pending snapshot cannot double-ratify — the app reloads + revalidates under the lock', async () => {
    await seedAndAnalyzeViaCli();
    const pending = await pendingProposals();
    const retryId = pending.find((p) => p.kind === 'side-effect-retry')!.id;

    // Process B "read the proposal before the race" (the old pre-lock load).
    const storeB = createCanonStore(dir);
    await storeB.open();
    const stale = await storeB.loadProposal(retryId);
    expect(stale?.status).toBe('pending');

    // Process A promotes the id to completion (v1, ratified).
    const appA = createCanon({ dir, clock: () => FROZEN });
    await appA.promote(retryId, { actor: 'tester-a' });

    // B's promote re-enters the app: with the DEC-23 fix the snapshot is
    // loaded INSIDE withLock, so B sees 'ratified' → invalid-state. (Without
    // the fix — a stale pending snapshot handed to the gate under the lock —
    // B would ratify version 2 of the SAME origin proposal.)
    const appB = createCanon({ dir, clock: () => FROZEN });
    await expect(appB.promote(retryId, { actor: 'tester-b' })).rejects.toMatchObject({
      code: 'invalid-state',
    });
    await storeB.close();

    // still exactly one policy version; the stale snapshot was never used
    const files = (await readdir(join(dir, 'canon'))).filter((n) =>
      n.startsWith('side-effect-retry-chargeback-task-charge-reversal'),
    );
    expect(files).toEqual(['side-effect-retry-chargeback-task-charge-reversal.v1.json']);
  });

  it('reject records the decision; proposals list default hides rejected', async () => {
    await seedAndAnalyzeViaCli();
    const pending = await pendingProposals();
    const rejectId = pending.find((p) => p.kind === 'model-usage')!.id;
    const res = await cli([
      'governance', 'reject', rejectId, '--as', 'tester', '--reason', 'weak signal', '--dir', dir,
    ]);
    expect(res.code).toBe(0);
    const updated = await frozenApp().showProposal(rejectId);
    expect(updated.status).toBe('rejected');
    expect(updated.reviewNote).toBe('weak signal');

    const listPending = await cli(['proposals', 'list', '--dir', dir]);
    expect(listPending.stdout).toContain('proposals (2 pending)');
    const all = await cli(['proposals', 'list', '--status', 'all', '--dir', dir]);
    expect(all.stdout).toContain('proposals (3 all)');
    expect(all.stdout).toContain('rejected');
  });

  it('decay sweep runs on the proposals-list boundary (old pending decays)', async () => {
    await seedAndAnalyzeViaCli();
    const store = createCanonStore(dir);
    await store.open();
    // hand-age the model-usage proposal beyond the 90-day TTL
    const stale = (await frozenApp().proposals({ status: 'all' })).find(
      (p) => p.kind === 'model-usage',
    )!;
    const now = new Date().toISOString();
    await store.saveProposal({ ...stale, createdAt: addDays(now, -91), updatedAt: addDays(now, -91) });
    await store.close();
    // proposals created moments ago with the real clock are NOT stale; the
    // hand-aged one is 91 days old (> 90-day TTL) and decays on the list

    const list = await cli(['proposals', 'list', '--dir', dir]);
    expect(list.code).toBe(0);
    // the stale proposal decayed during the sweep → 2 pending remain
    expect(list.stdout).toContain('proposals (2 pending)');
    const aged = await frozenApp().proposals({ status: 'all' });
    const modelUsage = aged.find((p) => p.kind === 'model-usage')!;
    expect(modelUsage.status).toBe('decayed');
    expect(modelUsage.decayedAt).toBeDefined();
    const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    expect(audit.some((e) => e.type === 'proposal.decayed' && e.payload?.proposalId === modelUsage.id)).toBe(true);
  });
});
