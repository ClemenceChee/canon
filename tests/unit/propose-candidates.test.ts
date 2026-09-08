/**
 * Direct unit tests for the propose ENGINE's emission drop paths (ADR-0004
 * DEC-24 / QA M2): the per-kind floor, the minConsistency gate and the
 * per-run circuit breaker, plus the costlier-model success-gain no-emission
 * branch — all with SYNTHETIC cases that fall below each gate (the refunds
 * corpus clears every gate with margin, so only direct synthetic tests can
 * pin the drop behaviour). Builds minimal DivergenceGroup/TraceTree/
 * DecisionFact fixtures by hand — no engine-generated expectations.
 */

import { describe, expect, it } from 'vitest';
import { buildCandidates } from '../../src/propose/candidates.js';
import { DEFAULT_SCORING_CONSTANTS } from '../../src/propose/scoring.constants.js';
import type { DecisionFact } from '../../src/analyze/decisions.js';
import type { DivergenceGroup } from '../../src/analyze/divergence.js';
import type { TraceTree } from '../../src/analyze/tree.js';
import type { Outcome } from '../../src/store/archive.js';

const CTX = { runId: 'run_synthetic', analyzerVersion: '0.1.0', at: '2025-09-01T12:00:00.000Z' };
const ENV = 'production';

function trace(
  traceId: string,
  agentId: string,
  taskKey: string,
  outcome: Outcome = 'failure',
): TraceTree {
  return {
    traceId,
    agentId,
    taskKey,
    environment: ENV,
    sessionId: `sess-${traceId}`,
    userId: 'u-1',
    startTime: '2025-08-30T09:00:00.000Z',
    endTime: '2025-08-30T09:00:05.000Z',
    outcome,
    nodes: [],
    scores: [],
  };
}

function group(taskKey: string, trees: TraceTree[]): DivergenceGroup {
  const agents = new Set<string>();
  const outcomeSplit = { success: 0, failure: 0, unknown: 0 } as DivergenceGroup['outcomeSplit'];
  for (const t of trees) {
    if (t.agentId !== undefined) agents.add(t.agentId);
    outcomeSplit[t.outcome] += 1;
  }
  return { taskKey, environment: ENV, trees, agents, outcomeSplit };
}

/** A side_effect_retry fact: a double call to `tool` on one trace. */
function retryFact(traceId: string, taskKey: string, tool = 'charge-reversal'): DecisionFact {
  return {
    kind: 'side_effect_retry',
    traceId,
    observationIds: [`${traceId}-call-1`, `${traceId}-call-2`],
    agentId: undefined,
    taskKey,
    environment: ENV,
    outcome: 'failure',
    tools: [tool],
    cause: 'after-error',
    at: '2025-08-30T09:00:03.000Z',
  };
}

/** A model_usage fact for one trace (model + input price for ranking). */
function modelFact(traceId: string, taskKey: string, model: string, price: string): DecisionFact {
  return {
    kind: 'model_usage',
    traceId,
    observationIds: [`${traceId}-gen`],
    taskKey,
    environment: ENV,
    outcome: 'success',
    tools: [],
    model,
    modelInputPrice: price,
    at: '2025-08-30T09:00:03.000Z',
  };
}

