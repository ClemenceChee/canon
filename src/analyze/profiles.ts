/**
 * analyze/profiles.ts (04 Slice 4) — agent profiles (03 analyze/profiles.ts):
 * per agentId: runs (trace count), outcome distribution, tools used (with
 * frequencies), tasks, environments, first/last seen, and total GENERATION
 * cost (sum of costDetails.total across the agent's traces; costDetails.total
 * is numeric, parsed only when finite — Langfuse string decimals are price
 * fields, costDetails is already numeric).
 */

import type { Outcome } from '../store/archive.js';
import type { ObservationNode, TraceTree } from './tree.js';

export interface AgentProfile {
  agentId: string;
  runs: number;
  outcomes: Record<Outcome, number>;
  /** tool name -> number of traces (distinct traces per tool, deterministic). */
  tools: Map<string, number>;
  tasks: Set<string>;
  environments: Set<string>;
  firstSeen?: string;
  lastSeen?: string;
  totalCost?: number;
}

export function buildProfiles(trees: TraceTree[]): AgentProfile[] {
  const profiles = new Map<string, AgentProfile>();
  const ensure = (agentId: string): AgentProfile => {
    let profile = profiles.get(agentId);
    if (profile === undefined) {
      profile = {
        agentId,
        runs: 0,
        outcomes: { success: 0, failure: 0, unknown: 0 },
        tools: new Map<string, number>(),
        tasks: new Set<string>(),
        environments: new Set<string>(),
      };
      profiles.set(agentId, profile);
    }
    return profile;
  };

  for (const tree of trees) {
    if (tree.agentId === undefined) continue; // anonymous runs are not profiled
    const profile = ensure(tree.agentId);
    profile.runs += 1;
    profile.outcomes[tree.outcome] += 1;
    if (tree.environment !== undefined) profile.environments.add(tree.environment);
    if (tree.taskKey.length > 0) profile.tasks.add(tree.taskKey);
    // tools used per trace (dedupe per trace — frequency = trace count)
    const toolSet = new Set<string>();
    let cost = 0;
    for (const root of tree.nodes) {
      cost += walkNodes(root, toolSet);
    }
    for (const tool of toolSet) {
      profile.tools.set(tool, (profile.tools.get(tool) ?? 0) + 1);
    }
    if (cost > 0) profile.totalCost = (profile.totalCost ?? 0) + cost;
    if (tree.startTime !== undefined) {
      if (profile.firstSeen === undefined || tree.startTime < profile.firstSeen) {
        profile.firstSeen = tree.startTime;
      }
    }
    if (tree.endTime !== undefined) {
      if (profile.lastSeen === undefined || tree.endTime > profile.lastSeen) {
        profile.lastSeen = tree.endTime;
      }
    }
  }

  return [...profiles.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, profile]) => profile);
}

/** Walk a node subtree; collect TOOL names into `tools`; return GENERATION cost. */
function walkNodes(node: ObservationNode, tools: Set<string>): number {
  const row = node.row;
  if (row.type === 'TOOL' && row.name !== undefined && row.name.length > 0) tools.add(row.name);
  let cost = 0;
  if (row.type === 'GENERATION') {
    const total = row.costDetails?.total;
    if (typeof total === 'number' && Number.isFinite(total)) cost += total;
  }
  for (const child of node.children) cost += walkNodes(child, tools);
  return cost;
}
