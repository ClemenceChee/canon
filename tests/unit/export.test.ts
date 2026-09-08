/**
 * Slice 6 unit tests (04: tests/unit/export.test.ts) — the guard-rules pack
 * writer (effective-canon projection, deterministic rule ids, scope
 * derivation incl. index-derived agents), schema validation against the
 * committed JSON Schema, and --verify-links dangling detection. Policies are
 * hand-built fixtures; no engine-generated expectations.
 */

import { describe, expect, it } from 'vitest';
import { buildGuardRulesPack, verifyEvidenceLinks } from '../../src/export/guardRules.js';
import { validateGuardRulesPack } from '../../src/export/schema-guard-rules-v1.js';
import type { Policy } from '../../src/store/policies.js';
import type { CanonStore } from '../../src/store/index.js';

const AT = '2025-09-01T12:00:00.000Z';

function policy(partial: Partial<Policy> & { ruleKey: string; version: number }): Policy {
  return {
    id: `pol_${partial.ruleKey.replace(/[^a-z0-9]/g, '')}_${partial.version}`,
    status: 'active',
    severity: 'advisory',
    ratifiedAt: AT,
    ratifiedBy: 'tester',
    originProposalId: `prop_${partial.ruleKey.replace(/[^a-z0-9]/g, '')}`,
    ruleText: 'structural rule text',
    assertion: 'every run follows the rule',
    constraints: {},
    provenance: {
      confidence: 0.6,
      coverage: {
        traces: 5,
        observations: 9,
        agents: 2,
        sessions: 5,
        window: { from: '2025-08-01T00:00:00.000Z', to: '2025-08-31T00:00:00.000Z' },
        environments: ['production'],
        consistency: 1,
      },
      evidence: [{ role: 'supporting', traceId: 'tr_a_1', observationIds: ['o1', 'o2'] }],
      proposalEdited: false,
      history: [],
    },
    ...partial,
  };
}

const META = {
  projectId: 'prj-demo',
  exportedAt: AT,
  canonVersion: 1,
  source: { tool: 'canon' as const, version: '0.1.0' },
};

describe('buildGuardRulesPack (slice 6)', () => {
  it('exports only the EFFECTIVE canon (latest version per ruleKey) and deterministic rule ids', () => {
    const v1 = policy({ ruleKey: 'tool-choice-refund-task-refund-standard', version: 1 });
    const v2 = policy({ ruleKey: 'tool-choice-refund-task-refund-standard', version: 2 });
    const other = policy({ ruleKey: 'side-effect-retry-chargeback-task-charge-reversal', version: 1 });

    const pack = buildGuardRulesPack([v1, v2, other], META);
    expect(pack.schema).toBe('canon/guard-rules/v1');
    expect(pack.rules).toHaveLength(2);
    const tc = pack.rules.find((r) => r.ruleKey === 'tool-choice-refund-task-refund-standard')!;
    expect(tc.id).toBe('tool-choice-refund-task-refund-standard.v2'); // v1 superseded
    expect(tc.version).toBe(2);
    expect(tc.kind).toBe('tool-choice'); // kind derived from the ruleKey prefix
  });

  it('derives scope from constraints/coverage and agent names from the traceAgents lookup', () => {
    const p = policy({
      ruleKey: 'side-effect-retry-chargeback-task-charge-reversal',
      version: 1,
      constraints: { tool: 'charge-reversal', sideEffect: true, taskKeys: ['chargeback_task'], maxAttempts: 1 },
      provenance: {
        confidence: 0.5,
        coverage: {
          traces: 7,
          observations: 14,
          agents: 1,
          sessions: 7,
          window: { from: '2025-08-27T01:10:00.000Z', to: '2025-08-27T16:00:20.000Z' },
          environments: ['production'],
          consistency: 1,
        },
        evidence: [
          { role: 'supporting', traceId: 'tr_charge_3', observationIds: ['x'] },
          { role: 'supporting', traceId: 'tr_charge_9', observationIds: ['y'] },
        ],
        proposalEdited: false,
        history: [],
      },
    });
    const traceAgents = new Map<string, string | undefined>([
      ['tr_charge_3', 'chargeback-agent'],
      ['tr_charge_9', 'chargeback-agent'],
    ]);
    const pack = buildGuardRulesPack([p], META, { traceAgents });

    const rule = pack.rules[0]!;
    expect(rule.scope).toEqual({
      environments: ['production'],
      agents: ['chargeback-agent'],
      taskKeys: ['chargeback_task'],
    });
    expect(rule.provenance).toMatchObject({
      proposalId: p.originProposalId,
      confidence: 0.5,
      ratifiedBy: 'tester',
      ratifiedAt: AT,
    });
    expect(rule.constraints.sideEffect).toBe(true);
  });

  it('omits unknown agents (missing index entry) from scope without failing', () => {
    const p = policy({ ruleKey: 'model-usage-dispute-task', version: 1 });
    const pack = buildGuardRulesPack([p], META, { traceAgents: new Map() });
    expect(pack.rules[0]!.scope.agents).toEqual([]);
  });

  it('validates against the committed guard-rules v1 JSON schema', () => {
    const p = policy({ ruleKey: 'tool-choice-refund-task-refund-standard', version: 1 });
    const pack = buildGuardRulesPack([p], META);
    expect(validateGuardRulesPack(pack)).toEqual([]);

    // tamper probes: schema/severity violations are caught
    const badSeverity = JSON.parse(JSON.stringify(pack)) as typeof pack;
    badSeverity.rules[0]!.severity = 'urgent' as never;
    expect(validateGuardRulesPack(badSeverity).length).toBeGreaterThan(0);
    const missing = { meta: { projectId: 'x' } };
    expect(validateGuardRulesPack(missing).length).toBeGreaterThan(0);
  });

  it('is deterministic: identical inputs produce an identical pack', () => {
    const ps = [
      policy({ ruleKey: 'model-usage-dispute-task', version: 1 }),
      policy({ ruleKey: 'side-effect-retry-chargeback-task-charge-reversal', version: 1 }),
    ];
    const a = buildGuardRulesPack(ps, META);
    const b = buildGuardRulesPack(ps, META);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.rules.map((r) => r.ruleKey)).toEqual([
      'model-usage-dispute-task',
      'side-effect-retry-chargeback-task-charge-reversal',
    ]); // sorted
  });
});

