# PD-001 · 03 — Program design

> Stage 3 — the **contract** the builder ships against. Types and signatures only, no
> function bodies. Consistent with `01-product.md` (product) and
> `02-architecture.md` (components, CLI surface, store layout, failure modes). Where
> this document and 02 disagree, 03 wins for the builder — flag the disagreement as a
> `[DESIGN DEVIATION]`, never silently resolve it.
>
> Numbered `[DEC-nn]` markers are pre-committed decisions the builder must follow
> without re-deriving. Values marked `[PROPOSED]` are exact defaults, centralised in
> one constants module so a human can veto them in one edit.

## File layout

Repo is created fresh (currently design docs only). The
layout mirrors 02's component table one-to-one; every runtime module imports only
`node:` builtins and sibling modules (enforced by `npm run check:runtime-deps`).

```
canon/
├── package.json                  # "type":"module", bin {canon: dist/cli.js}, dependencies: {} (empty)
├── tsconfig.json                 # strict, NodeNext, target ES2023, noEmit for typecheck
├── tsup.config.ts                # entry src/index.ts + src/cli/main.ts, format esm, target node20, sourcemap
├── vitest.config.ts
├── eslint.config.js              # flat config, typescript-eslint, no-any ban
├── scripts/
│   └── check-runtime-deps.mjs    # gate: scans src imports; only node: allowed (devDeps may import freely)
├── src/
│   ├── index.ts                  # public library entry: createCanon + exported types
│   ├── cli/
│   │   ├── main.ts               # shebang; argv → dispatch → exit code
│   │   ├── args.ts               # tiny hand-rolled parser (no dep): verbs + flags table
│   │   └── commands/             # one file per verb group (see 02 API table)
│   │       ├── connect.ts ingest.ts analyze.ts proposals.ts
│   │       ├── governance.ts canonShow.ts exportCmd.ts auditExport.ts
│   │       ├── metricsCmd.ts statusCmd.ts
│   ├── core/
│   │   ├── errors.ts             # CanonError + codes + exit-code mapping [DEC-02]
│   │   ├── id.ts                 # newId/ruleKeyFrom [DEC-01]
│   │   ├── time.ts               # IsoTime, Clock injection, window math
│   │   ├── validators.ts         # lenient field parsers (never zod) [DEC-04]
│   │   └── redact.ts             # deterministic redactor (ingest- and view-time)
│   ├── trace/
│   │   ├── types.ts              # LfObservationRow/LfScoreRow/LfPage (Langfuse-shaped, tolerant)
│   │   ├── traceSource.ts        # TraceSource interface (source-agnostic)
│   │   └── langfuse/
│   │       ├── http.ts           # fetch wrapper: Basic auth, retries, Retry-After, redirects off
│   │       ├── client.ts         # projects/observations v2/scores v3 call builders
│   │       └── normalize.ts      # page → Envelope rows
│   ├── store/
│   │   ├── index.ts              # CanonStore facade (open/lock/config/status) — sole public face
│   │   ├── jsonl.ts              # streaming append + tolerant line reader
│   │   ├── atomics.ts            # tmp+rename+fsync+chmod helpers
│   │   ├── lock.ts               # O_EXCL lock w/ PID stale detection
│   │   ├── archive.ts            # observation/score JSONL + dedupe + index lines
│   │   ├── proposals.ts          # proposal lifecycle + decay sweep
│   │   ├── policies.ts           # versioned canon store
│   │   └── audit.ts              # append event, monotonic seq, read fold
│   ├── ingest/
│   │   ├── sync.ts               # windowing, cursors, checkpoint, resume, idempotency
│   │   └── watermark.ts          # from/to window bookkeeping (obs vs scores)
│   ├── analyze/
│   │   ├── tree.ts               # rebuild trees from rows (traceId + parent + isRoot)
│   │   ├── decisions.ts          # structural decision extraction (tool choice/retry/failure/model)
│   │   ├── profiles.ts           # agent profiles (runs, outcomes, tools, cost)
│   │   └── divergence.ts         # same taskKey, cross-agent + over-time comparisons
│   ├── propose/
│   │   ├── kinds.ts              # RuleKind registry: labels + fact→rule mapping (no numbers — see ScoringConstants)
│   │   ├── scoring.constants.ts  # ALL [PROPOSED] numbers live here
│   │   ├── scoring.ts            # confidence + coverage math (deterministic)
│   │   ├── templates.ts          # rule text builders — structural tokens only [DEC-07]
│   │   ├── candidates.ts         # facts → candidates (circuit breaker per run)
│   │   └── contradictions.ts     # new proposal vs canon/pending conflict check
│   ├── governance/
│   │   └── gate.ts               # promote/reject/edit validation + policy creation
│   ├── export/
│   │   ├── guardRules.ts         # guard-rules v1 writer + inline schema const
│   │   ├── auditReport.ts        # compliance report (json|md)
│   │   └── schema-guard-rules-v1.ts   # JSON Schema (draft-07) used by tests + consumers
│   └── app.ts                    # CanonApp: wires store + source + commands (CLI calls this)
├── tests/
│   ├── fixtures/                 # COMMITTED fixture corpus — realistic Langfuse v4 pages (rows, not legacy trace JSON)
│   │   ├── langfuse-http/        # raw recorded API responses per scenario
│   │   │   └── <scenario>/{projects.json, observations/pages/*.json, scores/pages/*.json}
│   │   ├── archive/              # pre-ingested envelope JSONL per scenario (analyze/propose tests)
│   │   ├── scenarios.ts          # single source of truth: builds scenario corpus + expected artifacts
│   │   ├── expected/             # golden trees.json, proposals.json, guardrules.json, audit digest
│   │   └── fakeLangfuseServer.ts # in-process node:http server replaying fixtures (429/5xx injectable)
│   ├── unit/                     # per-module tests (colocated naming: <module>.test.ts)
│   ├── integration/              # store + ingest + analyze/propose over fixture archives
│   └── e2e/                      # full CLI walk in a temp dir (see 04 Slice 7)
```

