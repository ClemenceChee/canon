/**
 * export/dashboard.ts — the canon → dashboard governance export (the
 * integration seam with ClemenceChee/langfuse-cost-governance).
 *
 * `canon export --format json` emits ONE self-contained, versioned document
 * per project that the dashboard ingests into its warehouse:
 *
 *   - metrics   — TTRP, precision14 and proposal queue counts (reusing
 *                 metrics/metrics.ts so the dashboard sees the same reading
 *                 points as `canon metrics`).
 *   - policies  — the effective canon (latest version per ruleKey), mapped to
 *                 the dashboard contract: ruleKey, kind, status 'ratified',
 *                 confidence, promotedAt, operator, evidenceTraces (distinct
 *                 evidence trace ids — provenance only, never raw io).
 *   - divergence — decision-divergence aggregates at model × task-key
 *                 granularity (PRD resolved default #3).
 *
 * CONTRACT DECISIONS (recorded in ADR-0007):
 *   - `version: 1` is the export schema generation (not the tool version).
 *   - `project.name` is `null`: canon v0.1 persists only the project id
 *     (connect stores projectId; the name is not kept in config). The
 *     dashboard displays the id when name is null.
 *   - policy `status` is the constant 'ratified' — the effective canon only
 *     contains ratified (active) policies.
 *   - divergence metric = canon's own tool-choice divergence (the same
 *     cross-agent "preferred tool vs group standard" signal the proposal
 *     engine uses in propose/candidates.ts), attributed per trace to its
 *     GENERATION models and aggregated as model × task-key cells. A trace
 *     whose agent prefers a non-standard tool is "divergent"; every other
 *     trace is counted as total only. Groups with fewer than two distinct
 *     preferred tools (no cross-agent divergence) contribute zero divergent
 *     traces. Traces without a taskKey or a model are excluded from cells.
 *
 * Privacy: metadata/provenance only — no input/output/metadata ever enters
 * this surface (mirroring the guard-rules pack and the proposals-view
 * convention; ADR-0001 DEC-4 redaction-on-by-default is trivially satisfied).
 */

import type { IsoTime } from '../core/time.js';
import type { MetricsResult } from '../metrics/metrics.js';
import type { Policy } from '../store/policies.js';
import type { ObservationNode, TraceTree } from '../analyze/tree.js';
import { divergenceGroups } from '../analyze/divergence.js';
import { kindOfRuleKey } from './guardRules.js';

/** Export schema generation (not the tool version). */
export const GOVERNANCE_EXPORT_VERSION = 1;

export interface GovernancePolicyEntry {
  ruleKey: string;
  kind: string;
  status: 'ratified';
  confidence: number;
  promotedAt: IsoTime;
  operator: string;
  evidenceTraces: number;
}

export interface DivergenceCell {
  model: string;
  taskKey: string;
  divergentTraces: number;
  totalTraces: number;
}

export interface GovernanceExport {
  version: number;
  project: { id: string; name: string | null };
  exportedAt: IsoTime;
  metrics: {
    ttrpMs: number | null;
    precision14: { numerator: number; denominator: number; ratio: number | null };
    proposals: {
      total: number;
      pending: number;
      ratified: number;
      rejected: number;
      decayed: number;
    };
  };
  policies: GovernancePolicyEntry[];
  divergence: DivergenceCell[];
}

function distinctEvidenceTraces(policy: Policy): number {
  return new Set(policy.provenance.evidence.map((e) => e.traceId)).size;
}

