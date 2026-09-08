/**
 * Fixture scenario registry — single source of truth for the committed corpus
 * (03 layout: "scenarios.ts — builds scenario corpus + expected artifacts").
 *
 * The `refunds` HTTP corpus is the main e2e corpus. It was grown twice:
 * DEC-12 (slice-3 readiness, ~118 unique obs rows) and DEC-18 (slice-4/5
 * floor feasibility — grown additively by scripts/grow-refunds-corpus.py to
 * 246 unique rows so every DEC-17 emission floor is reachable WITH MARGIN).
 * The `edge-rows` *archive* fixture carries the deliberately unparseable
 * envelope line (edge rows live in the archive scenario — an HTTP page JSON
 * must stay valid JSON). Counts below are derived from the committed files;
 * tests import these numbers instead of hardcoding them.
 */

export interface ScenarioCounts {
  id: string; // fixture directory name under tests/fixtures/
  projectId: string;
  /** HTTP pages under langfuse-http/<id>/ (0 when the scenario is archive-only so far). */
  observationPages: number;
  scorePages: number;
  /** total observation row LINES across pages (duplicate-id lines counted). */
  observationRowLines: number;
  /** distinct observation row ids. */
  uniqueObservationRows: number;
  /** observation ids that appear more than once (dedupe fixtures). */
  duplicateObservationIds: string[];
  scoreRows: number;
  traces: number;
  taskKeys: string[];
  agents: string[];
  /**
   * The sync window that covers every row of this scenario; ingest tests walk
   * this exact [from, to) so windowing is deterministic.
   */
  window: { from: string; to: string };
  /** Frozen ingest clock used when authoring archive/index goldens. */
  ingestAt: string;
  /** Line numbers (1-based) in the archive observations.jsonl that are corrupt. */
  archiveCorruptLines?: number[];
}

/** refunds — the main e2e corpus (04 scenario table; DEC-12 + DEC-18 growth). */
export const REFUNDS: ScenarioCounts = {
  id: 'refunds',
  projectId: 'prj-refunds',
  observationPages: 31,
  scorePages: 6,
  observationRowLines: 248, // incl. 2 duplicate-id lines (dedupe fixtures)
  uniqueObservationRows: 246,
  duplicateObservationIds: ['obs_refund_tool_1', 'obs_charge_tool_2'],
  scoreRows: 47,
  traces: 30,
  taskKeys: ['chargeback_task', 'dispute_task', 'refund_task'],
  agents: ['chargeback-agent', 'dispute-agent', 'refund-agent', 'support-agent'],
  window: { from: '2025-08-27T00:00:00.000Z', to: '2025-09-01T00:00:00.000Z' },
  ingestAt: '2025-09-01T12:00:00.000Z',
};

/**
 * Pattern map the slice-4/5 goldens encode (documented here so fixture growth
 * never silently removes a pattern). Counts reflect the DEC-18-grown corpus;
 * the map drives the pre-authored golden proposals (04 + DEC-17):
 *  - tool-choice: refund_task handled by refund-agent (refund-standard on
 *    tr_refund_1/2/3/6/7/8) vs support-agent (refund-quick on tr_refund_5).
 *    Standard-tool traces = 6 (floor 4), divergent = 1; tool-appropriateness
 *    = false annotation on the divergent tool call (score_tool_5).
 *  - side-effect-retry: charge-reversal double calls on chargeback_task
 *    (tr_charge_3 + tr_charge_5..10 = 7 supporting traces, floor 5): causes
 *    after-error (tr_charge_3/5/6/10: first call level ERROR) and
 *    after-timeout (tr_charge_7/8/9: a gateway-timeout WARN span between the
 *    calls). tr_refund_4 keeps the refund-side double call (single trace —
 *    sub-floor colour, never emitted). no-side-effect-retry=false evals +
 *    reversal-accuracy annotations corroborate.
 *  - failure rows: tr_refund_3 (refund-standard ERROR "payment gateway
 *    declined"), tr_charge_3 (charge-reversal ERROR), tr_charge_5/6/10,
 *    tr_dispute_5/11 (WARN TOOL statusMessage "evidence insufficient").
 *  - model-usage: dispute_task runs gpt-4o (costlier: tr_dispute_1/2/5/6/7/
 *    8/9/10/11 = 9 supporting traces, floor 8) vs gpt-4o-mini (cheap:
 *    tr_dispute_3/4/12); costlier traces show no success gain (2 failures
 *    among the 9, cheap all succeed); model-efficiency + dispute-outcome
 *    scores corroborate.
 */