Why there: core is dependency-free and import-pure so unit tests are trivial;
`store/` is one boundary so "where state lives" has a single answer; `trace/` isolates
the only Langfuse-shaped code behind `TraceSource` (02: source swap = Medium cost);
fixtures are *committed* so `--live` is never required for green tests (product open
question 2).

## Types & contracts

> No function bodies. Default parameter values are part of signatures. All types are
> exported from `src/index.ts` for library consumers.

### core/time.ts

```ts
export type IsoTime = string;            // RFC3339 UTC, ms precision, always 'Z'
export type Clock = () => IsoTime;

export function nowIso(clock?: Clock): IsoTime;
export function parseIso(t: IsoTime): number;                 // epoch ms; CanonError('validation')
export function toIso(epochMs: number): IsoTime;
export function addDays(t: IsoTime, days: number): IsoTime;
export function addHours(t: IsoTime, hours: number): IsoTime;
export function compare(a: IsoTime, b: IsoTime): number;      // epoch compare
export function clampFrom(t: IsoTime | undefined, fallback: IsoTime): IsoTime;
```

### core/id.ts

```ts
export type IdKind = 'prop' | 'pol' | 'run' | 'evt' | 'trace' | 'obs';
export function newId(kind: IdKind): string;                  // `${kind}_` + 8 hex chars
export function ruleKeyFrom(parts: Array<string | undefined>): string; // kebab, stable lowercase, deduped
```

### core/errors.ts — [DEC-02]

```ts
export type CanonErrorCode =
  | 'usage' | 'not-connected' | 'not-found' | 'invalid-state' | 'validation'
  | 'source-down' | 'rate-limited' | 'auth-failed' | 'timeout'
  | 'store-corrupt' | 'locked' | 'io' | 'internal';

export class CanonError extends Error {
  readonly code: CanonErrorCode;
  readonly retryable: boolean;      // true only for source-down|rate-limited|timeout
  readonly hint?: string;           // actionable one-liner for stderr
  readonly exitCode: 1 | 2;         // usage → 2, everything else → 1
  constructor(msg: string, opts: { code: CanonErrorCode; hint?: string; cause?: unknown });
}

export function isCanonError(e: unknown): e is CanonError;
export function fail(e: unknown): never;  // rethrow non-CanonError as CanonError('internal', {cause: e})
```

### core/validators.ts — [DEC-04]

```ts
// Lenient by design: only guarantee the fields canon consumes; extra keys pass through.
export function asObject(v: unknown, label: string): Record<string, unknown>;   // CanonError('validation')
export function asString(v: unknown, label: string): string;
export function asOptionalString(v: unknown): string | undefined;
export function asStringArray(v: unknown): string[];
export function asOptionalIso(v: unknown): IsoTime | undefined;                 // undefined when absent OR malformed (warn once, lenient)
```

### core/redact.ts — [DEC-06]

```ts
export type ContentKind = 'input' | 'output' | 'comment' | 'metadata' | 'statusMessage';
export interface RedactorOptions { enabled: boolean; digestPrefix?: string }   // digestPrefix default 'redacted'
export interface Redactor {
  (text: string | undefined, kind: ContentKind): string | undefined; // '[redacted:<sha256(text).slice(0,8)>]' when enabled
  scrubJson(v: unknown, kind: ContentKind): unknown;                 // deep scrub of strings in object/array
  hash(v: string): string;                                           // stable, exportable — used for evidence digests
}
export function createRedactor(opts?: RedactorOptions): Redactor;
```

### trace/types.ts — Langfuse v4 shape (tolerant)

```ts
export type ObservationType =
  | 'SPAN' | 'GENERATION' | 'EVENT' | 'AGENT' | 'TOOL' | 'CHAIN'
  | 'RETRIEVER' | 'EVALUATOR' | 'EMBEDDING' | 'GUARDRAIL' | (string & {});
export type Level = 'DEBUG' | 'TRACE' | 'INFO' | 'WARN' | 'ERROR' | 'DEFAULT' | (string & {});
export type FieldGroup = 'core' | 'basic' | 'time' | 'io' | 'metadata' | 'model'
                       | 'usage' | 'prompt' | 'metrics' | 'trace_context';

export interface LfObservationRow {                       // field groups = requested via fields=
  id: string; traceId: string; projectId: string;         //   core (always present)
  type: ObservationType;
  name?: string; level?: Level; statusMessage?: string;   //   basic
  version?: string; environment?: string; bookmarked?: boolean; public?: boolean;
  userId?: string; sessionId?: string; isRootObservation?: boolean;
  startTime?: IsoTime; endTime?: IsoTime;                 //   core
  completionStartTime?: IsoTime; createdAt?: IsoTime; updatedAt?: IsoTime;  // time
  parentObservationId?: string | null;                    //   core — null = no physical parent
  input?: string; output?: string;                        //   io — RAW STRINGS
  metadata?: unknown;
  model?: string; internalModelId?: string; modelParameters?: Record<string, unknown>;
  inputPrice?: string; outputPrice?: string; totalPrice?: string;    // model — string decimals
  usageDetails?: { input?: number; output?: number; total?: number }; // usage
  inputUsage?: number; outputUsage?: number; totalUsage?: number;
  costDetails?: { input?: number; output?: number; total?: number };
  inputCost?: number; outputCost?: number; totalCost?: number;
  usagePricingTierName?: string;
  latency?: number; timeToFirstToken?: number;            // metrics
  tags?: string[]; release?: string; traceName?: string;  // trace_context
  [k: string]: unknown;                                   // unknown keys preserved verbatim
}

export type ScoreDataType = 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL' | 'TEXT' | 'CORRECTION';
export type ScoreSource = 'API' | 'ANNOTATION' | 'EVAL';
export interface LfScoreRow {
  id: string; projectId?: string; traceId?: string;       // traceId mirrored at top level when TRACE subject
  name: string; dataType?: ScoreDataType; value?: unknown;
  comment?: string; source?: ScoreSource; configId?: string; authorUserId?: string;
  timestamp?: IsoTime; environment?: string;
  subject?: { kind: 'TRACE' | 'OBSERVATION' | 'SESSION' | 'EXPERIMENT'; id: string; traceId?: string };
  [k: string]: unknown;
}

export interface LfPage<T> { data: T[]; meta?: { cursor?: string | null; [k: string]: unknown } }
// cursor contract: end of stream ⇔ cursor null | undefined | ''  [DEC-03]

export interface ProjectInfo { id: string; name: string; }
```

