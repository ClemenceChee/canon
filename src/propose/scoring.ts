/**
 * propose/scoring.ts — deterministic confidence + coverage math (03
 * propose/scoring.ts). Formulas are deterministic (no LLM, DEC-7):
 *
 *   confidence = baseConfidenceByKind[kind]
 *                + perTraceBonus  * min(cap, max(0, |supporting| - floor))
 *                + perAgentBonus  * min(cap, max(0, agents - 1))
 *                + scoreCorroborationBonus (when a NUMERIC/BOOLEAN score
 *                  supports the pattern)
 *                clamped to [0, globalCap]; agents === 1 ⇒ capped at
 *                singleAgentCap (0.5).
 *
 * 03's signature computeConfidence(facts, coverage, constants) derives the
 * kind from DecisionFacts; here candidates know their kind explicitly (the
 * tool-choice pattern is computed over a divergence GROUP, not per-trace
 * facts), so the exported helper takes the kind + supporting-trace count —
 * additive deviation, same formula (see module header of candidates.ts).
 */

import type { RuleKind, Coverage } from '../store/proposals.js';
import type { DivergenceGroup } from '../analyze/divergence.js';
import type { ScoringConstants } from './scoring.constants.js';

export interface PatternTraces {
  /** traces that FOLLOW the pattern (supporting evidence) — traceId -> pattern observation ids. */
  supporting: Map<string, string[]>;
  /** traces on the divergent/alternative side (empty for single-sided patterns). */
  divergent?: Map<string, string[]>;
}

/**
 * Coverage of a candidate derived from a divergence group: trace/obs/session
 * counts and the window cover the pattern's EVIDENCE (supporting +
 * divergent); consistency (DEC-17) = fraction of the group's agents that
 * exhibit the pattern (agents present in the evidence / all group agents).
 */
export function candidateCoverage(
  g: DivergenceGroup,
  pattern: PatternTraces,
): Coverage {
  const evidence = new Map<string, string[]>([...pattern.supporting]);
  for (const [tid, ids] of pattern.divergent ?? []) {
    const existing = evidence.get(tid);
    evidence.set(tid, existing === undefined ? ids : [...existing, ...ids]);
  }
  const obsCount = new Set<string>();
  for (const ids of evidence.values()) for (const id of ids) obsCount.add(id);
  const sessions = new Set<string>();
  const envs = new Set<string>();
  const starts: string[] = [];
  const ends: string[] = [];
  const agentSet = new Set<string>();
  for (const tree of g.trees) {
    if (!evidence.has(tree.traceId)) continue;
    if (tree.agentId !== undefined) agentSet.add(tree.agentId);
    if (tree.sessionId !== undefined) sessions.add(tree.sessionId);
    if (tree.environment !== undefined) envs.add(tree.environment);
    if (tree.startTime !== undefined) starts.push(tree.startTime);
    if (tree.endTime !== undefined) ends.push(tree.endTime);
  }
  starts.sort();
  ends.sort();
  const groupAgents = g.agents.size;
  return {
    traces: evidence.size,
    observations: obsCount.size,
    agents: agentSet.size,
    sessions: sessions.size,
    window: { from: starts[0] ?? '', to: ends[ends.length - 1] ?? '' },
    environments: [...envs].sort(),
    consistency: groupAgents > 0 ? round4(agentSet.size / groupAgents) : 0,
  };
}

/**
 * Candidate confidence: base + per-supporting-trace bonus over the kind floor
 * + per-agent bonus + score corroboration; clamp [0, globalCap]; single-agent
 * proposals capped at singleAgentCap. Result rounded to 4 decimals so JSON
 * goldens are byte-stable across engines.
 */
export function candidateConfidence(
  kind: RuleKind,
  supportingCount: number,
  coverage: Coverage,
  corroborated: boolean,
  constants: ScoringConstants,
): number {
  const floor = constants.minTracesByKind[kind];
  let c = constants.baseConfidenceByKind[kind];
  c += Math.min(
    constants.perTraceBonusCap,
    constants.perTraceBonus * Math.max(0, supportingCount - floor),
  );
  c += Math.min(
    constants.perAgentBonusCap,
    constants.perAgentBonus * Math.max(0, coverage.agents - 1),
  );
  if (corroborated) c += constants.scoreCorroborationBonus;
  c = Math.max(0, Math.min(constants.globalCap, c));
  if (coverage.agents === 1) c = Math.min(constants.singleAgentCap, c);
  return round4(c);
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/**
 * A NUMERIC/BOOLEAN score attached to an evidence trace or one of its
 * observations supports the pattern when its polarity is negative — a
 * BOOLEAN false or a NUMERIC <= 0.5 marks the pattern as problematic (e.g.
 * tool-appropriateness=false on the divergent tool call, no-side-effect-
 * retry=false, dispute-outcome=0 / model-efficiency=0.4 on the costlier
 * model's trace).
 */
export function hasScoreCorroboration(
  g: DivergenceGroup,
  evidenceTraceIds: Iterable<string>,
): boolean {
  const evidence = new Set(evidenceTraceIds);
  const obsToTrace = new Map<string, string>();
  for (const tree of g.trees) {
    if (!evidence.has(tree.traceId)) continue;
    const collect = (node: { row: { id: string }; children: readonly unknown[] }): void => {
      obsToTrace.set(node.row.id, tree.traceId);
      for (const child of node.children as readonly { row: { id: string }; children: readonly unknown[] }[]) {
        collect(child);
      }
    };
    for (const root of tree.nodes) collect(root as never);
  }
  for (const tree of g.trees) {
    if (!evidence.has(tree.traceId)) continue;
    for (const score of tree.scores) {
      if (!negativePolarity(score)) continue;
      const subject = score.subject;
      if (subject === undefined) {
        if (score.traceId !== undefined && evidence.has(score.traceId)) return true;
        continue;
      }
      if (subject.kind === 'TRACE' && evidence.has(subject.id)) return true;
      if (subject.kind === 'OBSERVATION' && obsToTrace.has(subject.id)) return true;
    }
  }
  return false;
}

function negativePolarity(score: {
  dataType?: string;
  value?: unknown;
  subject?: { kind?: string; id?: string };
  traceId?: string;
}): boolean {
  if (score.dataType === 'BOOLEAN') return score.value === false;
  if (score.dataType === 'NUMERIC' && typeof score.value === 'number') {
    return score.value <= 0.5;
  }
  return false;
}