export const REFUNDS_PATTERN_TRACES = {
  toolChoice: {
    taskKey: 'refund_task',
    standard: ['tr_refund_1', 'tr_refund_2', 'tr_refund_3', 'tr_refund_6', 'tr_refund_7', 'tr_refund_8'],
    divergent: ['tr_refund_5'],
    divergentTool: 'refund-quick',
    standardTool: 'refund-standard',
  },
  sideEffectRetry: {
    taskKey: 'chargeback_task',
    tool: 'charge-reversal',
    afterError: ['tr_charge_3', 'tr_charge_5', 'tr_charge_6', 'tr_charge_10'],
    afterTimeout: ['tr_charge_7', 'tr_charge_8', 'tr_charge_9'],
    supporting: ['tr_charge_3', 'tr_charge_5', 'tr_charge_6', 'tr_charge_7', 'tr_charge_8', 'tr_charge_9', 'tr_charge_10'],
    /** refund-side double call — sub-floor colour, never emitted. */
    subFloor: { traceId: 'tr_refund_4', tool: 'charge-reversal' },
  },
  failure: {
    traceIds: ['tr_refund_3', 'tr_charge_3', 'tr_charge_5', 'tr_charge_6', 'tr_charge_10', 'tr_dispute_5', 'tr_dispute_11'],
  },
  modelUsage: {
    taskKey: 'dispute_task',
    costly: ['tr_dispute_1', 'tr_dispute_2', 'tr_dispute_5', 'tr_dispute_6', 'tr_dispute_7', 'tr_dispute_8', 'tr_dispute_9', 'tr_dispute_10', 'tr_dispute_11'],
    cheap: ['tr_dispute_3', 'tr_dispute_4', 'tr_dispute_12'],
    costlyModel: 'gpt-4o',
    cheapModel: 'gpt-4o-mini',
  },
};

/**
 * edge-rows — ARCHIVE-ONLY so far (DEC-12): the deliberately unparseable line
 * cannot live in an HTTP page (must be valid JSON), so it lives in the archive
 * envelope scenario. HTTP pages + expected goldens for this scenario arrive
 * with the slice-4 analyze tests that consume it (orphan/missing-traceId/
 * GUARDRAIL/EVALUATOR tree `skipped` lists and the redaction golden).
 */
export const EDGE_ROWS: ScenarioCounts = {
  id: 'edge-rows',
  projectId: 'prj-edge',
  observationPages: 0,
  scorePages: 0,
  observationRowLines: 8, // 7 valid envelopes + 1 deliberately unparseable line
  uniqueObservationRows: 7, // one row has no traceId at all
  duplicateObservationIds: [],
  scoreRows: 2,
  traces: 3, // valid rows: tr_edge_1, tr_edge_orphan (orphan), tr_edge_2
  taskKeys: ['edge_task', 'orphan_task'],
  agents: ['edge-agent', 'edge-agent-2', 'orphan-agent'],
  window: { from: '2025-08-15T00:00:00.000Z', to: '2025-08-16T00:00:00.000Z' },
  ingestAt: '2025-08-15T12:00:00.000Z',
  archiveCorruptLines: [8],
};

/** Every committed scenario, keyed by fixture dir id. */
export const SCENARIOS: Record<string, ScenarioCounts> = {
  [REFUNDS.id]: REFUNDS,
  [EDGE_ROWS.id]: EDGE_ROWS,
};