### trace/traceSource.ts

```ts
export interface TimeWindow { from: IsoTime; to: IsoTime }          // from inclusive, to exclusive [DEC-08]
export interface ObsQuery  { projectId: string; window: TimeWindow; fields?: FieldGroup[];
                             limit?: number; environment?: string[]; }
export interface ScoreQuery { projectId: string; window: TimeWindow; limit?: number;
                              environment?: string[]; }

export interface TraceSource {
  readonly kind: string;                                  // 'langfuse-v4' | test double name
  listProjects(): Promise<ProjectInfo[]>;
  queryObservations(q: ObsQuery, cursor?: string): Promise<LfPage<LfObservationRow>>;
  queryScores(q: ScoreQuery, cursor?: string): Promise<LfPage<LfScoreRow>>;
  close?(): Promise<void>;
}
```

### trace/langfuse (adapter internals)

```ts
export interface HttpConfig { requestTimeoutMs?: number; maxRetries?: number;
                              retryBaseMs?: number; minIntervalMs?: number; }  // [PROPOSED] 30_000/5/1_000/0
export interface LangfuseSourceOptions { baseUrl: string; publicKey: string; secretKey: string;
                                         http?: HttpConfig; clock?: Clock; }

export function createLangfuseSource(opts: LangfuseSourceOptions): TraceSource;

// internal helpers (exported for tests only)
export async function getWithRetry(path: string, init: { headers: HeadersInit },
                                   cfg: HttpConfig & { clock: Clock }): Promise<unknown>;
//   - Basic auth header set here; 401/403 → CanonError('auth-failed', retryable:false)
//   - 429 → honour Retry-After (seconds | HTTP-date) + backoff; CanonError('rate-limited') when exhausted
//   - 5xx/network → backoff, maxRetries, then CanonError('source-down')
//   - redirect: 'error' [DEC-05]
export function observationsUrl(q: ObsQuery, cursor?: string): URL;
export function scoresUrl(q: ScoreQuery, cursor?: string): URL;
export function parsePage<T>(raw: unknown, label: string): LfPage<T>;   // lenient [DEC-03]
```

### store facade + files

```ts
export interface CanonConfig {
  schema: 'canon/config/v1';
  connection: { host: string; baseUrl: string; projectId: string;
                publicKey: string; secretKey: string; connectedAt: IsoTime; };
  settings: {
    environment: string[];
    redact: { ingest: boolean; views: boolean };            // [PROPOSED] false, true
    operator: { name?: string };                             // default reviewer handle — used when --as / CANON_OPERATOR are absent
    sync: { incrementalOverlapHours: number; backfillWindowDays: number; politeDelayMs: number }; // 24/1/0
    http: { requestTimeoutMs: number; maxRetries: number; retryBaseMs: number };  // 30000/5/1000
    decay: { proposalTtlDays: number };                      // 90
    analysis: { minTraces: number; maxProposalsPerRun: number };  // group floor 3; kind floors live in ScoringConstants
  };
}

export interface CanonStore {
  readonly dir: string;
  open(): Promise<void>;                 // mkdir -p, perm audit, stale-lock cleanup
  close(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;     // throws CanonError('locked') on contention
  readConfig(): Promise<CanonConfig | undefined>;    // undefined when not connected
  writeConfig(cfg: CanonConfig): Promise<void>;      // atomic tmp+rename, chmod 0600
  appendObservationRows(rows: Array<Envelope<LfObservationRow>>): Promise<{ appended: number; dupes: number }>;
  appendScoreRows(rows: Array<Envelope<LfScoreRow>>): Promise<{ appended: number; dupes: number }>;
  rebuildIndex(): Promise<IndexData>;                 // O(rows) scan of archive
  readIndex(): Promise<IndexData>;                    // rebuild+write when missing/corrupt [DEC-09]
  traceLines(traceId: string): Promise<Array<{ line: number; row: LfObservationRow }>>;
  readSyncState(): Promise<SyncState | undefined>;
  writeSyncState(s: SyncState): Promise<void>;        // atomic
  listProposals(status?: ProposalStatus | 'all'): Promise<Proposal[]>;
  saveProposal(p: Proposal): Promise<void>;           // atomic write
  loadProposal(id: string): Promise<Proposal | undefined>;
  appendAudit(e: AuditEvent): Promise<void>;          // seq = last + 1, under lock
  readAudit(): Promise<AuditEvent[]>;
  writePolicy(p: Policy): Promise<void>;              // canon/<ruleKey>.v<N>.json, atomic, immutable-once-written
  listPolicies(): Promise<Policy[]>;
  status(): Promise<StoreStatus>;                     // integrity report for `canon status`
}

export interface Envelope<T> { v: 1; kind: 'observation' | 'score';
  fetchedAt: IsoTime; projectId: string; source: string; page: number; row: T; }

export interface IndexData { schema: 'canon/index/v1'; builtAt: IsoTime; projectId: string;
  traceCount: number; observationCount: number;
  traces: Record<string, TraceSummary>; observations: Record<string, { line: number }>; }
export interface TraceSummary { rootObservationId?: string; agentId?: string; taskKey: string;
  environment?: string; startTime?: IsoTime; endTime?: IsoTime;
  outcome: Outcome; lineFrom: number; lineTo: number; }

export interface SyncState { schema: 'canon/sync/v1'; projectId: string; mode: 'backfill' | 'incremental';
  completedWindows: Array<{ from: IsoTime; to: IsoTime; rows: number }>;
  observationWatermark: IsoTime | null;   // next incremental fromStartTime
  scoreWatermark: IsoTime | null;         // next incremental fromTimestamp (score time)
  lastRun?: { at: IsoTime; pages: number; newRows: number; dupes: number; aborted?: boolean }; }
```