describe('buildCandidates emission drop paths (DEC-24)', () => {
  it('per-kind floor: a synthetic group below the side-effect-retry floor (5) emits nothing and counts the drop', () => {
    // 3 double-call traces < floor 5 — the tr_refund_4 sub-floor shape
    const trees = ['tr_1', 'tr_2', 'tr_3'].map((id) => trace(id, 'a1', 'charge_task'));
    const groups = [group('charge_task', trees)];
    const facts = trees.map((t) => retryFact(t.traceId, 'charge_task'));

    const { proposals, dropped } = buildCandidates(
      facts, groups, [], [], DEFAULT_SCORING_CONSTANTS, CTX,
    );
    expect(proposals).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('minConsistency gate: one group agent absent from the evidence drops the candidate below 0.6', () => {
    // 5 double-call traces by a1 (floor pass) + 1 clean trace by a2 →
    // consistency = 1/2 = 0.5 < minConsistency 0.6 → drop (DEC-17 reading:
    // fraction of group agents exhibiting the pattern)
    const pattern = ['tr_1', 'tr_2', 'tr_3', 'tr_4', 'tr_5'].map((id) => trace(id, 'a1', 'charge_task'));
    const clean = trace('tr_6', 'a2', 'charge_task', 'success');
    const trees = [...pattern, clean];
    const groups = [group('charge_task', trees)];
    const facts = pattern.map((t) => retryFact(t.traceId, 'charge_task'));

    const { proposals, dropped } = buildCandidates(
      facts, groups, [], [], DEFAULT_SCORING_CONSTANTS, CTX,
    );
    expect(proposals).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('per-run breaker: three floor-passing groups with maxProposalsPerRun=2 keep the best two and drop one', () => {
    const makeTask = (taskKey: string, agent: string): { groups: DivergenceGroup[]; facts: DecisionFact[] } => {
      const ids = ['t1', 't2', 't3', 't4', 't5'].map((n) => `tr_${taskKey}_${n}`);
      const trees = ids.map((id) => trace(id, agent, taskKey));
      return { groups: [group(taskKey, trees)], facts: ids.map((id) => retryFact(id, taskKey)) };
    };
    const a = makeTask('task_a', 'agent-a');
    const b = makeTask('task_b', 'agent-b');
    const c = makeTask('task_c', 'agent-c');
    const groups = [...a.groups, ...b.groups, ...c.groups];
    const facts = [...a.facts, ...b.facts, ...c.facts];

    // 3 side-effect-retry candidates all at base confidence → the breaker cap
    // of 2 truncates the run (best-confidence first; ties break alphabetically)
    const { proposals, dropped } = buildCandidates(
      facts, groups, [], [], DEFAULT_SCORING_CONSTANTS, CTX, 2,
    );
    expect(proposals).toHaveLength(2);
    expect(dropped).toBe(1);
    const keys = proposals.map((p) => p.ruleKey).sort();
    expect(keys).toEqual([
      'side-effect-retry-task-a-charge-reversal',
      'side-effect-retry-task-b-charge-reversal',
    ]);

    // the same input with the default breaker (25) keeps all three
    const uncapped = buildCandidates(facts, groups, [], [], DEFAULT_SCORING_CONSTANTS, CTX);
    expect(uncapped.proposals).toHaveLength(3);
    expect(uncapped.dropped).toBe(0);
  });

  it('control: a floor-passing, consistent synthetic group emits one proposal', () => {
    const trees = ['tr_1', 'tr_2', 'tr_3', 'tr_4', 'tr_5', 'tr_6', 'tr_7'].map((id) =>
      trace(id, 'a1', 'charge_task'),
    );
    const groups = [group('charge_task', trees)];
    const facts = trees.map((t) => retryFact(t.traceId, 'charge_task'));

    const { proposals, dropped } = buildCandidates(
      facts, groups, [], [], DEFAULT_SCORING_CONSTANTS, CTX,
    );
    expect(dropped).toBe(0);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe('side-effect-retry');
    expect(proposals[0]!.ruleKey).toBe('side-effect-retry-charge-task-charge-reversal');
    expect(proposals[0]!.evidence).toHaveLength(7);
  });

  it('model-usage: a costlier model WITH a success gain over the cheaper one is not emitted (spec-level drop)', () => {
    // gpt-4o (costlier) 3/3 success vs gpt-4o-mini (cheap) 0/3 → costlier shows
    // a success gain → specModelUsage returns undefined → no candidate
    const costly = ['tr_c1', 'tr_c2', 'tr_c3'].map((id) => trace(id, 'agent-d', 'dispute_task', 'success'));
    const cheap = ['tr_m1', 'tr_m2', 'tr_m3'].map((id) => trace(id, 'agent-d', 'dispute_task', 'failure'));
    const trees = [...costly, ...cheap];
    const groups = [group('dispute_task', trees)];
    const facts = [
      ...costly.map((t) => modelFact(t.traceId, 'dispute_task', 'gpt-4o', '0.0025')),
      ...cheap.map((t) => modelFact(t.traceId, 'dispute_task', 'gpt-4o-mini', '0.00015')),
    ];

    const { proposals, dropped } = buildCandidates(
      facts, groups, [], [], DEFAULT_SCORING_CONSTANTS, CTX,
    );
    expect(proposals).toEqual([]);
    expect(dropped).toBe(0); // spec-level no-emit is not a counted drop
  });

  it('pending dedupe: an already-pending ruleKey is not re-proposed and is counted as a drop', () => {
    const trees = ['tr_1', 'tr_2', 'tr_3', 'tr_4', 'tr_5'].map((id) => trace(id, 'a1', 'charge_task'));
    const groups = [group('charge_task', trees)];
    const facts = trees.map((t) => retryFact(t.traceId, 'charge_task'));
    const existing = [
      {
        // minimal pending proposal sharing the candidate's ruleKey
        id: 'prop_pending',
        ruleKey: 'side-effect-retry-charge-task-charge-reversal',
        kind: 'side-effect-retry' as const,
        status: 'pending' as const,
        severity: 'advisory' as const,
        title: 'existing',
        ruleText: 'existing',
        assertion: 'existing',
        constraints: {},
        confidence: 0.45,
        coverage: {
          traces: 5, observations: 5, agents: 1, sessions: 5,
          window: { from: '2025-08-01T00:00:00.000Z', to: '2025-08-31T00:00:00.000Z' },
          environments: [ENV], consistency: 1,
        },
        evidence: [],
        conflictsWith: [],
        createdAt: CTX.at,
        updatedAt: CTX.at,
        origin: { runId: 'run_old', analyzerVersion: '0.1.0' },
      },
    ];

    const { proposals, dropped } = buildCandidates(
      facts, groups, existing, [], DEFAULT_SCORING_CONSTANTS, CTX,
    );
    expect(proposals).toEqual([]);
    expect(dropped).toBe(1); // analyze idempotency counts as a drop
  });
});
