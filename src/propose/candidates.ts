/**
 * propose/candidates.ts — facts → proposals (03 propose/candidates.ts).
 *
 * PINNED EMISSION SEMANTICS (implementation reading of DEC-17, mirroring the
 * pre-authored golden proposals expected/refunds/proposals.json):
 *
 * - A candidate may be emitted from a taskKey+environment group g only when
 *   the number of group traces exhibiting the kind's pattern (its supporting
 *   evidence) reaches the kind floor (minTracesByKind) AND the consistency
 *   gate passes: agents represented in the evidence / all group agents
 *   >= minConsistency (0.6, DEC-17).
 * - tool-choice (DEC-16 divergence, computed over the group's trees): an
 *   agent's preferred tool = argmax over tools of (its traces using the tool
 *   minus the max other-agent usage of it), ties broken alphabetically; the
 *   STANDARD tool is the preferred tool with the most group-wide usage;
 *   traces choosing the standard tool are supporting evidence, traces of an
 *   agent preferring a different tool are divergent evidence.
 * - side-effect-retry: side_effect_retry facts per group+tool; supporting =
 *   the double-call traces; the retry cause is recorded but counts toward the
 *   kind regardless (DEC-17).
 * - model-usage: model_usage facts per group; the costlier model family (by
 *   per-token input price) must show NO success gain over the cheaper
 *   families (costlier success rate <= cheaper rate) to emit; costlier traces
 *   are supporting, cheaper traces divergent.
 *
 * Candidate dedupe by ruleKey (best confidence first); per-run circuit
 * breaker (maxProposalsPerRun); dropped-candidate counts are returned for the
 * audit payload (03: "dropped candidates counted into audit payload").
 * retry-budget / failure-escalation are registered kinds but never emitted in
 * v0.1 (CANDIDATE_KINDS_V01).
 */

import type {
  Coverage,
  EvidenceLink,
  GuardConstraints,
  Proposal,
  RuleKind,
} from '../store/proposals.js';
import type { DecisionFact } from '../analyze/decisions.js';
import type { DivergenceGroup } from '../analyze/divergence.js';
import type { ObservationNode, TraceTree } from '../analyze/tree.js';
import type { IsoTime } from '../core/time.js';
import { newId, ruleKeyFrom } from '../core/id.js';
import { DEFAULT_SETTINGS } from '../core/constants.js';
import { fillRuleText } from './templates.js';
import {
  candidateConfidence,
  candidateCoverage,
  hasScoreCorroboration,
} from './scoring.js';
import type { ScoringConstants } from './scoring.constants.js';
import { checkContradictions, hasPendingProposal } from './contradictions.js';
import type { Policy } from '../store/policies.js';

export interface CandidateRunContext {
  runId: string;
  analyzerVersion: string;
  at: IsoTime;
}

interface Spec {
  g: DivergenceGroup;
  kind: RuleKind;
  ruleKey: string;
  supporting: Map<string, string[]>;
  divergent?: Map<string, string[]>;
  constraints: GuardConstraints;
  /** structural tokens for the rule text (DEC-07): tools / models only. */
  tools?: string[];
  model?: string;
  alternativeModel?: string;
}

export interface CandidateResult {
  proposals: Proposal[];
  /** candidates dropped by the floor/consistency/circuit-breaker gates. */
  dropped: number;
}

/** All AGENT/CHAIN nodes of a tree (a run's own tool calls are its children). */
function agentRuns(tree: TraceTree): ObservationNode[] {
  const out: ObservationNode[] = [];
  const walk = (node: ObservationNode): void => {
    if (node.row.type === 'AGENT' || node.row.type === 'CHAIN') out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of tree.nodes) walk(root);
  return out;
}