### Audit — [DEC-10]

```ts
export type AuditType = 'connect' | 'ingest.page' | 'ingest.complete' | 'analysis.run'
  | 'proposal.created' | 'proposal.decayed' | 'governance.promote' | 'governance.reject'
  | 'policy.created' | 'export.run' | 'config.changed';
export interface AuditEvent { seq: number; at: IsoTime; actor: string;   // actor: 'system' | reviewer handle
  type: AuditType; projectId: string; payload: Record<string, unknown>; } // ids/counts/times ONLY [DEC-11]
```

### Analyze domain

```ts
export type Outcome = 'success' | 'failure' | 'unknown';
export interface ObservationNode { row: LfObservationRow; children: ObservationNode[]; }
export interface TraceTree { traceId: string; rootObservationId?: string;
  agentId?: string; taskKey: string; environment?: string; sessionId?: string; userId?: string;
  startTime?: IsoTime; endTime?: IsoTime; outcome: Outcome;
  nodes: ObservationNode[]; scores: LfScoreRow[]; }      // scores attached by subject [DEC-12]
export interface TreeReport { trees: TraceTree[]; skipped: Array<{ reason: 'orphan-row' | 'missing-traceId' | 'unparseable'; rowId?: string }>; }

export function rebuildTrees(rows: LfObservationRow[], scores: LfScoreRow[]): TreeReport;
//   tree grouping by traceId; parent linkage via parentObservationId; roots = no physical parent OR isRootObservation=true

export function inferOutcome(nodes: ObservationNode[]): Outcome;
//   'failure' ⇔ any node level ERROR or non-empty statusMessage on AGENT/TOOL/CHAIN; else 'success'; ambiguity → 'unknown'

export interface DecisionFact { kind: FactKind; traceId: string; observationIds: string[];
  agentId?: string; taskKey: string; environment?: string; outcome: Outcome;
  tools: string[]; model?: string; level?: Level; attempts?: number; at: IsoTime; }
export type FactKind = 'tool_choice' | 'side_effect_retry' | 'retry_budget' | 'failure' | 'model_usage';
// fact kinds are per-trace observations; rule kinds (policy candidates) are their 1:n generalisation,
// resolved in candidates.ts (fact 'side_effect_retry' on a side-effecting tool ⇒ rule
// 'side-effect-retry'; same fact on a benign tool ⇒ rule 'retry-budget'; fact 'failure' ⇒ rule
// 'failure-escalation'; tool_choice/model_usage map 1:1).
export function extractDecisions(tree: TraceTree): DecisionFact[];
//   tool_choice: AGENT/CHAIN node whose TOOL children differ from peers (per taskKey)
//   side_effect_retry / retry_budget: repeated same-tool children under one AGENT within windowSeconds
//   failure: ERROR/statusMessage nodes with their tool + parent chain
//   model_usage: GENERATION nodes (model + usageDetails + cost) under an AGENT

export interface AgentProfile { agentId: string; runs: number; outcomes: Record<Outcome, number>;
  tools: Map<string, number>; tasks: Set<string>; environments: Set<string>;
  firstSeen?: IsoTime; lastSeen?: IsoTime; totalCost?: number; }
export function buildProfiles(trees: TraceTree[]): AgentProfile[];

export interface DivergenceGroup { taskKey: string; environment?: string;
  trees: TraceTree[]; agents: Set<string>; outcomeSplit: Record<Outcome, number>; }
export function divergenceGroups(trees: TraceTree[]): DivergenceGroup[];
//   group key = taskKey + environment [DEC-13]; every tree belongs to ≥1 group (singleton groups exist);
//   groups below settings.analysis.minTraces never reach buildCandidates (app-level filter)
```

### Reports (app-level return values)

