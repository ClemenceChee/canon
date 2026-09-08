import { describe, expect, it } from 'vitest';
import { newId, ruleKeyFrom } from '../../src/core/id.js';

describe('id [DEC-01]', () => {
  it('newId produces `<kind>_` + 8 hex chars', () => {
    for (const kind of ['prop', 'pol', 'run', 'evt'] as const) {
      const id = newId(kind);
      expect(id).toMatch(new RegExp(`^${kind}_[0-9a-f]{8}$`));
    }
  });

  it('ids are unique across calls and distinct per kind prefix', () => {
    const a = newId('prop');
    const b = newId('prop');
    const c = newId('run');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^prop_/);
    expect(c).toMatch(/^run_/);
  });
});

describe('ruleKeyFrom [DEC-21] (03 core/id.ts contract)', () => {
  it('joins kebab-case, lowercase parts from mixed-case tokens', () => {
    expect(ruleKeyFrom(['side-effect-retry', 'charge-reversal'])).toBe(
      'side-effect-retry-charge-reversal',
    );
    expect(ruleKeyFrom(['MODEL-usage', 'Dispute Task'])).toBe('model-usage-dispute-task');
  });

  it('normalises raw tool/task tokens so they are path-safe (spaces/caps/underscores/slashes)', () => {
    expect(ruleKeyFrom(['tool-choice', 'refund_task', 'Refund_Standard Tool'])).toBe(
      'tool-choice-refund-task-refund-standard-tool',
    );
    // a slash in a raw token must never reach a policy filename unnormalised
    expect(ruleKeyFrom(['tool-choice', 'refund/quick'])).toBe('tool-choice-refund-quick');
  });

  it('drops undefined and empty parts', () => {
    expect(ruleKeyFrom(['model-usage', undefined, 'dispute_task'])).toBe(
      'model-usage-dispute-task',
    );
    expect(ruleKeyFrom([undefined, ''])).toBe('');
  });

  it('dedupes identical normalised parts (first occurrence kept)', () => {
    expect(ruleKeyFrom(['tool-choice', 'refund-standard', 'refund-standard'])).toBe(
      'tool-choice-refund-standard',
    );
    expect(ruleKeyFrom(['side-effect-retry', 'charge-reversal', 'charge-reversal'])).toBe(
      'side-effect-retry-charge-reversal',
    );
  });

  it('keeps distinct tool/task tokens lossless — identity is never merged away', () => {
    // taskKey "refund_task" + tool "refund-standard" share the "refund" token;
    // both must survive (a token-level dedupe would destroy the tool identity)
    expect(ruleKeyFrom(['tool-choice', 'refund_task', 'refund-standard'])).toBe(
      'tool-choice-refund-task-refund-standard',
    );
  });

  it('task-scoped tool keys never collide across tasks (DEC-21)', () => {
    const taskA = ruleKeyFrom(['side-effect-retry', 'chargeback_task', 'charge-reversal']);
    const taskB = ruleKeyFrom(['side-effect-retry', 'dispute_task', 'charge-reversal']);
    expect(taskA).not.toBe(taskB);
    expect(taskA).toBe('side-effect-retry-chargeback-task-charge-reversal');
    expect(taskB).toBe('side-effect-retry-dispute-task-charge-reversal');
  });

  it('is stable/deterministic and matches the safe charset', () => {
    const a = ruleKeyFrom(['tool-choice', 'refund_task', 'refund-standard']);
    const b = ruleKeyFrom(['tool-choice', 'refund_task', 'refund-standard']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
