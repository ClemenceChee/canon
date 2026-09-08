/**
 * analyze/decisions.ts (04 Slice 4) — structural decision extraction
 * (03 analyze/decisions.ts). DEC-16 semantics, pinned implementation reading:
 *
 * Per trace, ordered decision points = the tool calls an AGENT/CHAIN run makes
 * (direct TOOL children of the run), each with {name, side-effect flag, step,
 * outcome}. Facts emitted per trace:
 *  - side_effect_retry / retry_budget: the same tool is called repeatedly
 *    under one AGENT/CHAIN run within RETRY_WINDOW_SECONDS_DEFAULT. A repeat of
 *    a [PROPOSED] side-effect tool (SIDE_EFFECT_TOOLS — DEC-17 "charge/
 *    reversal class") yields a side_effect_retry fact with a cause:
 *        after-error     the first call's level is ERROR or carries a
 *                        non-empty statusMessage
 *        after-timeout   a WARN/ERROR sibling observation between the two
 *                        calls signals a timeout in its name/statusMessage
 *        after-unknown   otherwise
 *    DEC-17: the cause is recorded but counts toward the side-effect-retry
 *    kind regardless. A repeat of any other tool yields a retry_budget fact
 *    (03 fact→rule mapping); retry-budget is not a v0.1 candidate kind.
 *  - failure: one fact per row that classifies the trace as failing (level
 *    ERROR, or AGENT/TOOL/CHAIN with a non-empty statusMessage).
 *  - model_usage: one fact per trace covering its GENERATION rows (model +
 *    usage/cost carried additively so candidate math can rank models by
 *    price without re-reading rows).
 *
 * tool_choice facts are NOT emitted here: tool-choice divergence is a
 * cross-agent property computed over divergence groups (DEC-16: "tool-choice
 * frequency vs outcome" within a taskKey group across >=2 agents), so the
 * DecisionFact.kind stays declared for the shared type but is produced by the
 * divergence/candidate stage.
 */

import { RETRY_WINDOW_SECONDS_DEFAULT, SIDE_EFFECT_TOOLS } from '../core/constants.js';
import type { IsoTime } from '../core/time.js';
import type { Outcome } from '../store/archive.js';
import type { TraceTree, ObservationNode } from './tree.js';

export type FactKind =
  | 'tool_choice'
  | 'side_effect_retry'
  | 'retry_budget'
  | 'failure'
  | 'model_usage';

export type RetryCause = 'after-error' | 'after-timeout' | 'after-unknown';

/**
 * One structural decision fact for a trace (03 DecisionFact + additive DEC-16
 * carry fields: retry cause; model prices so costlier-model ranking is
 * deterministic from the fact alone).
 */
export interface DecisionFact {
  kind: FactKind;
  traceId: string;
  observationIds: string[];
  agentId?: string;
  taskKey: string;
  environment?: string;
  outcome: Outcome;
  tools: string[];
  model?: string;
  /** DEC-16: retry cause (after-error | after-timeout | after-unknown). */
  cause?: RetryCause;
  /** DEC-16/03 additive: per-token price strings of a model_usage fact. */
  modelInputPrice?: string;
  modelOutputPrice?: string;
  level?: string;
  attempts?: number;
  at: IsoTime;
}

const RUN_TYPES: ReadonlySet<string> = new Set(['AGENT', 'CHAIN']);
const FAILING_TYPES: ReadonlySet<string> = new Set(['AGENT', 'TOOL', 'CHAIN']);
const TIMEOUT_RE = /timeout/i;

function isBlank(s: unknown): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

interface RunCall {
  node: ObservationNode;
  order: number; // position of the tool child among the run's children (startTime asc)
  at: string; // startTime of the call ('' tolerated)
}

/** Direct TOOL children of one AGENT/CHAIN run, in deterministic order. */
function toolCallsOf(run: ObservationNode): RunCall[] {
  const calls: RunCall[] = [];
  const children = [...run.children].sort((a, b) => {
    const at = a.row.startTime ?? '';
    const bt = b.row.startTime ?? '';
    if (at < bt) return -1;
    if (at > bt) return 1;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });
  children.forEach((child, order) => {
    if (child.row.type === 'TOOL') calls.push({ node: child, order, at: child.row.startTime ?? '' });
  });
  return calls;
}

/** Parse string-decimal prices (03: model prices are string decimals). */
function priceOf(row: { inputPrice?: string; outputPrice?: string }): {
  input?: string;
  output?: string;
} {
  return {
    ...(typeof row.inputPrice === 'string' ? { input: row.inputPrice } : {}),
    ...(typeof row.outputPrice === 'string' ? { output: row.outputPrice } : {}),
  };
}

function flattenNodes(nodes: ObservationNode[]): ObservationNode[] {
  const out: ObservationNode[] = [];
  const walk = (node: ObservationNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const root of nodes) walk(root);
  return out;
}

function msDiff(a: string | undefined, b: string | undefined): number | undefined {
  if (a === undefined || b === undefined) return undefined;
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return undefined;
  return Math.abs(pa - pb) / 1000;
}