```ts
export interface IngestReport { projectId: string; mode: 'backfill' | 'incremental';
  windows: number; pages: number; newRows: number; dupes: number;
  from?: IsoTime; to?: IsoTime; durationMs: number; aborted?: boolean; }
export interface AnalysisReport { projectId: string; runId: string;
  trees: number; skipped: number; facts: number; agents: number;
  divergenceGroups: number; proposed: number; decayed: number; }
export interface StoreStatus { dir: string; connected: boolean; configPermOk: boolean;
  archive: { observations: number; scores: number }; indexFresh: boolean;
  lastRun?: SyncState['lastRun']; lockHeld: boolean;
  proposalsByStatus: Record<ProposalStatus, number>; policies: number; }
export interface AuditDigest { schema: 'canon/audit/v1'; projectId: string; generatedAt: IsoTime;
  events: number; connectAt?: IsoTime; promoteCount: number; rejectCount: number;
  policyChain: Array<{ ruleKey: string; version: number; ratifiedBy: string; ratifiedAt: IsoTime;
    originProposalId: string; evidenceTraceIds: number }>; }   // compliance export payload

### Propose

```ts
export type RuleKind = 'tool-choice' | 'side-effect-retry' | 'retry-budget'
                     | 'failure-escalation' | 'model-usage';
// kinds.ts: the registry RuleKind → { label, factMapping, suggestedSeverity } — labels and
// fact→rule mapping only. ALL numeric floors/bonuses live in ScoringConstants (scoring.constants.ts),
// the single home for [PROPOSED] numbers; do not duplicate them in kinds.ts.
// [PROPOSED] suggested severity is 'advisory' for every kind — mandatory is a HUMAN decision at
//            promote (via --set severity=mandatory); canon itself carries the ratified severity.

export type Severity = 'mandatory' | 'advisory';
export type ProposalStatus = 'pending' | 'ratified' | 'rejected' | 'decayed';

// ScoringConstants: the single home for every [PROPOSED] number an implementer might invent.
// DEFAULT_SCORING_CONSTANTS lives in scoring.constants.ts and is the only constants export the
// rest of the code reads. Divergence-group formation uses settings.analysis.minTraces (group floor,
// default 3); kind-specific floors below gate proposal EMISSION per kind.
export interface ScoringConstants {
  minTracesByKind: Record<RuleKind, number>;      // [PROPOSED] tool-choice 5 · side-effect-retry 5 · retry-budget 4 ·
                                                  //   failure-escalation 8 · model-usage 8 — v0.1 tool-choice floor is 4:
                                                  //   superseded by ADR-0004 DEC-24 (floor constants live in core/constants.ts)
  baseConfidenceByKind: Record<RuleKind, number>; // [PROPOSED] failure-escalation 8 · model-usage 8 (see default below)
  perTraceBonus: number;                          // [PROPOSED] +0.05 per supporting trace over the kind minimum (cap +0.2)
  perAgentBonus: number;                          // [PROPOSED] +0.10 per additional distinct agent over 1 (cap +0.3)
  scoreCorroborationBonus: number;                // [PROPOSED] +0.05 when ≥1 score (NUMERIC/BOOLEAN) supports the pattern
  minConsistency: number;                         // [PROPOSED] 0.6 — share of group traces following the pattern; below it ⇒ drop
  singleAgentCap: number;                         // [PROPOSED] 0.5 — single-agent proposals never score above this
  globalCap: number;                              // [PROPOSED] 0.95 — absolute ceiling
}
export const DEFAULT_SCORING_CONSTANTS: ScoringConstants;
// [PROPOSED] human veto list (defaults): minTracesByKind {tool-choice 5, side-effect-retry 5,
//   retry-budget 4, failure-escalation 8, model-usage 8}; baseConfidenceByKind {0.40, 0.45, 0.50,
//   0.30, 0.35}; perTraceBonus 0.05 (cap +0.2); perAgentBonus 0.10 (cap +0.3);
//   scoreCorroborationBonus 0.05; minConsistency 0.6; singleAgentCap 0.5; globalCap 0.95
// NOTE: the tool-choice floor above (5) is SUPERSEDED for v0.1 — ADR-0004 DEC-24 moved it to 4
//   (the shipped floors live in src/core/constants.ts, imported by scoring.constants.ts)

export interface EvidenceLink { traceId: string; observationIds: string[]; role: 'supporting' | 'divergent'; }
export interface Coverage { traces: number; observations: number; agents: number; sessions: number;
  window: TimeWindow; environments: string[]; consistency: number; }     // consistency ∈ [0,1]
export interface Proposal { id: string; ruleKey: string; kind: RuleKind; status: ProposalStatus;
  severity: Severity;                       // suggested — human may change on promote --edit
  title: string; ruleText: string;          // template-built, structural tokens only [DEC-07]
  assertion: string;                        // human-readable invariant sentence
  constraints: GuardConstraints;            // machine-readable guard conditions (see export type)
  confidence: number; coverage: Coverage; evidence: EvidenceLink[];
  conflictsWith: Array<{ id: string; kind: 'canon' | 'proposal'; reason: string }>;
  createdAt: IsoTime; updatedAt: IsoTime; reviewedAt?: IsoTime; reviewedBy?: string;
  reviewAction?: 'promote' | 'reject'; reviewNote?: string; decayedAt?: IsoTime;
  origin: { runId: string; analyzerVersion: string }; }

export function computeConfidence(facts: DecisionFact[], coverage: Coverage,
                                  constants: ScoringConstants): number;
//   deterministic: baseConfidenceByKind[kind] + per-trace/per-agent/score bonuses,
//   clamp [0, globalCap]; coverage.consistency < minConsistency ⇒ buildCandidates drops the candidate
//   (not scored here); agents===1 ⇒ cap ≤ singleAgentCap (SOMA-style single-agent caution)
export function computeCoverage(g: DivergenceGroup): Coverage;
export function buildCandidates(facts: DecisionFact[], groups: DivergenceGroup[],
                                existing: Proposal[], policies: Policy[],
                                constants: ScoringConstants): Proposal[];
