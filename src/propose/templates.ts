/**
 * propose/templates.ts — rule text builders. STRUCTURAL TOKENS ONLY
 * [DEC-07]: taskKey/tool/model names and counts are the only interpolated
 * content — arbitrary io content never reaches proposal text (the
 * redaction-golden test protects this). Text is deterministic per (kind,
 * group, opts) and matches the pre-authored golden proposal expectations.
 */

import type { RuleKind } from '../store/proposals.js';
import type { DivergenceGroup } from '../analyze/divergence.js';

export interface TemplateOpts {
  taskKey: string;
  tools?: string[];
  model?: string;
  alternativeModel?: string;
  attempts?: number;
}

export interface RuleText {
  title: string;
  ruleText: string;
  assertion: string;
}

function q(s: string): string {
  return `"${s}"`;
}

export function fillRuleText(kind: RuleKind, _g: DivergenceGroup, opts: TemplateOpts): RuleText {
  const task = opts.taskKey;
  switch (kind) {
    case 'tool-choice': {
      const standard = opts.tools?.[0] ?? '';
      const divergent = opts.tools?.[1];
      return {
        title: `Standardise tool choice in ${q(task)} on ${standard}`,
        ruleText: divergent
          ? `In task ${q(task)}, AGENT runs should use TOOL ${q(standard)} instead of TOOL ${q(divergent)}.`
          : `In task ${q(task)}, AGENT runs should use TOOL ${q(standard)} at the tool-choice decision point.`,
        assertion: `Every ${q(task)} AGENT run selects TOOL ${q(standard)} at the tool-choice decision point.`,
      };
    }
    case 'side-effect-retry': {
      const tool = opts.tools?.[0] ?? '';
      return {
        title: `Never repeat side-effect TOOL ${q(tool)} in ${q(task)}`,
        ruleText: `In task ${q(task)}, AGENT runs must not call the side-effect TOOL ${q(tool)} more than once (a retry after error or timeout re-executes the side effect).`,
        assertion: `${q(task)} AGENT runs call ${q(tool)} at most once.`,
      };
    }
    case 'model-usage': {
      const cheap = opts.model ?? '';
      const costly = opts.alternativeModel ?? '';
      return {
        title: `Prefer the cheaper model in ${q(task)}`,
        ruleText: `In task ${q(task)}, GENERATION runs should use model ${q(cheap)} instead of the costlier ${q(costly)} where outcomes do not improve.`,
        assertion: `${q(task)} GENERATION runs never use the costlier ${q(costly)} without a success gain over ${q(cheap)}.`,
      };
    }
    default:
      // retry-budget / failure-escalation are registered but never emitted in
      // v0.1 (CANDIDATE_KINDS_V01); keep the builder total.
      return {
        title: `${kind} rule for ${q(task)}`,
        ruleText: `${kind} policy for task ${q(task)}.`,
        assertion: `${q(task)} runs follow the ${kind} policy.`,
      };
  }
}

export function groupLabel(g: DivergenceGroup): string {
  return g.environment !== undefined ? `${g.taskKey} (${g.environment})` : g.taskKey;
}
