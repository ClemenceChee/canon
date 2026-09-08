/**
 * propose/kinds.ts — RuleKind registry (03 propose/kinds.ts): label +
 * fact→rule mapping + suggested severity. Labels and mapping only — ALL
 * numeric floors/bonuses live in ScoringConstants (scoring.constants.ts);
 * suggested severity is 'advisory' for every kind (mandatory is a HUMAN
 * decision at promote via --set severity=mandatory — ADR-0001 DEC-5).
 *
 * v0.1 candidate kinds (DEC-17): tool-choice | side-effect-retry |
 * model-usage. retry-budget and failure-escalation keep their registry
 * entries (RuleKind is a shared type) but are never EMITTED in v0.1.
 */

import type { RuleKind } from '../store/proposals.js';

export interface KindMeta {
  label: string;
  /** which decision facts generalise into this rule kind (03 kinds.ts). */
  factMapping: string[];
  suggestedSeverity: 'advisory';
}

const REGISTRY: Record<RuleKind, KindMeta> = {
  'tool-choice': {
    label: 'tool choice divergence',
    factMapping: ['tool_choice'],
    suggestedSeverity: 'advisory',
  },
  'side-effect-retry': {
    label: 'side-effect retry',
    factMapping: ['side_effect_retry'],
    suggestedSeverity: 'advisory',
  },
  'retry-budget': {
    label: 'retry budget',
    factMapping: ['retry_budget'],
    suggestedSeverity: 'advisory',
  },
  'failure-escalation': {
    label: 'failure escalation',
    factMapping: ['failure'],
    suggestedSeverity: 'advisory',
  },
  'model-usage': {
    label: 'model usage',
    factMapping: ['model_usage'],
    suggestedSeverity: 'advisory',
  },
};

/** Candidate kinds v0.1 emits (DEC-17). */
export const CANDIDATE_KINDS_V01: readonly RuleKind[] = Object.freeze([
  'tool-choice',
  'side-effect-retry',
  'model-usage',
]);

export function kindMeta(kind: RuleKind): KindMeta {
  return REGISTRY[kind];
}
