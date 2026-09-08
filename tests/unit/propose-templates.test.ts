/**
 * Unit tests for propose/templates.ts — the test that protects [DEC-07]:
 * rule text is built from STRUCTURAL tokens only; a fixture io string
 * containing "password=…" must never appear in any template output, and the
 * refunds golden strings reproduce exactly.
 */

import { describe, expect, it } from 'vitest';
import { fillRuleText } from '../../src/propose/templates.js';
import type { DivergenceGroup } from '../../src/analyze/divergence.js';
import type { TraceTree } from '../../src/analyze/tree.js';

const GROUP: DivergenceGroup = {
  taskKey: 'refund_task',
  environment: 'production',
  trees: [] as TraceTree[],
  agents: new Set(['refund-agent']),
  outcomeSplit: { success: 1, failure: 0, unknown: 0 },
};

describe('fillRuleText (DEC-07 structural tokens only)', () => {
  it('never interpolates io content — a password=… fixture string stays absent', () => {
    const text = fillRuleText('tool-choice', GROUP, {
      taskKey: 'refund_task',
      tools: ['refund-standard', 'refund-quick'],
    });
    const joined = `${text.title}\n${text.ruleText}\n${text.assertion}`;
    expect(joined).not.toContain('password');
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('input');
    expect(joined).not.toContain('output');
    // the tool/task tokens that ARE structural do appear
    expect(joined).toContain('refund-standard');
    expect(joined).toContain('refund_task');
  });

  it('reproduces the pre-authored refunds golden strings exactly', () => {
    const toolChoice = fillRuleText('tool-choice', GROUP, {
      taskKey: 'refund_task',
      tools: ['refund-standard', 'refund-quick'],
    });
    expect(toolChoice.title).toBe('Standardise tool choice in "refund_task" on refund-standard');
    expect(toolChoice.ruleText).toBe(
      'In task "refund_task", AGENT runs should use TOOL "refund-standard" instead of TOOL "refund-quick".',
    );

    const retry = fillRuleText('side-effect-retry', { ...GROUP, taskKey: 'chargeback_task' }, {
      taskKey: 'chargeback_task',
      tools: ['charge-reversal'],
    });
    expect(retry.title).toBe('Never repeat side-effect TOOL "charge-reversal" in "chargeback_task"');
    expect(retry.ruleText).toContain('must not call the side-effect TOOL "charge-reversal" more than once');

    const usage = fillRuleText('model-usage', { ...GROUP, taskKey: 'dispute_task' }, {
      taskKey: 'dispute_task',
      model: 'gpt-4o-mini',
      alternativeModel: 'gpt-4o',
    });
    expect(usage.title).toBe('Prefer the cheaper model in "dispute_task"');
    expect(usage.ruleText).toContain('use model "gpt-4o-mini" instead of the costlier "gpt-4o"');
  });
});
