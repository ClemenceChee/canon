/**
 * analyze/tree.ts (04 Slice 4) — rebuild trace trees from archived observation
 * rows (traceId + parentObservationId + isRootObservation) and infer each
 * trace's outcome (DEC-16: analyze infers outcomes and back-fills them into
 * the index, replacing the slice-3 'unknown' placeholder).
 *
 * Trees are rebuilt IN MEMORY per analyze run (02: "trees rebuilt once per
 * analyze run (in-memory), not persisted"); nothing here writes the store.
 *
 * PINNED SEMANTICS (implementation reading of 03 + ADR-0003 DEC-16):
 *  - rows without a traceId → skipped 'missing-traceId';
 *  - a row whose parentObservationId does not resolve inside its own trace
 *    and that is not flagged isRootObservation → skipped 'orphan-row'
 *    (Langfuse root rows have no physical parent; a parent-less non-root is
 *    a data gap, never a root);
 *  - unparseable archive lines are reported by the archive reader (corrupted)
 *    and folded into TreeReport.skipped as 'unparseable' by the caller;
 *  - outcome: 'failure' ⇔ any row level ERROR, or any AGENT/TOOL/CHAIN row
 *    with a non-empty statusMessage; 'unknown' when the tree has no signal at
 *    all (no row carries a level/statusMessage); else 'success'.
 */

import type { LfObservationRow, LfScoreRow } from '../trace/types.js';
import type { IsoTime } from '../core/time.js';
import type { Outcome } from '../store/archive.js';

export interface ObservationNode {
  row: LfObservationRow;
  children: ObservationNode[];
}

export interface TraceTree {
  traceId: string;
  rootObservationId?: string;
  agentId?: string;
  taskKey: string;
  environment?: string;
  sessionId?: string;
  userId?: string;
  startTime?: IsoTime;
  endTime?: IsoTime;
  outcome: Outcome;
  nodes: ObservationNode[];
  /** Scores attached by subject [DEC-12]: TRACE subject = this trace, or OBSERVATION subject = one of its rows. */
  scores: LfScoreRow[];
}

export type SkipReason = 'orphan-row' | 'missing-traceId' | 'unparseable';

export interface TreeReport {
  trees: TraceTree[];
  skipped: Array<{ reason: SkipReason; rowId?: string }>;
}

const SIGNAL_TYPES: ReadonlySet<string> = new Set(['AGENT', 'TOOL', 'CHAIN']);

function isBlank(s: unknown): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

function flatten(nodes: ObservationNode[]): ObservationNode[] {
  const out: ObservationNode[] = [];
  const walk = (node: ObservationNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of nodes) walk(root);
  return out;
}

/**
 * 'failure' ⇔ any row level ERROR, or any AGENT/TOOL/CHAIN row with a
 * non-empty statusMessage; 'unknown' when the tree carries no outcome signal
 * at all (every row lacks a level AND a statusMessage); else 'success'.
 */
export function inferOutcome(nodes: ObservationNode[]): Outcome {
  let anySignal = false;
  for (const node of flatten(nodes)) {
    const row = node.row;
    if (row.level !== undefined || row.statusMessage !== undefined) anySignal = true;
    if (row.level === 'ERROR') return 'failure';
    if (SIGNAL_TYPES.has(String(row.type)) && !isBlank(row.statusMessage)) return 'failure';
  }
  return anySignal ? 'success' : 'unknown';
}

