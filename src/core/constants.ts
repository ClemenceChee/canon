/**
 * Single home for every `[PROPOSED]` numeric/behaviour default an implementer
 * might otherwise invent (ADR-0001, 03-program-design). A human can veto any
 * value here in one edit. Values NOT marked [PROPOSED] are structural.
 *
 * Slice scope: slices 1-2 use the config/settings and HTTP defaults. The
 * proposal ScoringConstants ([PROPOSED] floors/bonuses) live in
 * propose/scoring.constants.ts and arrive with slice 5 per 03's layout.
 */

/** [PROPOSED] HTTP client defaults (03: HttpConfig 30_000 / 5 / 1_000 / 0). */
export const DEFAULT_HTTP_CONFIG = Object.freeze({
  requestTimeoutMs: 30_000,
  maxRetries: 5,
  retryBaseMs: 1_000,
  minIntervalMs: 0,
});

/** [PROPOSED] store settings defaults (03 CanonConfig, per-field markers). */
export const DEFAULT_SETTINGS = Object.freeze({
  environment: ['production'], // not [PROPOSED]-tagged in 03; 02's committed config example uses ["production"]
  redact: { ingest: false, views: true }, // [PROPOSED] false, true
  operator: { name: '' }, // empty by default; the reviewer handle resolves --as > CANON_OPERATOR > this value (SHOULD-2)
  sync: {
    incrementalOverlapHours: 24, // [PROPOSED]
    backfillWindowDays: 1, // [PROPOSED]
    politeDelayMs: 0, // [PROPOSED]
  },
  http: {
    requestTimeoutMs: DEFAULT_HTTP_CONFIG.requestTimeoutMs,
    maxRetries: DEFAULT_HTTP_CONFIG.maxRetries,
    retryBaseMs: DEFAULT_HTTP_CONFIG.retryBaseMs,
  },
  decay: { proposalTtlDays: 90 }, // [PROPOSED]
  analysis: { minTraces: 3, maxProposalsPerRun: 25 }, // [PROPOSED] group floor 3 (kind floors in ScoringConstants)
});

/** Langfuse read API caps (02 (c) table); not user-veto numbers. */
export const OBSERVATIONS_LIMIT_MAX = 1000;
export const SCORES_LIMIT_MAX = 100;

/** Field groups requested on observation reads (02: prompt group omitted in v0.1 [ASSUMPTION]). */
export const OBSERVATION_FIELDS = Object.freeze([
  'core',
  'basic',
  'time',
  'io',
  'metadata',
  'model',
  'usage',
  'metrics',
  'trace_context',
]);

/** On-disk names inside a canon store dir. */
export const STORE_FILES = Object.freeze({
  config: 'config.json',
  audit: 'audit.jsonl',
  lock: '.lock',
  archiveDir: 'archive',
  observations: 'observations.jsonl', // inside archive/ (02 layout)
  scores: 'scores.jsonl', // inside archive/
  proposalsDir: 'proposals',
  canonDir: 'canon',
  syncState: 'sync-state.json',
  index: 'index.json',
});

/** [PROPOSED] sync-engine chunking (03: --window-days; 02 windowed backfill). */
export const WINDOW_CHUNK_DAYS_DEFAULT = 1;
/** [PROPOSED] --small-pages halving floor — never halve the page limit below this. */
export const SMALL_PAGE_LIMIT_FLOOR = 10;

/**
 * Analyze/retry semantics (DEC-16/17): two calls to the SAME tool under one
 * AGENT/CHAIN run within this window count as a repeated call (a retry fact),
 * provided the retry window is respected.
 * [PROPOSED] retry window — repeated calls further apart are separate calls.
 */
export const RETRY_WINDOW_SECONDS_DEFAULT = 600;

/**
 * [PROPOSED] side-effecting tool names (DEC-17 "side-effect tool (e.g.
 * charge/reversal class)"). The Langfuse v2 row model carries no side-effect
 * marker, so v0.1 keeps the classification as a human-veto list in the single
 * constants home (same veto discipline as every [PROPOSED] default). A
 * repeated call to a listed tool yields a side_effect_retry fact; any other
 * repeated call yields a retry_budget fact (03 fact→rule mapping) which v0.1
 * never emits as a candidate (DEC-17 candidate kinds: tool-choice,
 * side-effect-retry, model-usage).
 */
export const SIDE_EFFECT_TOOLS: readonly string[] = Object.freeze(['charge-reversal']);

/**
 * Proposal emission floors — [PROPOSED] (ADR-0003 DEC-17: "Floors (traces per
 * taskKey group): tool-choice 4, side-effect-retry 5, model-usage 8"). The
 * tool-choice floor of 4 SUPERSEDES the 03-program-design veto-list's "5"
 * (ADR-0004 DEC-24 — 03:421-424 was never amended; the ADR + this constant
 * are authoritative). These gate candidate EMISSION per kind; the full
 * ScoringConstants (base confidence, bonuses, caps) live in
 * propose/scoring.constants.ts, which imports these numbers rather than
 * duplicating them (03: scoring numbers in one home; ADR: floors in
 * core/constants.ts).
 */
export const PROPOSAL_MIN_TRACES_TOOL_CHOICE = 4;
export const PROPOSAL_MIN_TRACES_SIDE_EFFECT_RETRY = 5;
export const PROPOSAL_MIN_TRACES_MODEL_USAGE = 8;

/**
 * [PROPOSED] emission gates (DEC-17): minConsistency 0.6 = fraction of group
 * agents exhibiting the pattern; single-agent confidence cap 0.5; absolute
 * confidence ceiling 0.95. (max 25 proposals per run lives in
 * settings.analysis.maxProposalsPerRun.)
 */
export const PROPOSAL_MIN_CONSISTENCY = 0.6;
export const PROPOSAL_SINGLE_AGENT_CONFIDENCE_CAP = 0.5;
export const PROPOSAL_GLOBAL_CONFIDENCE_CAP = 0.95;

/** Directory/file permission bits (02 security & permissions). */
export const PERMS = Object.freeze({
  dir: 0o700,
  configFile: 0o600,
  /** audit.jsonl + archive JSONLs hold sensitive content → 0600 regardless of umask. */
  dataFile: 0o600,
});

/** `canon --version` answers this; keep in sync with package.json "version". */
export const CANON_VERSION = '0.1.0';
