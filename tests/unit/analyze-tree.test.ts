/**
 * Unit tests for analyze/tree.ts (03 testing plan: "tree: fixture rows →
 * exact trees (multi-root traces, isRootObservation vs orphan, missing
 * parents → skipped); inferOutcome on ERROR/statusMessage cases incl.
 * ambiguity").
 */

import { describe, expect, it } from 'vitest';
import { rebuildTrees, inferOutcome } from '../../src/analyze/tree.js';
import type { LfObservationRow, LfScoreRow } from '../../src/trace/types.js';

function row(partial: Partial<LfObservationRow> & { id: string; traceId: string }): LfObservationRow {
  return {
    projectId: 'prj-x',
    type: 'SPAN',
    parentObservationId: null,
    isRootObservation: false,
    ...partial,
  };
}

describe('rebuildTrees', () => {
  it('links parents into a tree, roots first, children ordered by startTime', () => {
    const rows: LfObservationRow[] = [
      row({ id: 'o1', traceId: 't1', type: 'AGENT', name: 'agent-a', startTime: '2025-01-01T00:00:00.000Z', traceName: 'task_x', environment: 'production' }),
      row({ id: 'o2', traceId: 't1', type: 'TOOL', name: 'tool-b', startTime: '2025-01-01T00:00:03.000Z', parentObservationId: 'o1' }),
      row({ id: 'o3', traceId: 't1', type: 'TOOL', name: 'tool-a', startTime: '2025-01-01T00:00:01.000Z', parentObservationId: 'o1' }),
    ];
    const { trees, skipped } = rebuildTrees(rows, []);
    expect(skipped).toEqual([]);
    expect(trees).toHaveLength(1);
    const tree = trees[0]!;
    expect(tree.traceId).toBe('t1');
    expect(tree.rootObservationId).toBe('o1');
    expect(tree.agentId).toBe('agent-a');
    expect(tree.taskKey).toBe('task_x');
    expect(tree.environment).toBe('production');
    // children ordered by startTime asc (o3 before o2)
    expect(tree.nodes[0]!.children.map((c) => c.row.id)).toEqual(['o3', 'o2']);
    expect(tree.nodes[0]!.children[0]!.children).toEqual([]);
  });

  it('accepts rows in any order (root usually appended after its children)', () => {
    const rows: LfObservationRow[] = [
      row({ id: 'c1', traceId: 't2', type: 'TOOL', parentObservationId: 'r1', startTime: '2025-01-01T00:00:01.000Z' }),
      row({ id: 'r1', traceId: 't2', type: 'AGENT', isRootObservation: true, startTime: '2025-01-01T00:00:00.000Z' }),
    ];
    const { trees } = rebuildTrees(rows, []);
    expect(trees[0]?.nodes[0]?.row.id).toBe('r1');
    expect(trees[0]?.nodes[0]?.children[0]?.row.id).toBe('c1');
  });

  it('skips rows without a traceId and orphans whose parent is missing', () => {
    const rows: LfObservationRow[] = [
      row({ id: 'no-trace', traceId: '' }),
      row({ id: 'orphan', traceId: 't3', parentObservationId: 'gone' }),
      row({ id: 'root', traceId: 't3', type: 'AGENT', isRootObservation: true }),
      row({ id: 'kid', traceId: 't3', parentObservationId: 'root', type: 'TOOL' }),
    ];
    const { trees, skipped } = rebuildTrees(rows, []);
    expect(trees).toHaveLength(1); // only the trace with a real root
    expect(trees[0]?.nodes[0]?.row.id).toBe('root');
    expect(skipped).toEqual([
      { reason: 'missing-traceId', rowId: 'no-trace' },
      { reason: 'orphan-row', rowId: 'orphan' },
    ]);
  });

  it('keeps multi-root forests (isRootObservation roots and parent-less rows)', () => {
    const rows: LfObservationRow[] = [
      row({ id: 'r1', traceId: 't4', type: 'AGENT', isRootObservation: true, startTime: '2025-01-01T00:00:00.000Z' }),
      row({ id: 'r2', traceId: 't4', type: 'AGENT', isRootObservation: true, startTime: '2025-01-01T00:00:02.000Z' }),
      row({ id: 'k1', traceId: 't4', type: 'TOOL', parentObservationId: 'r1' }),
    ];
    const { trees } = rebuildTrees(rows, []);
    expect(trees[0]?.nodes.map((n) => n.row.id)).toEqual(['r1', 'r2']);
  });

  it('attaches scores by TRACE and OBSERVATION subject (DEC-12)', () => {
    const rows: LfObservationRow[] = [
      row({ id: 'root', traceId: 't5', type: 'AGENT', isRootObservation: true }),
      row({ id: 'tool1', traceId: 't5', type: 'TOOL', parentObservationId: 'root' }),
    ];
    const scores: LfScoreRow[] = [
      { id: 's1', name: 'eval', dataType: 'NUMERIC', value: 1, source: 'EVAL' as const, subject: { kind: 'TRACE' as const, id: 't5', traceId: 't5' } },
      { id: 's2', name: 'tool-check', dataType: 'BOOLEAN', value: true, source: 'EVAL' as const, subject: { kind: 'OBSERVATION' as const, id: 'tool1', traceId: 't5' } },
      { id: 's3', name: 'other', dataType: 'NUMERIC', value: 1, source: 'EVAL' as const, subject: { kind: 'TRACE' as const, id: 't-other', traceId: 't-other' } },
    ];
    const { trees } = rebuildTrees(rows, scores);
    expect(trees[0]?.scores.map((s) => s.id)).toEqual(['s1', 's2']);
  });
});

describe('inferOutcome', () => {
  const node = (partial: Partial<LfObservationRow> & { id: string }): { row: LfObservationRow; children: never[] } => {
    const { id, ...rest } = partial;
    return { row: row({ id, traceId: 't', ...rest }), children: [] };
  };

  it('failure on any ERROR-level node', () => {
    expect(inferOutcome([node({ id: 'a', type: 'AGENT', level: 'ERROR' })])).toBe('failure');
    expect(
      inferOutcome([
        node({ id: 'a', type: 'AGENT', level: 'INFO' }),
        node({ id: 'b', type: 'TOOL', level: 'ERROR', parentObservationId: 'a' }),
      ]),
    ).toBe('failure');
  });

  it('failure on a non-empty statusMessage of AGENT/TOOL/CHAIN rows', () => {
    expect(
      inferOutcome([node({ id: 'a', type: 'TOOL', level: 'WARN', statusMessage: 'evidence insufficient' })]),
    ).toBe('failure');
    // SPAN statusMessage (e.g. a gateway-timeout witness) does NOT fail the trace
    expect(
      inferOutcome([node({ id: 'a', type: 'SPAN', level: 'WARN', statusMessage: 'charge gateway timeout' })]),
    ).toBe('success');
  });

  it('success for clean INFO trees; unknown when no signal exists at all', () => {
    expect(inferOutcome([node({ id: 'a', type: 'AGENT', level: 'INFO' })])).toBe('success');
    expect(
      inferOutcome([
        node({ id: 'a', type: 'AGENT', level: 'INFO' }),
        node({ id: 'b', type: 'SPAN', level: 'WARN' }),
      ]),
    ).toBe('success');
    // a row with neither a level nor a statusMessage carries no signal
    expect(inferOutcome([node({ id: 'a', type: 'SPAN' })])).toBe('unknown');
  });
});
