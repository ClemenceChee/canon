/**
 * Unit tests for analyze/decisions.ts — each DecisionFact kind on a
 * purpose-built fixture (03 testing plan): retries with cause
 * (after-error | after-timeout | after-unknown), the side-effect tool
 * classification (DEC-17), failures, and model usage.
 */

import { describe, expect, it } from 'vitest';
import { rebuildTrees } from '../../src/analyze/tree.js';
import { extractDecisions } from '../../src/analyze/decisions.js';
import type { DecisionFact } from '../../src/analyze/decisions.js';
import type { LfObservationRow } from '../../src/trace/types.js';

const PROJECT = 'prj-x';
const TASK = 'payments_task';

function obs(id: string, type: string, name: string | undefined, partial: Partial<LfObservationRow> = {}): LfObservationRow {
  return {
    id,
    traceId: 'tr_1',
    projectId: PROJECT,
    type: type as LfObservationRow['type'],
    ...(name !== undefined ? { name } : {}),
    level: 'INFO',
    environment: 'production',
    isRootObservation: false,
    parentObservationId: null,
    startTime: '2025-01-01T00:00:00.000Z',
    endTime: '2025-01-01T00:00:01.000Z',
    traceName: TASK,
    statusMessage: '',
    ...partial,
  };
}

function agentAt(start: string, id = 'tr_1'): LfObservationRow {
  return obs('agent_1', 'AGENT', 'pay-agent', {
    traceId: id,
    isRootObservation: true,
    parentObservationId: null,
    startTime: start,
    endTime: start,
  });
}

function factsOf(rows: LfObservationRow[]): DecisionFact[] {
  const { trees } = rebuildTrees(rows, []);
  expect(trees).toHaveLength(1);
  return extractDecisions(trees[0]!);
}

const T0 = '2025-01-01T00:00:00.000Z';

describe('extractDecisions retries', () => {
  it('side_effect_retry with cause after-error when the first call errored', () => {
    const rows = [
      agentAt(T0),
      obs('tool_a1', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', level: 'ERROR', statusMessage: 'bank rejected reversal', startTime: '2025-01-01T00:00:05.000Z' }),
      obs('tool_a2', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:00:10.000Z' }),
    ];
    const facts = factsOf(rows);
    const retry = facts.find((f) => f.kind === 'side_effect_retry')!;
    expect(retry).toMatchObject({
      kind: 'side_effect_retry',
      tools: ['charge-reversal'],
      cause: 'after-error',
      attempts: 2,
      observationIds: ['tool_a1', 'tool_a2'],
    });
  });

  it('side_effect_retry with cause after-timeout when a timeout witness sits between the calls', () => {
    const rows = [
      agentAt(T0),
      obs('tool_a1', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:00:05.000Z' }),
      obs('span_to', 'SPAN', 'gateway-timeout', { parentObservationId: 'agent_1', level: 'WARN', statusMessage: 'charge gateway timeout', startTime: '2025-01-01T00:00:06.000Z' }),
      obs('tool_a2', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:00:12.000Z' }),
    ];
    const retry = factsOf(rows).find((f) => f.kind === 'side_effect_retry')!;
    expect(retry.cause).toBe('after-timeout');
  });

  it('side_effect_retry with cause after-unknown when no error/timeout signal exists', () => {
    const rows = [
      agentAt(T0),
      obs('tool_a1', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:00:05.000Z' }),
      obs('tool_a2', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:00:09.000Z' }),
    ];
    const retry = factsOf(rows).find((f) => f.kind === 'side_effect_retry')!;
    expect(retry.cause).toBe('after-unknown');
  });

  it('a repeat of a benign tool is a retry_budget fact (never side-effect-retry)', () => {
    const rows = [
      agentAt(T0),
      obs('tool_a1', 'TOOL', 'lookup-customer', { parentObservationId: 'agent_1', level: 'ERROR', statusMessage: 'boom', startTime: '2025-01-01T00:00:05.000Z' }),
      obs('tool_a2', 'TOOL', 'lookup-customer', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:00:08.000Z' }),
    ];
    const retry = factsOf(rows).find((f) => f.kind === 'retry_budget')!;
    expect(retry).toMatchObject({ kind: 'retry_budget', tools: ['lookup-customer'], cause: 'after-error' });
  });

  it('repeated calls further apart than the retry window are separate calls (no fact)', () => {
    const rows = [
      agentAt(T0),
      obs('tool_a1', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:00:00.000Z' }),
      obs('tool_a2', 'TOOL', 'charge-reversal', { parentObservationId: 'agent_1', startTime: '2025-01-01T00:30:00.000Z' }),
    ];
    expect(factsOf(rows).some((f) => f.kind === 'side_effect_retry')).toBe(false);
  });
});

describe('extractDecisions failures and model usage', () => {
  it('emits a failure fact per failing row (ERROR level or AGENT/TOOL/CHAIN statusMessage)', () => {
    const rows = [
      agentAt(T0),
      obs('tool_err', 'TOOL', 'charge-lookup', { parentObservationId: 'agent_1', level: 'ERROR', statusMessage: 'down', startTime: '2025-01-01T00:00:05.000Z' }),
      obs('tool_warn', 'TOOL', 'dispute-check', { parentObservationId: 'agent_1', level: 'WARN', statusMessage: 'evidence insufficient', startTime: '2025-01-01T00:00:06.000Z' }),
    ];
    const failures = factsOf(rows).filter((f) => f.kind === 'failure');
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.tools[0]).sort()).toEqual(['charge-lookup', 'dispute-check']);
  });

  it('emits one model_usage fact per model with price carry fields', () => {
    const rows = [
      agentAt(T0),
      obs('gen_1', 'GENERATION', 'summary', {
        parentObservationId: 'agent_1',
        model: 'gpt-4o',
        inputPrice: '0.002500',
        outputPrice: '0.010000',
        startTime: '2025-01-01T00:00:05.000Z',
      }),
      obs('gen_2', 'GENERATION', 'notes', {
        parentObservationId: 'agent_1',
        model: 'gpt-4o',
        inputPrice: '0.002500',
        outputPrice: '0.010000',
        startTime: '2025-01-01T00:00:06.000Z',
      }),
    ];
    const usage = factsOf(rows).filter((f) => f.kind === 'model_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: 'gpt-4o',
      modelInputPrice: '0.002500',
      modelOutputPrice: '0.010000',
      observationIds: ['gen_1', 'gen_2'],
    });
  });
});