//   candidate dedupe by ruleKey; per-run circuit breaker maxProposalsPerRun, best-confidence first;
//   dropped candidates counted into audit payload
export function checkContradictions(candidate: Proposal, existing: Proposal[],
                                    policies: Policy[]): Proposal['conflictsWith'];
export function fillRuleText(kind: RuleKind, g: DivergenceGroup, opts: { tools: string[];
  model?: string; attempts?: number }): { title: string; ruleText: string; assertion: string };
```

### Governance

```ts
export interface PromoteOptions { actor: string; note?: string;
  edit?: { severity?: Severity; ruleText?: string; assertion?: string; constraints?: GuardConstraints }; }
export interface PromoteResult { proposalId: string; policyId: string; ruleKey: string; version: number;
  policyPath: string; createdAt: IsoTime; }
export function promote(p: Proposal, opts: PromoteOptions, store: CanonStore,
                        constants: { allowEditedRuleText?: boolean }): Promise<PromoteResult>;
//   validates status === 'pending'; actor required (non-empty, trimmed)
//   writePolicy is append-only per (ruleKey, version); a second proposal with the same ruleKey
//   ratifies as version+1 — previous policy file is never rewritten [DEC-14]
export function reject(p: Proposal, opts: { actor: string; reason: string },
                       store: CanonStore): Promise<{ proposalId: string; status: 'rejected'; at: IsoTime }>;
export function decaySweep(store: CanonStore, now: IsoTime,
                           constants: { proposalTtlDays: number }): Promise<Proposal[]>;
//   pending ∧ createdAt + TTL < now ⇒ status 'decayed' + audit 'proposal.decayed'; runs at start of
//   `analyze` and `proposals list` under lock [DEC-15]
```

### Policy + guard-rules export (v1)

```ts
export interface Policy { id: string; ruleKey: string; version: number; status: 'active';
  severity: Severity; ratifiedAt: IsoTime; ratifiedBy: string; originProposalId: string;
  ruleText: string; assertion: string; constraints: GuardConstraints;
  provenance: { confidence: number; coverage: Coverage; evidence: EvidenceLink[];
                proposalEdited: boolean; history: Policy[] }; }        // history = prior versions (chain)

export interface GuardConstraints { // kind-specific, vendor-neutral — enforcement plane decides semantics
  tool?: string; tools?: string[]; taskKeys?: string[]; environments?: string[];
  agents?: string[]; maxAttempts?: number; windowSeconds?: number; sideEffect?: boolean;
  modelFamily?: string[]; maxCostRatio?: number; minSuccessRate?: number; }

export interface GuardRulesPack {
  schema: 'canon/guard-rules/v1'; meta: { projectId: string; exportedAt: IsoTime;
    canonVersion: number; source: { tool: 'canon'; version: string }; };
  rules: Array<{ id: string; ruleKey: string; kind: RuleKind; severity: Severity; version: number;
    assertion: string; scope: { environments: string[]; agents: string[]; taskKeys: string[] };
    constraints: GuardConstraints; provenance: { proposalId: string; confidence: number;
    coverage: Coverage; evidence: EvidenceLink[]; ratifiedBy: string; ratifiedAt: IsoTime }; }>;
}

export function buildGuardRulesPack(policies: Policy[], meta: { projectId: string;
  exportedAt: IsoTime; canonVersion: number; toolVersion: string }): GuardRulesPack;
export function verifyEvidenceLinks(pack: GuardRulesPack, store: CanonStore): Promise<
  Array<{ ruleId: string; dangling: number }>>;      // used by `export --verify-links`
```

### Metrics reading points (01-product success criteria)

```ts
export interface MetricsResult { projectId: string; connectedAt: IsoTime | null;
  firstPromoteAt: IsoTime | null; ttrp: { ms: number } | null;           // null ⇒ 'no ratified policy yet'
  proposals: { total: number; pending: number; ratified: number; rejected: number; decayed: number };
  precision14: { numerator: number; denominator: number; ratio: number | null }; } // ratified ≤14 d after createdAt
export function computeMetrics(audit: AuditEvent[], proposals: Proposal[], now: IsoTime): MetricsResult;
```

### app.ts — library entry the CLI wraps

```ts
export interface CanonOptions { dir?: string; source?: TraceSource; clock?: Clock;
  redactor?: Redactor; configOverrides?: Partial<CanonConfig['settings']>; }