/** Timeout witness between two calls: a WARN/ERROR sibling naming a timeout. */
function timeoutBetween(tree: TraceTree, first: RunCall, second: RunCall): boolean {
  const nodes = flattenNodes(tree.nodes);
  for (const node of nodes) {
    const row = node.row;
    if (row.id === first.node.row.id || row.id === second.node.row.id) continue;
    if (row.level !== 'WARN' && row.level !== 'ERROR') continue;
    const text = `${row.name ?? ''} ${row.statusMessage ?? ''}`;
    if (!TIMEOUT_RE.test(text)) continue;
    // the witness must sit between the two calls in start time
    const t = row.startTime ?? '';
    const firstAt = first.node.row.startTime ?? '';
    const secondAt = second.node.row.startTime ?? '';
    if (firstAt <= t && t < secondAt) return true;
  }
  return false;
}

/**
 * Decision facts for one tree. Deterministic ordering: kind groups emitted in
 * a fixed order (side_effect_retry/retry_budget, failure, model_usage), each
 * sorted by the first observation's startTime.
 */
export function extractDecisions(tree: TraceTree): DecisionFact[] {
  const facts: DecisionFact[] = [];
  const base = {
    traceId: tree.traceId,
    agentId: tree.agentId,
    taskKey: tree.taskKey,
    ...(tree.environment !== undefined ? { environment: tree.environment } : {}),
    outcome: tree.outcome,
  };

  // ---- repeated same-tool calls under one AGENT/CHAIN run (retries) ----
  const runs = flattenNodes(tree.nodes).filter((n) => RUN_TYPES.has(String(n.row.type)));
  for (const run of runs) {
    const calls = toolCallsOf(run);
    const byTool = new Map<string, RunCall[]>();
    for (const call of calls) {
      const list = byTool.get(call.node.row.name ?? '') ?? [];
      list.push(call);
      byTool.set(call.node.row.name ?? '', list);
    }
    for (const [tool, occurrences] of byTool) {
      if (occurrences.length < 2) continue;
      const first = occurrences[0]!;
      const second = occurrences[1]!;
      const gap = msDiff(first.node.row.startTime, second.node.row.startTime);
      if (gap !== undefined && gap > RETRY_WINDOW_SECONDS_DEFAULT) continue;
      const firstRow = first.node.row;
      const cause: RetryCause =
        firstRow.level === 'ERROR' || !isBlank(firstRow.statusMessage)
          ? 'after-error'
          : timeoutBetween(tree, first, second)
            ? 'after-timeout'
            : 'after-unknown';
      const sideEffect = (SIDE_EFFECT_TOOLS as readonly string[]).includes(tool);
      facts.push({
        kind: sideEffect ? 'side_effect_retry' : 'retry_budget',
        ...base,
        observationIds: occurrences.slice(0, 2).map((c) => c.node.row.id),
        tools: [tool],
        ...(firstRow.level !== undefined ? { level: firstRow.level } : {}),
        attempts: occurrences.length,
        cause,
        at: first.node.row.startTime ?? tree.startTime ?? '',
      });
    }
  }

  // ---- failures: rows that classify the trace as failing ----
  const failing = flattenNodes(tree.nodes).filter((node) => {
    const row = node.row;
    if (row.level === 'ERROR') return true;
    return FAILING_TYPES.has(String(row.type)) && !isBlank(row.statusMessage);
  });
  for (const node of failing) {
    const row = node.row;
    const parent = row.parentObservationId ?? undefined;
    // failure fact tool: the failing TOOL call itself, else its parent chain
    const isTool = row.type === 'TOOL' && row.name !== undefined && row.name.length > 0;
    const toolName = isTool ? row.name : parent !== undefined && parent.length > 0 ? parent : row.name;
    facts.push({
      kind: 'failure',
      ...base,
      observationIds: [row.id],
      tools: toolName !== undefined && toolName.length > 0 ? [toolName] : [],
      ...(row.level !== undefined ? { level: row.level } : {}),
      at: row.startTime ?? tree.startTime ?? '',
    });
  }

  // ---- model usage: GENERATION rows under an agent run, aggregated per trace ----
  const modelRows = flattenNodes(tree.nodes).filter(
    (n) => n.row.type === 'GENERATION' && n.row.model !== undefined && n.row.model.length > 0,
  );
  if (modelRows.length > 0) {
    const byModel = new Map<string, typeof modelRows>();
    for (const node of modelRows) {
      const m = node.row.model!;
      const list = byModel.get(m) ?? [];
      list.push(node);
      byModel.set(m, list);
    }
    for (const [model, list] of byModel) {
      const prices = priceOf(list[0]!.row);
      facts.push({
        kind: 'model_usage',
        ...base,
        observationIds: list.map((n) => n.row.id),
        tools: [],
        model,
        ...(prices.input !== undefined ? { modelInputPrice: prices.input } : {}),
        ...(prices.output !== undefined ? { modelOutputPrice: prices.output } : {}),
        at: list[0]!.row.startTime ?? tree.startTime ?? '',
      });
    }
  }

  facts.sort((a, b) => {
    if (a.at < b.at) return -1;
    if (a.at > b.at) return 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
  return facts;
}

export function isSideEffectTool(name: string): boolean {
  return (SIDE_EFFECT_TOOLS as readonly string[]).includes(name);
}