/** Tool-name → observation ids of the direct TOOL children of every run (call-time order). */
function traceToolUsage(tree: TraceTree): Map<string, string[]> {
  const byTool = new Map<string, { id: string; startTime?: string }[]>();
  for (const run of agentRuns(tree)) {
    for (const child of run.children) {
      if (child.row.type !== 'TOOL' || child.row.name === undefined || child.row.name.length === 0) {
        continue;
      }
      const list = byTool.get(child.row.name) ?? [];
      list.push({ id: child.row.id, startTime: child.row.startTime });
      byTool.set(child.row.name, list);
    }
  }
  const out = new Map<string, string[]>();
  for (const [tool, calls] of byTool) {
    calls.sort((a, b) => {
      const at = a.startTime ?? '';
      const bt = b.startTime ?? '';
      if (at < bt) return -1;
      if (at > bt) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    out.set(tool, calls.map((c) => c.id));
  }
  return out;
}

// --------------------------------------------------------------------------
// tool-choice divergence
// --------------------------------------------------------------------------
function preferredToolPerAgent(
  g: DivergenceGroup,
  usage: Map<string, Map<string, string[]>>,
): Map<string, string> {
  const agentTraces = new Map<string, string[]>();
  for (const tree of g.trees) {
    if (tree.agentId === undefined) continue;
    const list = agentTraces.get(tree.agentId) ?? [];
    list.push(tree.traceId);
    agentTraces.set(tree.agentId, list);
  }
  const counts = new Map<string, Map<string, number>>();
  for (const [agent, traces] of agentTraces) {
    const perTool = new Map<string, number>();
    for (const tid of traces) {
      for (const tool of usage.get(tid)?.keys() ?? []) {
        perTool.set(tool, (perTool.get(tool) ?? 0) + 1);
      }
    }
    counts.set(agent, perTool);
  }
  const preferred = new Map<string, string>();
  for (const [agent, perTool] of counts) {
    let best: { score: number; tool: string } | undefined;
    for (const [tool, count] of perTool) {
      let maxOther = 0;
      for (const [other, otherPerTool] of counts) {
        if (other === agent) continue;
        maxOther = Math.max(maxOther, otherPerTool.get(tool) ?? 0);
      }
      const score = count - maxOther;
      if (best === undefined || score > best.score || (score === best.score && tool < best.tool)) {
        best = { score, tool };
      }
    }
    if (best !== undefined) preferred.set(agent, best.tool);
  }
  return preferred;
}

function specToolChoice(g: DivergenceGroup, usage: Map<string, Map<string, string[]>>): Spec | undefined {
  const preferred = preferredToolPerAgent(g, usage);
  if (preferred.size < 2) return undefined;
  const distinctTools = new Set(preferred.values());
  if (distinctTools.size < 2) return undefined;

  const groupUsage = new Map<string, number>();
  for (const tree of g.trees) {
    for (const tool of usage.get(tree.traceId)?.keys() ?? []) {
      groupUsage.set(tool, (groupUsage.get(tool) ?? 0) + 1);
    }
  }
  const standard = [...distinctTools].sort((a, b) => {
    const da = groupUsage.get(a) ?? 0;
    const db = groupUsage.get(b) ?? 0;
    return db !== da ? db - da : a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
  const divergentTools = [...distinctTools].filter((t) => t !== standard).sort();

  const supporting = new Map<string, string[]>();
  const divergent = new Map<string, string[]>();
  for (const tree of g.trees) {
    const tools = usage.get(tree.traceId);
    const standardIds = tools?.get(standard);
    if (standardIds !== undefined && standardIds.length > 0) {
      supporting.set(tree.traceId, standardIds);
      continue;
    }
    const pref = tree.agentId !== undefined ? preferred.get(tree.agentId) : undefined;
    if (pref === undefined || !divergentTools.includes(pref)) continue;
    const ids = tools?.get(pref);
    if (ids !== undefined && ids.length > 0) divergent.set(tree.traceId, ids);
  }
  if (divergent.size === 0) return undefined;
  return {
    g,
    kind: 'tool-choice',
    ruleKey: ruleKeyFor('tool-choice', standard, g.taskKey),
    supporting,
    divergent,
    constraints: { tool: standard, taskKeys: [g.taskKey] },
    tools: [standard, divergentTools[0]!],
  };
}

// --------------------------------------------------------------------------
// side-effect retry — from side_effect_retry facts per group + tool
// --------------------------------------------------------------------------
function specSideEffectRetry(g: DivergenceGroup, facts: DecisionFact[]): Spec | undefined {
  const perTool = new Map<string, Map<string, string[]>>();
  for (const fact of facts) {
    if (fact.kind !== 'side_effect_retry') continue;
    if (fact.taskKey !== g.taskKey || (fact.environment ?? '') !== (g.environment ?? '')) continue;
    const tool = fact.tools[0];
    if (tool === undefined) continue;
    const byTrace = perTool.get(tool) ?? new Map<string, string[]>();
    byTrace.set(fact.traceId, fact.observationIds);
    perTool.set(tool, byTrace);
  }
  let best: { tool: string; supporting: Map<string, string[]> } | undefined;
  for (const [tool, supporting] of perTool) {
    if (best === undefined || supporting.size > best.supporting.size) best = { tool, supporting };
  }
  if (best === undefined) return undefined;
  return {
    g,
    kind: 'side-effect-retry',
    ruleKey: ruleKeyFor('side-effect-retry', best.tool, g.taskKey),
    supporting: best.supporting,
    constraints: { tool: best.tool, sideEffect: true, taskKeys: [g.taskKey], maxAttempts: 1 },
    tools: [best.tool],
  };
}

// --------------------------------------------------------------------------
// model usage — costlier family shows no success gain (from model facts)
// --------------------------------------------------------------------------
function specModelUsage(g: DivergenceGroup, facts: DecisionFact[]): Spec | undefined {
  const byModel = new Map<string, DecisionFact[]>();
  for (const fact of facts) {
    if (fact.kind !== 'model_usage') continue;
    if (fact.taskKey !== g.taskKey || (fact.environment ?? '') !== (g.environment ?? '')) continue;
    if (fact.model === undefined) continue;
    const list = byModel.get(fact.model) ?? [];
    list.push(fact);
    byModel.set(fact.model, list);
  }
  if (byModel.size < 2) return undefined;
  const inputPrice = (m: string): number => {
    const v = byModel.get(m)?.[0]?.modelInputPrice;
    const parsed = v === undefined ? Number.NaN : Number.parseFloat(v);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const costly = [...byModel.keys()].sort((a, b) => {
    const da = inputPrice(a);
    const db = inputPrice(b);
    return db !== da ? db - da : a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
  const cheapModels = [...byModel.keys()].filter((m) => m !== costly).sort((a, b) => {
    const da = inputPrice(a);
    const db = inputPrice(b);
    return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0;
  });
  if (cheapModels.length === 0) return undefined;

  const supporting = new Map<string, string[]>();
  const divergent = new Map<string, string[]>();
  for (const fact of byModel.get(costly) ?? []) supporting.set(fact.traceId, fact.observationIds);
  for (const model of cheapModels) {
    for (const fact of byModel.get(model) ?? []) divergent.set(fact.traceId, fact.observationIds);
  }
  if (supporting.size === 0 || divergent.size === 0) return undefined;

  const successRate = (traceIds: Iterable<string>): number => {
    let ok = 0;
    let total = 0;
    for (const tid of traceIds) {
      const tree = g.trees.find((t) => t.traceId === tid);
      if (tree === undefined) continue;
      total += 1;
      if (tree.outcome === 'success') ok += 1;
    }
    return total === 0 ? 0 : ok / total;
  };
  if (successRate(supporting.keys()) > successRate(divergent.keys())) return undefined;

  return {
    g,
    kind: 'model-usage',
    ruleKey: ruleKeyFor('model-usage', undefined, g.taskKey),
    supporting,
    divergent,
    constraints: { modelFamily: [cheapModels[0]!], taskKeys: [g.taskKey] },
    model: cheapModels[0]!,
    alternativeModel: costly,
  };
}

// --------------------------------------------------------------------------
// finalisation
// --------------------------------------------------------------------------
/**
 * Stable rule key (03: "kebab of stable parts (kind + tool/task tokens)").
 * Routes EVERY proposal rule key through core/id.ts ruleKeyFrom (ADR-0004
 * DEC-21): tool-bound kinds (tool-choice, side-effect-retry) key on
 * kind + taskKey + tool; the model-usage kind (no tool) keys on kind + taskKey.
 * Including the taskKey means distinct tasks sharing a tool never collide at
 * dedupe/pending-suppression, and policy filenames derive from the normalised
 * (lowercase, kebab, path-safe) key — raw tool/task tokens never reach a
 * filename unnormalised (review S2).
 */
export function ruleKeyFor(kind: RuleKind, tool: string | undefined, taskKey: string): string {
  return ruleKeyFrom(tool !== undefined && tool.length > 0 ? [kind, taskKey, tool] : [kind, taskKey]);
}

function finalizeSpec(
  spec: Spec,
  ctx: CandidateRunContext,
  constants: ScoringConstants,
  existing: Proposal[],
  policies: Policy[],
): Proposal | undefined {
  const floor = constants.minTracesByKind[spec.kind];
  if (spec.supporting.size < floor) return undefined; // kind floor (DEC-17)
  const coverage = candidateCoverage(spec.g, spec);
  if (coverage.consistency < constants.minConsistency) return undefined; // DEC-17 gate
  const evidenceTraceIds = [...spec.supporting.keys(), ...(spec.divergent?.keys() ?? [])];
  const corroborated = hasScoreCorroboration(spec.g, evidenceTraceIds);
  const confidence = candidateConfidence(
    spec.kind,
    spec.supporting.size,
    coverage,
    corroborated,
    constants,
  );
  const text = fillRuleText(spec.kind, spec.g, {
    taskKey: spec.g.taskKey,
    ...(spec.tools !== undefined ? { tools: spec.tools } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.alternativeModel !== undefined ? { alternativeModel: spec.alternativeModel } : {}),
  });
  const at = ctx.at;
  return {
    id: newId('prop'),
    ruleKey: spec.ruleKey,
    kind: spec.kind,
    status: 'pending',
    severity: 'advisory',
    title: text.title,
    ruleText: text.ruleText,
    assertion: text.assertion,
    constraints: spec.constraints,
    confidence,
    coverage,
    evidence: buildEvidenceLinks(spec.supporting, spec.divergent),
    conflictsWith: checkContradictions({ ruleKey: spec.ruleKey, kind: spec.kind }, existing, policies),
    createdAt: at,
    updatedAt: at,
    origin: { runId: ctx.runId, analyzerVersion: ctx.analyzerVersion },
  };
}

function buildEvidenceLinks(
  supporting: Map<string, string[]>,
  divergent: Map<string, string[]> | undefined,
): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  const sources: Array<{ role: 'supporting' | 'divergent'; map: Map<string, string[]> }> = [
    { role: 'supporting', map: supporting },
    { role: 'divergent', map: divergent ?? new Map<string, string[]>() },
  ];
  for (const { role, map } of sources) {
    for (const traceId of [...map.keys()].sort()) {
      links.push({ role, traceId, observationIds: map.get(traceId) ?? [] });
    }
  }
  return links;
}

/**
 * Build the proposals for one analyze run over the analysis facts + groups.
 * Groups below the app-level group floor (settings.analysis.minTraces) never
 * reach emission (03 app-level filter).
 *
 * @param maxProposalsPerRun per-run circuit breaker (best confidence first;
 *   ADR-0004 DEC-20: `settings.analysis.maxProposalsPerRun` is the live knob —
 *   a human veto in config must take effect, no hard-coded second home). When
 *   omitted (library callers) the [PROPOSED] default (25) applies.
 */
export function buildCandidates(
  facts: DecisionFact[],
  groups: DivergenceGroup[],
  existing: Proposal[],
  policies: Policy[],
  constants: ScoringConstants,
  ctx: CandidateRunContext,
  maxProposalsPerRun: number = DEFAULT_SETTINGS.analysis.maxProposalsPerRun,
): CandidateResult {
  const specs: Spec[] = [];
  for (const g of groups) {
    const usage = new Map<string, Map<string, string[]>>();
    for (const tree of g.trees) usage.set(tree.traceId, traceToolUsage(tree));
    const toolChoice = specToolChoice(g, usage);
    if (toolChoice !== undefined) specs.push(toolChoice);
    const retry = specSideEffectRetry(g, facts);
    if (retry !== undefined) specs.push(retry);
    const usageModel = specModelUsage(g, facts);
    if (usageModel !== undefined) specs.push(usageModel);
  }

  let dropped = 0;
  const finalized: Proposal[] = [];
  for (const spec of specs) {
    if (hasPendingProposal(spec.ruleKey, existing)) {
      // analyze idempotency: a ruleKey already pending in the queue is not
      // re-proposed (counted as a drop for the audit payload)
      dropped += 1;
      continue;
    }
    const proposal = finalizeSpec(spec, ctx, constants, existing, policies);
    if (proposal === undefined) dropped += 1;
    else finalized.push(proposal);
  }

  // dedupe by ruleKey keeping the best confidence; per-run circuit breaker
  // (DEC-20: the breaker cap is settings.analysis.maxProposalsPerRun, plumbed
  // from config by the app layer — a human veto must not be inert)
  const byRuleKey = new Map<string, Proposal>();
  finalized.sort((a, b) => b.confidence - a.confidence || (a.ruleKey < b.ruleKey ? -1 : 1));
  let kept = 0;
  for (const proposal of finalized) {
    if (kept >= maxProposalsPerRun || byRuleKey.has(proposal.ruleKey)) {
      dropped += 1;
      continue;
    }
    byRuleKey.set(proposal.ruleKey, proposal);
    kept += 1;
  }
  const proposals = [...byRuleKey.values()].sort((a, b) =>
    a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0,
  );
  return { proposals, dropped };
}

export type { Coverage };