/** Direct TOOL children of every AGENT/CHAIN run in the tree (tool names only). */
function collectToolUsage(tree: TraceTree): Set<string> {
  const tools = new Set<string>();
  const walk = (node: ObservationNode): void => {
    if (node.row.type === 'AGENT' || node.row.type === 'CHAIN') {
      for (const child of node.children) {
        if (
          child.row.type === 'TOOL' &&
          child.row.name !== undefined &&
          child.row.name.length > 0
        ) {
          tools.add(child.row.name);
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  for (const root of tree.nodes) walk(root);
  return tools;
}

/** Distinct GENERATION models used by the tree (sorted for determinism). */
function collectModels(tree: TraceTree): string[] {
  const models = new Set<string>();
  const walk = (node: ObservationNode): void => {
    if (node.row.type === 'GENERATION' && node.row.model !== undefined && node.row.model.length > 0) {
      models.add(node.row.model);
    }
    for (const child of node.children) walk(child);
  };
  for (const root of tree.nodes) walk(root);
  return [...models].sort();
}

/**
 * Tool-choice divergence at model × task-key granularity. Mirrors the
 * propose/candidates.ts `specToolChoice` signal (per-agent preferred tool via
 * argmax of trace usage minus the max other-agent usage; the group "standard"
 * tool is the preferred tool with the most group-wide usage; a trace is
 * divergent iff its agent prefers a non-standard tool and actually used it).
 * Deterministic: cells are sorted (model asc, taskKey asc).
 */
export function divergenceByModelTask(trees: TraceTree[]): DivergenceCell[] {
  const divergentTraceIds = new Set<string>();
  for (const group of divergenceGroups(trees)) {
    if (group.taskKey.length === 0) continue;

    const usage = new Map<string, Set<string>>();
    for (const tree of group.trees) usage.set(tree.traceId, collectToolUsage(tree));

    const agentTraces = new Map<string, string[]>();
    for (const tree of group.trees) {
      if (tree.agentId === undefined) continue;
      const list = agentTraces.get(tree.agentId) ?? [];
      list.push(tree.traceId);
      agentTraces.set(tree.agentId, list);
    }

    // per-agent preferred tool (argmax of count minus max other-agent usage;
    // ties broken alphabetically)
    const counts = new Map<string, Map<string, number>>();
    for (const [agent, traces] of agentTraces) {
      const perTool = new Map<string, number>();
      for (const traceId of traces) {
        for (const tool of usage.get(traceId) ?? []) perTool.set(tool, (perTool.get(tool) ?? 0) + 1);
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

    if (preferred.size < 2) continue; // no cross-agent divergence
    const distinctTools = new Set(preferred.values());
    if (distinctTools.size < 2) continue;

    const groupUsage = new Map<string, number>();
    for (const tree of group.trees) {
      for (const tool of usage.get(tree.traceId) ?? []) groupUsage.set(tool, (groupUsage.get(tool) ?? 0) + 1);
    }
    const standard = [...distinctTools].sort((a, b) => {
      const da = groupUsage.get(a) ?? 0;
      const db = groupUsage.get(b) ?? 0;
      return db !== da ? db - da : a < b ? -1 : a > b ? 1 : 0;
    })[0]!;
    const divergentTools = [...distinctTools].filter((t) => t !== standard);

    for (const tree of group.trees) {
      const tools = usage.get(tree.traceId) ?? new Set<string>();
      if (tools.has(standard)) continue; // standard-tool trace is supporting
      const pref = tree.agentId !== undefined ? preferred.get(tree.agentId) : undefined;
      if (pref === undefined || !divergentTools.includes(pref)) continue;
      if (tools.has(pref)) divergentTraceIds.add(tree.traceId);
    }
  }

  const cellMap = new Map<string, DivergenceCell>();
  for (const tree of trees) {
    if (tree.taskKey.length === 0) continue;
    const models = collectModels(tree);
    if (models.length === 0) continue;
    const divergent = divergentTraceIds.has(tree.traceId);
    for (const model of models) {
      const key = `${model}\u0000${tree.taskKey}`;
      const cell = cellMap.get(key) ?? { model, taskKey: tree.taskKey, divergentTraces: 0, totalTraces: 0 };
      cell.totalTraces += 1;
      if (divergent) cell.divergentTraces += 1;
      cellMap.set(key, cell);
    }
  }
  return [...cellMap.values()].sort((a, b) => {
    if (a.model < b.model) return -1;
    if (a.model > b.model) return 1;
    if (a.taskKey < b.taskKey) return -1;
    if (a.taskKey > b.taskKey) return 1;
    return 0;
  });
}

export interface BuildGovernanceExportInput {
  projectId: string;
  exportedAt: IsoTime;
  metrics: MetricsResult;
  /** Effective canon (latest version per ruleKey). */
  policies: Policy[];
  divergence: DivergenceCell[];
}

/** Effective canon + metrics + divergence → the versioned dashboard document. */
export function buildGovernanceExport(input: BuildGovernanceExportInput): GovernanceExport {
  const m = input.metrics;
  return {
    version: GOVERNANCE_EXPORT_VERSION,
    project: { id: input.projectId, name: null },
    exportedAt: input.exportedAt,
    metrics: {
      ttrpMs: m.ttrp === null ? null : m.ttrp.ms,
      precision14: m.precision14,
      proposals: m.proposals,
    },
    policies: input.policies.map((policy) => ({
      ruleKey: policy.ruleKey,
      kind: kindOfRuleKey(policy.ruleKey),
      status: 'ratified' as const,
      confidence: policy.provenance.confidence,
      promotedAt: policy.ratifiedAt,
      operator: policy.ratifiedBy,
      evidenceTraces: distinctEvidenceTraces(policy),
    })),
    divergence: input.divergence,
  };
}