describe('verifyEvidenceLinks (slice 6)', () => {
  /** Minimal store double: only readArchiveRows is used. */
  function archiveStore(traceIds: string[]): CanonStore {
    return {
      dir: '/tmp/none',
      open: async () => {},
      close: async () => {},
      withLock: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
      readConfig: async () => undefined,
      writeConfig: async () => {},
      appendAudit: async (e) => ({ ...e, seq: 1 }),
      readAudit: async () => [],
      saveProposal: async () => {},
      loadProposal: async () => undefined,
      listProposals: async () => [],
      writePolicy: async () => {},
      listPolicies: async () => [],
      appendObservationRows: async () => ({ appended: 0, dupes: 0 }),
      appendScoreRows: async () => ({ appended: 0, dupes: 0 }),
      rebuildIndex: async () => {
        throw new Error('unused');
      },
      readIndex: async () => {
        throw new Error('unused');
      },
      backfillTraceOutcomes: async () => {},
      traceLines: async () => [],
      readSyncState: async () => undefined,
      writeSyncState: async () => {},
      readStoredRowIds: async () => ({ observations: new Set(), scores: new Set() }),
      readArchiveRows: async () => ({
        observations: traceIds.map((traceId, i) => ({
          line: i + 1,
          envelope: {
            v: 1,
            kind: 'observation',
            fetchedAt: AT,
            projectId: 'prj-demo',
            source: 'test',
            page: 1,
            row: { id: `obs_${i}`, traceId } as never,
          },
        })),
        scores: [],
        corrupted: [],
        corruptedScores: [],
      }),
      wipeProjectData: async () => {},
      status: async () => {
        throw new Error('unused');
      },
    };
  }

  it('returns [] when every evidence trace resolves in the archive', async () => {
    const p = policy({
      ruleKey: 'side-effect-retry-chargeback-task-charge-reversal',
      version: 1,
      provenance: {
        confidence: 0.5,
        coverage: {
          traces: 2, observations: 2, agents: 1, sessions: 2,
          window: { from: '2025-08-27T01:10:00.000Z', to: '2025-08-27T16:00:20.000Z' },
          environments: ['production'], consistency: 1,
        },
        evidence: [
          { role: 'supporting', traceId: 'tr_a_1', observationIds: ['o1'] },
          { role: 'divergent', traceId: 'tr_a_2', observationIds: ['o2'] },
        ],
        proposalEdited: false,
        history: [],
      },
    });
    const pack = buildGuardRulesPack([p], META);
    const store = archiveStore(['tr_a_1', 'tr_a_2']);
    expect(await verifyEvidenceLinks(pack, store)).toEqual([]);
  });

  it('flags dangling evidence when an archive row is removed', async () => {
    const p = policy({
      ruleKey: 'side-effect-retry-chargeback-task-charge-reversal',
      version: 1,
      provenance: {
        confidence: 0.5,
        coverage: {
          traces: 2, observations: 2, agents: 1, sessions: 2,
          window: { from: '2025-08-27T01:10:00.000Z', to: '2025-08-27T16:00:20.000Z' },
          environments: ['production'], consistency: 1,
        },
        evidence: [
          { role: 'supporting', traceId: 'tr_a_1', observationIds: ['o1'] },
          { role: 'divergent', traceId: 'tr_a_2', observationIds: ['o2'] },
        ],
        proposalEdited: false,
        history: [],
      },
    });
    const pack = buildGuardRulesPack([p], META);
    // tr_a_2 was removed from the archive
    const store = archiveStore(['tr_a_1']);
    expect(await verifyEvidenceLinks(pack, store)).toEqual([
      { ruleId: 'side-effect-retry-chargeback-task-charge-reversal.v1', dangling: 1 },
    ]);
  });
});
