/**
 * propose/scoring.constants.ts — the single home for every [PROPOSED] scoring
 * number (03 scoring.constants.ts; "DEFAULT_SCORING_CONSTANTS ... is the only
 * constants export the rest of the code reads"). The DEC-17 emission FLOORS,
 * minConsistency and caps live in src/core/constants.ts (ADR-0003 DEC-17:
 * "constants in src/core/constants.ts") and are IMPORTED here, not
 * duplicated. Human veto = edit core/constants.ts.
 */

import type { RuleKind } from '../store/proposals.js';
import {
  PROPOSAL_GLOBAL_CONFIDENCE_CAP,
  PROPOSAL_MIN_CONSISTENCY,
  PROPOSAL_MIN_TRACES_MODEL_USAGE,
  PROPOSAL_MIN_TRACES_SIDE_EFFECT_RETRY,
  PROPOSAL_MIN_TRACES_TOOL_CHOICE,
  PROPOSAL_SINGLE_AGENT_CONFIDENCE_CAP,
} from '../core/constants.js';

export interface ScoringConstants {
  /** kind emission floors — number of pattern-supporting traces per taskKey group. */
  minTracesByKind: Record<RuleKind, number>;
  /** base confidence per kind (added before bonuses). */
  baseConfidenceByKind: Record<RuleKind, number>;
  /** +0.05 per supporting trace over the kind minimum (cap +0.2). */
  perTraceBonus: number;
  perTraceBonusCap: number;
  /** +0.10 per additional distinct agent over 1 (cap +0.3). */
  perAgentBonus: number;
  perAgentBonusCap: number;
  /** +0.05 when >=1 NUMERIC/BOOLEAN score supports the pattern. */
  scoreCorroborationBonus: number;
  /** share of group agents exhibiting the pattern; below it ⇒ drop (DEC-17). */
  minConsistency: number;
  /** single-agent proposals never score above this (SOMA-style caution). */
  singleAgentCap: number;
  /** absolute confidence ceiling. */
  globalCap: number;
}

/**
 * [PROPOSED] human veto list (03-program-design:421-424 + ADR-0003 DEC-17).
 * retry-budget / failure-escalation keep 03's proposed floors but are never
 * emitted in v0.1 (CANDIDATE_KINDS_V01).
 */
export const DEFAULT_SCORING_CONSTANTS: ScoringConstants = Object.freeze({
  minTracesByKind: Object.freeze({
    'tool-choice': PROPOSAL_MIN_TRACES_TOOL_CHOICE,
    'side-effect-retry': PROPOSAL_MIN_TRACES_SIDE_EFFECT_RETRY,
    'retry-budget': 4, // 03 veto list; never emitted in v0.1
    'failure-escalation': 8, // 03 veto list; never emitted in v0.1
    'model-usage': PROPOSAL_MIN_TRACES_MODEL_USAGE,
  }),
  baseConfidenceByKind: Object.freeze({
    'tool-choice': 0.4,
    'side-effect-retry': 0.45,
    'retry-budget': 0.5,
    'failure-escalation': 0.3,
    'model-usage': 0.35,
  }),
  perTraceBonus: 0.05,
  perTraceBonusCap: 0.2,
  perAgentBonus: 0.1,
  perAgentBonusCap: 0.3,
  scoreCorroborationBonus: 0.05,
  minConsistency: PROPOSAL_MIN_CONSISTENCY,
  singleAgentCap: PROPOSAL_SINGLE_AGENT_CONFIDENCE_CAP,
  globalCap: PROPOSAL_GLOBAL_CONFIDENCE_CAP,
});
