/**
 * Governance gate unit tests (04 slice-5: tests/unit/governance.test.ts) over
 * the real file store: promote on non-pending → invalid-state; missing actor
 * rejected; version bump on the same ruleKey (v1 file byte-identical after
 * v2); policy file immutability; advisory default + mandatory via edit;
 * decay sweep at the TTL boundary with a frozen clock.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCanonStore } from '../../src/store/index.js';
import type { CanonConfig, CanonStore } from '../../src/store/index.js';
import type { Proposal } from '../../src/store/proposals.js';
import type { Policy } from '../../src/store/policies.js';
import { addDays } from '../../src/core/time.js';
import { decaySweep, effectiveActor, promote, reject } from '../../src/governance/gate.js';
import { writePolicyFile } from '../../src/store/policies.js';


const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const T0 = '2025-09-01T00:00:00.000Z';

let dir: string;
let store: CanonStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-gov-'));
  store = createCanonStore(dir);
  await store.open();
  await store.writeConfig(sampleConfig());
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function sampleConfig(projectId = 'prj-demo'): CanonConfig {
  return {
    schema: 'canon/config/v1',
    connection: {
      host: 'https://cloud.langfuse.com',
      baseUrl: 'https://cloud.langfuse.com/api/public',
      projectId,
      publicKey: 'pk',
      secretKey: 'sk',
      connectedAt: T0,
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

function makeProposal(ruleKey: string, createdAt = T0, status: Proposal['status'] = 'pending', id = 'prop_test0001'): Proposal {
  return {
    id,
    ruleKey,
    kind: 'tool-choice',
    status,
    severity: 'advisory',
    title: 't',
    ruleText: `rule ${ruleKey}`,
    assertion: 'a',
    constraints: { tools: ['x'], taskKeys: ['t'] },
    confidence: 0.5,
    coverage: {
      traces: 4,
      observations: 4,
      agents: 1,
      sessions: 4,
      window: { from: '2025-08-01T00:00:00.000Z', to: '2025-08-31T00:00:00.000Z' },
      environments: ['production'],
      consistency: 1,
    },
    evidence: [],
    conflictsWith: [],
    createdAt,
    updatedAt: createdAt,
    origin: { runId: 'run_x', analyzerVersion: '0.1.0' },
  };
}

describe('effectiveActor precedence (SHOULD-2: --as > CANON_OPERATOR > settings.operator.name)', () => {
  const previous = process.env.CANON_OPERATOR;

  afterEach(() => {
    if (previous === undefined) delete process.env.CANON_OPERATOR;
    else process.env.CANON_OPERATOR = previous;
  });

  it('--as wins over CANON_OPERATOR env and settings.operator.name', () => {
    process.env.CANON_OPERATOR = 'env-bot';
    expect(effectiveActor('tester', 'config-handle')).toBe('tester');
    expect(effectiveActor('  tester  ', 'config-handle')).toBe('tester'); // trimmed
  });

  it('CANON_OPERATOR env wins over settings.operator.name when --as is absent', () => {
    process.env.CANON_OPERATOR = 'env-bot';
    expect(effectiveActor(undefined, 'config-handle')).toBe('env-bot');
    expect(effectiveActor('', 'config-handle')).toBe('env-bot');
  });

  it('settings.operator.name is the fallback when both --as and CANON_OPERATOR are empty', () => {
    delete process.env.CANON_OPERATOR;
    expect(effectiveActor(undefined, 'config-handle')).toBe('config-handle');
    expect(effectiveActor('', ' config-handle ')).toBe('config-handle'); // trimmed
  });

  it('all three empty → usage error (never anonymous)', () => {
    delete process.env.CANON_OPERATOR;
    expect(() => effectiveActor('', '')).toThrowError(expect.objectContaining({ code: 'usage' }));
    expect(() => effectiveActor(undefined, undefined)).toThrowError(
      expect.objectContaining({ code: 'usage' }),
    );
    expect(() => effectiveActor('   ', '   ')).toThrowError(
      expect.objectContaining({ code: 'usage' }),
    );
  });
});

describe('governance promote', () => {
  it('ratifies a pending proposal into an advisory policy with provenance', async () => {
    const p = makeProposal('tool-choice-demo-x');
    await store.saveProposal(p);
    const result = await promote(p, { actor: 'tester' }, store, { at: T0 });
    expect(result).toMatchObject({
      proposalId: p.id,
      ruleKey: 'tool-choice-demo-x',
      version: 1,
      severity: 'advisory',
      proposalEdited: false,
      editedFields: [],
    });
    expect(result.policyPath).toBe('canon/tool-choice-demo-x.v1.json');

    const policies = await store.listPolicies();
    expect(policies).toHaveLength(1);
    const policy = policies[0]!;
    expect(policy).toMatchObject({
      ruleKey: 'tool-choice-demo-x',
      version: 1,
      severity: 'advisory',
      status: 'active',
      ratifiedBy: 'tester',
      ratifiedAt: T0,
      originProposalId: p.id,
    });
    expect(policy.provenance.proposalEdited).toBe(false);
    // proposal flipped to ratified with review attribution
    const updated = await store.loadProposal(p.id);
    expect(updated?.status).toBe('ratified');
    expect(updated?.reviewedBy).toBe('tester');
    expect(updated?.reviewAction).toBe('promote');
    // audit: governance.promote carries ids/counts only (no note text)
    const audit = await store.readAudit();
    const ev = audit.find((e) => e.type === 'governance.promote')!;
    expect(ev.payload).toEqual({
      proposalId: p.id,
      ruleKey: 'tool-choice-demo-x',
      version: 1,
      policyId: expect.any(String),
    });
  });

  it('promote on a non-pending proposal → invalid-state', async () => {
    const p = makeProposal('tool-choice-demo-y', T0, 'ratified');
    await store.saveProposal(p);
    await expect(promote(p, { actor: 'tester' }, store, { at: T0 })).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });

  it('promote without an attributed actor → usage error', async () => {
    const p = makeProposal('tool-choice-demo-z');
    await store.saveProposal(p);
    const previous = process.env.CANON_OPERATOR;
    delete process.env.CANON_OPERATOR;
    await expect(promote(p, { actor: '' }, store, { at: T0 })).rejects.toMatchObject({
      code: 'usage',
    });
    // CANON_OPERATOR env counts as attribution
    process.env.CANON_OPERATOR = 'ci-bot';
    await promote(p, { actor: '' }, store, { at: T0 });
    expect((await store.loadProposal(p.id))?.reviewedBy).toBe('ci-bot');
    if (previous === undefined) delete process.env.CANON_OPERATOR;
    else process.env.CANON_OPERATOR = previous;
  });

  it('a second proposal with the same ruleKey ratifies as version+1; v1 stays byte-identical', async () => {
    const p1 = makeProposal('rule-demo');
    await store.saveProposal(p1);
    await promote(p1, { actor: 'tester' }, store, { at: T0 });
    const v1Path = join(dir, 'canon', 'rule-demo.v1.json');
    const v1Before = await readFile(v1Path, 'utf8');

    const p2 = { ...makeProposal('rule-demo'), id: 'prop_test0002' };
    await store.saveProposal(p2);
    await promote(p2, { actor: 'tester' }, store, { at: '2025-09-02T00:00:00.000Z' });

    expect(await readFile(v1Path, 'utf8')).toBe(v1Before); // immutable
    const v2 = JSON.parse(await readFile(join(dir, 'canon', 'rule-demo.v2.json'), 'utf8')) as Policy;
    expect(v2.version).toBe(2);
    expect(v2.provenance.history).toHaveLength(1);
    expect(v2.provenance.history[0]!.version).toBe(1);
  });

  it('policy files are immutable: writing the same version twice throws', async () => {
    const p = makeProposal('immutable-rule');
    await store.saveProposal(p);
    await promote(p, { actor: 'tester' }, store, { at: T0 });
    const policy = (await store.listPolicies())[0]!;
    await expect(writePolicyFile(dir, { ...policy })).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });

  it('--edit severity=mandatory writes a mandatory policy and records the diff', async () => {
    const p = makeProposal('mandatory-rule');
    await store.saveProposal(p);
    const result = await promote(
      p,
      { actor: 'tester', edit: { severity: 'mandatory' }, note: 'evidence ok' },
      store,
      { at: T0 },
    );
    expect(result.severity).toBe('mandatory');
    expect(result.proposalEdited).toBe(true);
    expect(result.editedFields).toEqual(['severity']);
    const policy = (await store.listPolicies())[0]!;
    expect(policy.severity).toBe('mandatory');
    expect(policy.provenance.proposalEdited).toBe(true);
    // note text stays on the proposal, never in the audit payload
    const updated = await store.loadProposal(p.id);
    expect(updated?.reviewNote).toBe('evidence ok');
    const audit = await store.readAudit();
    const ev = audit.find((e) => e.type === 'governance.promote')!;
    expect(ev.payload.editedFields).toEqual(['severity']);
    expect(JSON.stringify(ev.payload)).not.toContain('evidence ok');
  });
});

describe('governance reject + decay', () => {
  it('reject records the decision; a rejected proposal cannot be promoted', async () => {
    const p = makeProposal('reject-rule');
    await store.saveProposal(p);
    const result = await reject(p, { actor: 'tester', reason: 'not enough evidence' }, store, { at: T0 });
    expect(result.status).toBe('rejected');
    const updated = await store.loadProposal(p.id);
    expect(updated?.status).toBe('rejected');
    expect(updated?.reviewAction).toBe('reject');
    expect(updated?.reviewNote).toBe('not enough evidence');
    const audit = await store.readAudit();
    const ev = audit.find((e) => e.type === 'governance.reject')!;
    expect(ev.payload).toEqual({ proposalId: p.id, ruleKey: 'reject-rule' });
    await expect(promote(updated!, { actor: 'tester' }, store, { at: T0 })).rejects.toMatchObject({
      code: 'invalid-state',
    });
  });

  it('decay sweep decays pending proposals past the TTL boundary (frozen clock)', async () => {
    const now = '2025-12-01T00:00:00.000Z';
    const old = makeProposal('old-rule', addDays(now, -91), 'pending', 'prop_old0011'); // 91 days before now
    const fresh = makeProposal('fresh-rule', addDays(now, -89), 'pending', 'prop_fresh01');
    await store.saveProposal(old);
    await store.saveProposal(fresh);

    const decayed = await decaySweep(store, now, { proposalTtlDays: 90 });
    expect(decayed.map((d) => d.ruleKey)).toEqual(['old-rule']);
    expect((await store.loadProposal(old.id))?.status).toBe('decayed');
    expect((await store.loadProposal(old.id))?.decayedAt).toBe(now);
    expect((await store.loadProposal(fresh.id))?.status).toBe('pending');
    const audit = await store.readAudit();
    expect(audit.filter((e) => e.type === 'proposal.decayed')).toHaveLength(1);
    // second sweep is a no-op (nothing left to decay)
    const again = await decaySweep(store, now, { proposalTtlDays: 90 });
    expect(again).toEqual([]);
  });
});

void FIXTURES;