export interface CanonApp {
  connect(opts: { host: string; projectId: string; publicKey: string; secretKey: string;
                  environment?: string[]; redactIngest?: boolean; force?: boolean }): Promise<CanonConfig>;
  ingest(opts: { mode: 'backfill' | 'incremental'; from?: IsoTime; to?: IsoTime;
                 windowDays?: number; smallPages?: boolean; dryRun?: boolean }): Promise<IngestReport>;
  analyze(opts: { since?: IsoTime; environments?: string[] }): Promise<AnalysisReport>;
  proposals(opts: { status?: ProposalStatus | 'all'; kind?: RuleKind[] }): Promise<Proposal[]>;
  showProposal(id: string): Promise<Proposal>;
  promote(id: string, opts: PromoteOptions): Promise<PromoteResult>;
  reject(id: string, opts: { actor: string; reason: string }): Promise<Proposal>;
  showCanon(): Promise<Policy[]>;
  exportGuardRules(opts: { out?: string; verifyLinks?: boolean }): Promise<{ pack: GuardRulesPack; path?: string }>;
  exportAudit(opts: { format: 'json' | 'md'; out?: string }): Promise<{ path?: string; digest: AuditDigest }>;
  metrics(): Promise<MetricsResult>;
  status(): Promise<StoreStatus>;
}
export function createCanon(opts?: CanonOptions): CanonApp;
```

### Command layer (thin — CLI only)

```ts
export interface CommandCtx { app: CanonApp; args: Record<string, unknown>; redactViews: boolean; }
export type Command = (ctx: CommandCtx) => Promise<number>;   // resolved value = exit code
export const COMMANDS: Record<string, Command>;   // keyed by verb (+ subgroup) per 02 API table
```

## Decisions the agent might get wrong

Pre-committed so the builder does not improvise:

- **Naming.**
  - Files/modules: lowercase `camelCase.ts`; one default export per domain module when
    unambiguous, named exports everywhere else.
  - Runtime entities: ids `prop_…|pol_…|run_…|evt_…` (8 hex chars, `crypto.randomUUID`),
    `traceId`/`obs` ids are Langfuse's own and are **never rewritten**.
  - `ruleKey` = kebab of stable parts (kind + tool/task tokens), e.g.
    `side-effect-retry-charge-refund`; versions `v1, v2…`; policy filename
    `canon/<ruleKey>.v<N>.json`.
  - Schema strings on every persisted object: `canon/config/v1`, `canon/index/v1`,
    `canon/sync/v1`, `canon/guard-rules/v1`.
  - Env vars all `CANON_*` (`CANON_DIR`, `CANON_LANGFUSE_PUBLIC_KEY`,
    `CANON_LANGFUSE_SECRET_KEY`, `CANON_OPERATOR`).
- **Error handling convention** `[DEC-02]`: throw typed `CanonError`; never return
  error objects, never swallow. Only `parse*`/lenient readers degrade to
  skip-and-report. Codes map 1:1 to exit codes (02). CLI top-level prints exactly one
  stderr line `canon: error: <message>` (+ `hint:` when present) and exits — no
  stack traces unless `CANON_DEBUG=1`.
- **Logging convention** `[DEC-11]`: stdout = command output only; stderr =
  diagnostics/progress. `--verbose` gates page-level progress lines to stderr
  (`canon: ingest: page 3/9 (200 rows)`). **Keys and io content are never written to
  any log**; redactor runs before a payload string may reach a log line. No logging
  library — `console` + a 3-function `logger.ts` if needed.
- **Where state lives**: everything under the store dir resolved by `--dir`/`CANON_DIR`
  (default `.canon` of cwd). The library never writes elsewhere; command processes
  write only via `CanonStore` methods; config file 0600, dirs 0700.
- **Async + ordering**: all fs/network I/O promise-based; store is single-writer under
  `withLock`. Archive appends happen **before** the checkpoint that acknowledges them;
  audit appends happen **after** the state file it records is durable (atomic rename).
  `sync-state.json`/`index.json`/proposal/policy files are written by tmp-file +
  `fsync` + `rename` (never in-place). Checkpoints advance per completed page/window,
  never per whole run.
- **Explicitly off-limits** (from 01/02): runtime dependencies (npm `dependencies`
  must stay empty; `check:runtime-deps` gate), deprecated `/api/public/traces*` and
  legacy ingestion/scores endpoints, LLM/model calls, any enforcement or preflight
  runtime, any server/web surface, embedded DBs, SOMA source copying, io content
  interpolation into rule text `[DEC-07]`, anonymous promote/reject, keys in audit or
  export, `child_process` shell calls, non-UTC/local-time handling `[DEC-08]` (UTC +
  ms + `Z` everywhere; fixture times are fixed, never `new Date()`).
- **Ecosystem conventions**: ESM `.js` suffixes on relative imports (NodeNext);
  `import type` for type-only imports; `strict` + `noUncheckedIndexedAccess`, `any`
  banned (use `unknown` + narrowing). Tests live under `tests/`, one file per module
  under test; no test reaches the network (fixture server only) — `--live` runs are
  opt-in and *announce* themselves.
- **Determinism**: no wall clock inside logic — `Clock` injection only; iteration
  order always sorted (id/time); JSON output keys sorted; hashes sha256 via
  `node:crypto`.
- **`governance promote --edit` semantics** `[DEC-16]`: edits the working draft
  *before ratification* and are recorded in the `governance.promote` audit payload as
  a diff of edited fields. Interactive mode opens `$EDITOR` on a JSON draft when
  stdin is a TTY; otherwise (CI/scripts) edits come from repeatable
  `--set <field>=<value>` with fields limited to `severity|ruleText|assertion|note`
  (`constraints` are edited in the JSON draft only). Invalid field/value → exit 2.
  A promote with zero edits is identical to plain `promote`.

## Trade-offs considered

| Choice | Alternative | Why we chose this |
|---|---|---|
| File store (JSONL archive + JSON state under `.canon/`) | SQLite / embedded DB | **DB is banned by the product issue**; also file store is human-readable, git-inspectable, zero-dep, and the append-only archive maps exactly to the audit requirement. Query needs are index+scan at v0.1 scale (≤ ~500k rows `[ASSUMPTION]`); a DB buys little now and costs review/compliance transparency. |
| Native `fetch` + hand-rolled retry wrapper | `undici`/`axios`/`node-fetch` runtime dep | Node ≥ 20 ships a stable fetch; the retry/429/redirect logic is ours either way (an HTTP client does not provide Retry-After semantics); keeps `dependencies: {}` intact. |
| Hand-rolled arg parser (`cli/args.ts`) | `commander`/`cac` | Verb set is small, fixed, and documented in 02; a dep would be the only one and is not justified by ~8 verbs with flags; hand-rolled gives exact usage-error exit code 2 behaviour and zero surface. |
| Hand-rolled lenient validators | `zod` schemas | We must be **tolerant** of Langfuse schema growth (extra keys, new types) — strict schemas would fail ingestion on upstream additions; the consumed surface is ~30 fields, cheap to guard; keeps zero runtime deps. |
| Structural decision extraction (no LLM) | LLM summarisation of traces | 01 puts model work out of scope; structural rules are deterministic, offline, free, and audit-friendly — the exact properties a governance product needs. LLM "insight" can come in a later product stage behind the same fact interfaces. |
| JSONL per-entity records + derived index | SOMA-style Markdown+YAML-frontmatter entities | Canon stores bulk raw rows (thousands/trace run) — Markdown entities are wrong for that volume. Proposals/policies are JSON files (machine-governed); Markdown appears only in the human audit report at export time. |
| Config in `.canon/config.json` (0600) + env override | OS keychain only | Keychain needs a native dep and hurts CI scripting; file + env covers the single-operator v0.1; secrets never logged, never exported, `.canon/` gitignored. |
| Decay sweep at start of `analyze` + `proposals list` | Daemon/cron decay | v0.1 is CLI; decay on read/write boundaries keeps state live without background processes; `canon status` surfaces decayed counts. |
| Single store dir ⇒ single project | Multi-project per dir | 01 defines v0.1 as one project → first ratified policy; multi-project needs cross-project metrics and is deferred (dir per project is the migration path — trivially reversible). |

## Testing plan

- **Unit tests** (`tests/unit/*.test.ts`, vitest): pure logic with injected `Clock`.
  - `time/validators`: ISO parse/format round-trip, malformed input, lenient
    `asOptionalIso`; `errors`: code→exit-code mapping.
  - `id`: uniqueness, `ruleKeyFrom` stability/kebab/dedupe.
  - `redact`: determinism (same text ⇒ same digest), scrub of nested objects, off =
    pass-through, presence of raw text never in output; content kinds respected.
  - `tree`: fixture rows → exact trees (multi-root traces, `isRootObservation` vs
    orphan, missing parents → `skipped`); `inferOutcome` on ERROR/statusMessage cases
    incl. ambiguity.
  - `decisions`/`divergence`: each DecisionFact kind on a purpose-built fixture;
    divergence grouping by `taskKey+environment`, ≥ minTraces filter.
  - `scoring`: confidence formula pinned at constant boundaries (min, caps, single-agent
    cap ≤ 0.5, clamp 0.95); coverage counts; determinism (same input ⇒ same score).
  - `templates`: rule text contains **only** structural tokens — a fixture io string
    containing "password=…" must not appear in any template output (this is the test
    that protects `[DEC-07]`).
  - `contradictions`: canon vs pending vs new overlap detection incl. inverse-polarity
    ruleKeys.
  - `governance`: promote on non-pending rejected; missing `actor` rejected; version
    bump on same ruleKey; policy file immutability (second write throws); decay sweep
    with frozen clock at TTL boundary.
  - `metrics`: hand-computed fixture audit → exact ttrp / precision14 incl. null and
    14-day-boundary cases (13 d counts, 15 d does not).
  - `args`: flag matrix incl. usage errors → exit code 2; `--json` output shape.
- **Integration tests** (`tests/integration/`): against `fakeLangfuseServer`
  replaying committed fixture pages.
  - Adapter: cursor walk to end; 429 with `Retry-After` then success (no extra calls
    before Retry-After); 5xx exhausting retries → `source-down`; 401 → `auth-failed`
    with zero retries; redirect to another origin fails closed; timeout path.
  - Ingest: backfill of N windows resumes from checkpoint after an injected failure on
    page k (rerun → identical final row count, dupes counted, no gaps/overlaps in
    windows); incremental overlap absorbs late rows; scores polled on score-time
    watermark; `--dry-run` writes nothing.
  - Store: torn trailing JSONL line tolerated + flagged; index rebuild reproduces a
    golden `IndexData`; atomic rename leaves no partial state on simulated ENOSPC;
    lock contention → `locked` error; stale-lock takeover by PID.
  - Analyze/propose on pre-ingested fixture archives: proposal set matches `expected/`
    golden (ids differ by runId only — compare on ruleKey/kind/coverage); per-run
    circuit breaker caps proposals.
  - Export: `buildGuardRulesPack` output validates against the committed JSON Schema;
    `--verify-links` detects dangling evidence when an archive row is removed.
- **E2E check** (`tests/e2e/`, see 04 Slice 7): spawn the built `dist/cli.js` in a
  temp dir against `fakeLangfuseServer` and run the full product happy path
  connect → ingest → analyze → proposals list → promote → canon show → export →
  audit export → metrics; assert audit chain, golden guard-rule pack, TTRP value, and
  that `.canon/` contains no key material.
- **Determinism/CI posture**: fixtures use fixed ISO timestamps; no test reads the
  wall clock except via injected `Clock`; tests never touch the network (server is
  in-process); any future `--live` test is skipped-and-announced unless
  `CANON_LIVE=1`. Money/date traps are covered explicitly (string cost decimals
  parsed only at thresholds; naive-`Date` usage banned by typecheck review).
- **Gates** (name them in 04 DoD): `npm run typecheck`, `npm run lint`,
  `npm run test`, `npm run build`, `npm run check:runtime-deps` — all five must pass
  locally before a PR; QA additionally reproduces them from a clean checkout.
