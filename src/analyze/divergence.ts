/**
 * analyze/divergence.ts (04 Slice 4) — divergence groups (03 analyze/
 * divergence.ts). Group key = taskKey + environment [DEC-13]; every tree
 * belongs to >=1 group (singleton groups exist). Groups below
 * settings.analysis.minTraces never reach buildCandidates (app-level filter
 * in analyzeImpl — the group formation itself keeps singletons for the
 * report).
 *
 * DEC-16 divergence reading: within a taskKey group across >=2 agents,
 * "tool-choice frequency vs outcome" is the cross-agent comparison —
 * candidates.ts runs that comparison over the group's trees (this module
 * only forms the groups and reports their outcome split).
 */

import type { Outcome } from '../store/archive.js';
import type { TraceTree } from './tree.js';

export interface DivergenceGroup {
  taskKey: string;
  environment?: string;
  trees: TraceTree[];
  agents: Set<string>;
  outcomeSplit: Record<Outcome, number>;
}

export function divergenceGroups(trees: TraceTree[]): DivergenceGroup[] {
  const byKey = new Map<string, DivergenceGroup>();
  const keyOf = (tree: TraceTree): string => `${tree.taskKey}\u0000${tree.environment ?? ''}`;
  for (const tree of trees) {
    let group = byKey.get(keyOf(tree));
    if (group === undefined) {
      group = {
        taskKey: tree.taskKey,
        environment: tree.environment,
        trees: [],
        agents: new Set<string>(),
        outcomeSplit: { success: 0, failure: 0, unknown: 0 },
      };
      byKey.set(keyOf(tree), group);
    }
    group.trees.push(tree);
    group.outcomeSplit[tree.outcome] += 1;
    if (tree.agentId !== undefined) group.agents.add(tree.agentId);
  }
  return [...byKey.values()]
    .sort((a, b) => {
      const k = a.taskKey.localeCompare(b.taskKey);
      return k !== 0 ? k : (a.environment ?? '').localeCompare(b.environment ?? '');
    })
    .map((g) => {
      // deterministic trace order inside the group
      g.trees.sort((a, b) => (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0));
      return g;
    });
}
