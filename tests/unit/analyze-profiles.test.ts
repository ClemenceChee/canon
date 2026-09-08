/**
 * Unit tests for analyze/profiles.ts + analyze/divergence.ts (03 testing
 * plan: profiles per agent incl. cost; divergence grouping by
 * taskKey+environment with ≥ minTraces filtered at the app level).
 */

import { describe, expect, it } from 'vitest';
import { rebuildTrees } from '../../src/analyze/tree.js';
import { buildProfiles } from '../../src/analyze/profiles.js';
import { divergenceGroups } from '../../src/analyze/divergence.js';
import type { LfObservationRow } from '../../src/trace/types.js';

function rowsForTrace(traceId: string, agent: string, task: string, env: string, model: string | undefined, cost: number): LfObservationRow[] {
  const base = {
    projectId: 'prj-x',
    environment: env,
    traceName: task,
    isRootObservation: false,
    parentObservationId: null as string | null,
    statusMessage: '',
  };
  return [
    {
      ...base,
      id: `agent-${traceId}`,
      traceId,
      type: 'AGENT',
      name: agent,
      isRootObservation: true,
      level: 'INFO',
      startTime: '2025-01-01T00:00:00.000Z',
      endTime: '2025-01-01T00:00:10.000Z',
    },
    {
      ...base,
      id: `tool-${traceId}`,
      traceId,
      type: 'TOOL',
      name: 'pay-tool',
      level: 'INFO',
      parentObservationId: `agent-${traceId}`,
      startTime: '2025-01-01T00:00:01.000Z',
      endTime: '2025-01-01T00:00:02.000Z',
    },
    {
      ...base,
      id: `gen-${traceId}`,
      traceId,
      type: 'GENERATION',
      name: 'summary',
      level: 'INFO',
      parentObservationId: `agent-${traceId}`,
      startTime: '2025-01-01T00:00:03.000Z',
      endTime: '2025-01-01T00:00:04.000Z',
      ...(model !== undefined ? { model } : {}),
      costDetails: { input: 0, output: 0, total: cost },
    },
  ];
}

const rows: LfObservationRow[] = [
  ...rowsForTrace('tr_a1', 'agent-a', 'task_pay', 'production', 'gpt-4o', 0.5),
  ...rowsForTrace('tr_a2', 'agent-a', 'task_pay', 'production', 'gpt-4o', 0.5),
  ...rowsForTrace('tr_a3', 'agent-a', 'task_pay', 'production', 'gpt-4o', 0.5),
  ...rowsForTrace('tr_b1', 'agent-b', 'task_pay', 'production', 'gpt-4o-mini', 0.1),
  ...rowsForTrace('tr_b2', 'agent-b', 'task_pay', 'staging', 'gpt-4o-mini', 0.1),
];
const { trees } = rebuildTrees(rows, []);

describe('buildProfiles', () => {
  it('aggregates runs/outcomes/tools/tasks/environments/cost per agent', () => {
    const profiles = buildProfiles(trees);
    expect(profiles.map((p) => p.agentId)).toEqual(['agent-a', 'agent-b']);
    const a = profiles.find((p) => p.agentId === 'agent-a')!;
    expect(a.runs).toBe(3);
    expect(a.outcomes).toEqual({ success: 3, failure: 0, unknown: 0 });
    expect(a.tasks.has('task_pay')).toBe(true);
    expect(a.environments).toEqual(new Set(['production']));
    expect(a.tools.get('pay-tool')).toBe(3); // one per trace
    expect(a.totalCost).toBeCloseTo(1.5);
    expect(a.firstSeen).toBeDefined();
    expect(a.lastSeen).toBeDefined();
    const b = profiles.find((p) => p.agentId === 'agent-b')!;
    expect(b.environments).toEqual(new Set(['production', 'staging']));
    expect(b.totalCost).toBeCloseTo(0.2);
  });
});

describe('divergenceGroups', () => {
  it('groups by taskKey + environment [DEC-13]; singletons exist', () => {
    const groups = divergenceGroups(trees);
    expect(groups.map((g) => `${g.taskKey}|${g.environment ?? ''}`)).toEqual([
      'task_pay|production',
      'task_pay|staging',
    ]);
    const prod = groups.find((g) => g.environment === 'production')!;
    expect(prod.trees).toHaveLength(4);
    expect(prod.agents).toEqual(new Set(['agent-a', 'agent-b']));
    expect(prod.outcomeSplit).toEqual({ success: 4, failure: 0, unknown: 0 });
    const staging = groups.find((g) => g.environment === 'staging')!;
    expect(staging.trees).toHaveLength(1); // singleton group
    expect(staging.agents).toEqual(new Set(['agent-b']));
  });

  it('splits the same taskKey across environments', () => {
    const staged = trees.filter((t) => t.traceId === 'tr_b2');
    const groups = divergenceGroups(staged);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.environment).toBe('staging');
  });
});