function byStartThenId(a: LfObservationRow, b: LfObservationRow): number {
  const at = a.startTime ?? '';
  const bt = b.startTime ?? '';
  if (at < bt) return -1;
  if (at > bt) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Rebuild trees from rows + scores. Pure and deterministic (sorted iteration,
 * no wall clock); rows may arrive in any order (the archive is Langfuse fetch
 * order, newest first — root rows usually appended AFTER their children).
 */
export function rebuildTrees(rows: LfObservationRow[], scores: LfScoreRow[]): TreeReport {
  const skipped: TreeReport['skipped'] = [];

  // group rows by traceId; rows without one are skipped
  const groups = new Map<string, LfObservationRow[]>();
  for (const row of rows) {
    const traceId = row.traceId;
    if (typeof traceId !== 'string' || traceId.length === 0) {
      skipped.push({ reason: 'missing-traceId', rowId: row.id });
      continue;
    }
    const list = groups.get(traceId) ?? [];
    list.push(row);
    groups.set(traceId, list);
  }

  const trees: TraceTree[] = [];
  for (const [traceId, group] of groups) {
    const byId = new Map<string, LfObservationRow>();
    for (const row of group) byId.set(row.id, row);
    const childrenOf = new Map<string, LfObservationRow[]>();
    const roots: LfObservationRow[] = [];
    const orphans: LfObservationRow[] = [];
    for (const row of group) {
      const parent = row.parentObservationId;
      if (parent === null || parent === undefined || parent === '') {
        roots.push(row);
        continue;
      }
      if (byId.has(parent)) {
        const list = childrenOf.get(parent) ?? [];
        list.push(row);
        childrenOf.set(parent, list);
      } else if (row.isRootObservation === true) {
        // tolerate a Langfuse root that (oddly) carries a parent reference
        roots.push(row);
      } else {
        orphans.push(row);
      }
    }
    for (const row of orphans) skipped.push({ reason: 'orphan-row', rowId: row.id });

    const buildNode = (row: LfObservationRow): ObservationNode => {
      const kids = (childrenOf.get(row.id) ?? []).sort(byStartThenId);
      return { row, children: kids.map(buildNode) };
    };
    const rootsSorted = [...roots].sort(byStartThenId);
    const nodes = rootsSorted.map(buildNode);
    if (nodes.length === 0) continue; // every row of this trace was skipped

    const allRows = [...group];
    const startTime = allRows
      .map((r) => r.startTime)
      .filter((t): t is string => typeof t === 'string')
      .sort()
      .at(0);
    const endTime = allRows
      .map((r) => r.endTime)
      .filter((t): t is string => typeof t === 'string')
      .sort()
      .at(-1);
    const rootAgent = rootsSorted.find((r) => r.type === 'AGENT');
    const anyAgent = allRows.find(
      (r) => r.type === 'AGENT' && r.name !== undefined && r.name.length > 0,
    );
    const agentRow = rootAgent ?? anyAgent;
    const agentName =
      agentRow !== undefined && agentRow.name !== undefined && agentRow.name.length > 0
        ? agentRow.name
        : undefined;
    const withTraceName = (rows: LfObservationRow[]): string | undefined =>
      rows.find((r) => r.traceName !== undefined && r.traceName.length > 0)?.traceName;
    const taskKey = withTraceName(rootsSorted) ?? withTraceName(allRows) ?? '';
    const env =
      rootsSorted.find((r) => r.environment !== undefined && r.environment.length > 0)
        ?.environment ??
      allRows.find((r) => r.environment !== undefined && r.environment.length > 0)
        ?.environment;
    const head = rootsSorted[0]!;

    const treeRowIds = new Set<string>();
    const collect = (node: ObservationNode): void => {
      treeRowIds.add(node.row.id);
      for (const child of node.children) collect(child);
    };
    for (const root of nodes) collect(root);

    // DEC-12: scores attached by subject (TRACE subject or OBSERVATION subject)
    const treeScores = scores.filter((s) => {
      const subject = s.subject;
      if (subject === undefined) {
        return s.traceId === traceId; // top-level traceId mirror (TRACE subjects)
      }
      if (subject.kind === 'TRACE') return subject.id === traceId || s.traceId === traceId;
      if (subject.kind === 'OBSERVATION') return treeRowIds.has(subject.id);
      return false;
    });

    trees.push({
      traceId,
      rootObservationId: head.id,
      ...(agentName !== undefined ? { agentId: agentName } : {}),
      taskKey,
      ...(env !== undefined ? { environment: env } : {}),
      ...(head.sessionId !== undefined ? { sessionId: head.sessionId } : {}),
      ...(head.userId !== undefined ? { userId: head.userId } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      outcome: inferOutcome(nodes),
      nodes,
      scores: treeScores,
    });
  }

  // deterministic order: traceId asc
  trees.sort((a, b) => (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0));
  return { trees, skipped };
}
