# PD-001 · 02 — Architecture

> Stage 2 of program design for **canon** (agent behaviour governance from Langfuse
> traces). Consistent with `01-product.md`: v0.1 is a CLI + library only — no server,
> no web UI, no enforcement runtime, no preflight authorizer. One Langfuse project per
> canon home directory, ending in a first human-ratified policy.
>
> Decisions that a human must confirm are tagged `[ASSUMPTION]`; proposed numeric
> defaults are `[PROPOSED]` (exact constants live in one module — see 03 — so they are
> trivial to veto and change).

## Context

- **Existing services and where this fits.** canon is a new standalone TypeScript/Node
  CLI product (`github.com/ClemenceChee/canon`), created inside a
  software-factory workspace. It consumes the **Langfuse
  public API** of an existing observability deployment (Cloud or self-hosted OSS server
  v4) as its only external dependency at runtime, and writes a zero-dependency,
  file-based governance store (`.canon/`) under the operator's working directory. It
  mirrors SOMA's *vault + governance* concepts (archive → proposals → ratified canon,
  evidence chains, decay, human promote/reject, policy bridge-style export) but is a
  **simpler, self-contained re-implementation**: SOMA code is proprietary and is not
  copied (CONTEXT.md); canon borrows vocabulary and shape only.
- **Constraints (compliance, cost, latency, team size).**
  - Stack fixed by the product issue: **TypeScript ESM on Node ≥ 20**, `tsup` build,
    `vitest` tests, **zero runtime dependencies** (native `fetch`/`node:` builtins
    only — an HTTP client dep was considered and rejected, see 03 trade-offs).
    **No embedded database** is allowed.
  - Trace data model is **observations-first (server v4)**: reads use
    `GET /api/public/v2/observations` and `GET /api/public/v3/scores` with cursor
    pagination and `startTime` windows. Deprecated `/api/public/traces*` reads are
    **out of scope** (Cloud sunset 2026-11-16; 404 on self-hosted v4). Ground-truth
    facts: `.research_langfuse/langfuse_trace_source_report.md` (git-excluded).
  - Team size: one operator + one reviewer role. No multi-tenant, no SSO/RBAC, no web
    queue in v0.1 (CLI review queue only).
  - Compliance posture: every ratified policy must carry a resolvable evidence chain
    and an audit line ("which policy, why, on what evidence, who approved"); the audit
    export must be producible on demand. Cost/latency budgets are irrelevant at CLI
    scale; the design favours determinism, auditability and zero external state.

## Components & flow

### Components (all in-process modules of the CLI/library; no new services are deployed)

| Component | Responsibility | Writes to |
|---|---|---|
| `cli` | arg parsing, command dispatch, exit codes, stdout/stderr discipline | — |
| `config` / `connect` | store/validate connection (host, projectId, keys); probe server v4 | `.canon/config.json` |
| `trace` (TraceSource) | interface for page-scrolling trace/score readers; pluggable per source | — |
| `langfuse-v4` adapter | HTTP client over v2 observations + v3 scores + `/projects`; cursor walk; backoff | — |
| `ingest` (sync) | windowed backfill/incremental pull, checkpointing, dedupe, resume | archive JSONL, sync-state |
| `store` | `.canon/` file store: JSONL archive + index + state files, atomic writes, lock, audit append | `.canon/**` |
| `analyze` | rebuild trace trees from rows; decision extraction; agent profiles; divergence scan | analysis events (audit), evidence |
| `propose` | candidate generation from divergence/pattern facts → proposals (confidence, coverage, evidence links, contradictions) | `proposals/` |
| `governance` | human promote/reject/edit; creates versioned canon policies | `canon/`, audit |
| `redact` | deterministic content scrubbing (ingest-time and view-time) | — |
| `export` | guard-rules JSON v1 writer; audit/compliance report writer | output files |
| `metrics` | reads audit + state to compute success-metric reading points | stdout (`canon metrics`) |

### Component diagram

```
                        ┌────────────────────────────────────────────────┐
                        │                 operator (human)               │
                        │  connect · ingest · analyze · proposals ·      │
                        │  governance promote/reject · canon show ·      │
                        │  export · audit export · metrics · status       │
                        └───────┬───────────────────────────────┬────────┘
                                │ CLI verbs (stdin/stdout/stderr)│ outputs
                                ▼                               ▼
   ┌──────────┐  HTTPS/Basic  ┌─────────────────────┐     .canon/ file store
   │ Langfuse │◄──────────────┤ langfuse-v4 adapter │     (zero-dep, file-based)
   │ server v4│   v2 obs      │  fetch wrapper:     │
   │ (Cloud / │   v3 scores   │  retry · Retry-After│  ┌─────────────────────────┐
   │ self-host)│  /projects   │  · timeouts · guard │  │ config.json  (0600)     │
   └──────────┘               └──────────┬──────────┘  │ archive/ obs+scores     │
                                         │ raw pages   │   observations.jsonl    │
                                         ▼             │   scores.jsonl          │
                              ┌─────────────────────┐  │ sync-state.json (ckpt)  │
                              │ ingest/sync         │  │ index.json              │
                              │ windows+cursor+dedupe│ │ proposals/*.json        │
                              └──────────┬──────────┘  │ canon/*.json            │
                                         ▼             │ audit.jsonl             │
                              ┌─────────────────────┐  └─────────────────────────┘
                              │ analyze             │
                              │ trees·decisions·    │  reads archive+index
                              │ profiles·divergence │───────┐
                              └──────────┬──────────┘       │
                                         ▼                  ▼
                              ┌─────────────────────┐   redact (view/export gate)
                              │ propose → candidates│
                              └──────────┬──────────┘
                                         ▼
                              ┌─────────────────────┐
                              │ governance gate     │  human promote/reject (CLI)
                              └──────────┬──────────┘
                                         ▼
                              canon/  →  export (guard-rules JSON v1, audit report)
```

### Data flow between components (one happy-path run)

```
connect ──validate/probe──► config.json            (record connectedAt → TTRP t0)
ingest ──v2 obs + v3 scores──► archive JSONL (append, envelope v1)
     └── checkpoint per completed window ──► sync-state.json   (resume-safe)
     └── dedupe against index; rebuild index.json at end of run
analyze ──rows──► rebuild trees (traceId + parentObservationId + isRootObservation)
     ──► decision facts (tool_choice, retries, failures, model/usage)   [structural, no LLM]
     ──► agent profiles + divergence scan (same taskKey, cross-agent & over time)
     ──► audit events (analysis.run, ingest.complete, proposal.created …)   [AuditType union in 03]
propose ──facts──► candidates ──score confidence/coverage──► proposals/*.json (status=pending)
     ──► contradiction check vs canon/ + pending; write audit proposal.created
human: canon proposals list/show (redacted by default) → governance promote|reject [--edit] [--as]
     promote ──► canon/<ruleKey>.v<N>.json (versioned policy) + audit governance.promote (TTRP t1)
canon show / export guardrules-json  ──►  vendor-neutral rule pack (schema canon/guard-rules/v1)
audit export ──► compliance report (policy → proposal → evidence traces)   [evidence resolvable]
metrics ──► reads audit + state ──► TTRP = t1 − t0 ; proposal precision (promote|reject per id, ≤14 d)
```

Every state mutation flows through the `store` layer, which appends to `audit.jsonl`
(audit is the compliance backbone) and writes state files via temp-file + atomic
rename under an advisory lock. Raw io content can be scrubbed at two independent
gates: **ingest time** (archive never receives content) and **view/export time**
(redaction is on by default for proposals, evidence and exports — belt and braces).

### Success-metric reading points (from 01-product.md — defined here so they have a home)

- **Metric 1 — TTRP.** `connect` writes an audit event `connect` (`connectedAt`); the
  first `governance.promote` in the same canon home records `promotedAt`. Reading
  point: `canon metrics` computes `ttrp = promotedAt − connectedAt` per project and
  prints `null` (with a hint) until a promote exists.
- **Metric 2 — proposal precision.** Every created proposal carries `createdAt`; every
  promote/reject carries `proposalId` + decision time. Reading point: `canon metrics`
  reports `ratified14 = proposals promoted ≤ 14 d after createdAt` over `promoted +
  rejected` within the measurement window (edited-then-ratified counts as ratified).
  Decayed proposals are excluded from the denominator.

## API

### New/changed endpoints

canon **serves no endpoints** (CLI + library only). Its "API" is (a) the CLI surface,
(b) the exported library surface, and (c) the outbound Langfuse read API it consumes.

### (a) CLI surface — verbs, arguments, exit codes

```
canon connect --host <origin> --project <id> [--public-key <pk>] [--secret-key <sk>]
              [--env production] [--dir <path>] [--redact|--no-redact] [--force]
canon ingest [--incremental|--backfill] [--from <iso>] [--to <iso>]
             [--window-days N] [--small-pages] [--dry-run] [--dir <path>]
canon analyze [--since <iso>] [--env <name>…] [--dir <path>]
canon proposals list [--status pending|all] [--kind <kind>…] [--redact] [--json]
canon proposals show <proposalId> [--redact] [--json]
canon governance promote <proposalId> --as <reviewer> [--edit] [--set <field>=<value>]… [--note "<text>"]
canon governance reject <proposalId> --as <reviewer> [--reason "<text>"]
canon canon show [--json]
canon export --format guardrules-json [--out <path>] [--verify-links]
canon audit export [--format json|md] [--out <path>] [--redact]
canon metrics [--json]
canon status [--json]
canon --help | --version
```

Rules: options after the verb; `--dir` defaults to `.canon` under the current working
directory (override `CANON_DIR` env). `--as <reviewer>` is **required** for
promote/reject (never an anonymous ratification — compliance). Output goes to stdout
only; diagnostics to stderr. Exit codes: `0` success · `1` runtime error (source down,
validation failed, store corrupt) with an actionable message · `2` usage error ·
`130` interrupted. `--json` prints a machine-readable result object; default human
format is stable prose/tables.

### (b) Library surface (exported from `src/index.ts`)

One entry: `createCanon(options)` returning a `CanonApp` with the same operations the
CLI verbs wrap (`connect`, `ingest`, `analyze`, `listProposals`, `showProposal`,
`promote`, `reject`, `showCanon`, `exportGuardRules`, `exportAudit`, `metrics`,
`status`). Full signatures in 03. A `TraceSource` can be injected (fixtures/tests,
future sources); defaults to the Langfuse v4 adapter.

### (c) Outbound Langfuse read API contract (what the v4 adapter calls)

| Purpose | Request | Key params we send | Response parts we consume | Failure handling |
|---|---|---|---|---|
| Validate connection | `GET {base}/projects` | Basic auth (pk:sk) | list of `{id, name}` | 401 → "invalid keys"; no retry |
| Observations | `GET {base}/v2/observations` | `projectId`, `fromStartTime`, `toStartTime`, `limit` (≤1000), `cursor`, `fields` | `data[]` rows, `meta.cursor` | cursor walk; 429/5xx → backoff |
| Scores | `GET {base}/v3/scores` | `projectId`, `fromTimestamp`, `toTimestamp`, `limit` (≤100), `cursor` | `data[]` rows, `meta.cursor` | separate watermark, backoff |

- `{base}` = `host` + `/api/public` (`host` must be an origin; a full `--base-url`
  override is honoured for self-hosted setups with a path prefix) `[ASSUMPTION]`.
- `fields` requested: `core,basic,time,io,metadata,model,usage,metrics,trace_context`
  (`prompt` group omitted in v0.1 `[ASSUMPTION]`).
- **Cursor contract `[ASSUMPTION]`:** responses are parsed leniently — only
  `data` (array) and `meta.cursor` (nullable/absent string) are required; end of
  stream when `cursor` is null, missing or `""`. Unknown response keys are preserved
  verbatim in the archive envelope, never dropped, so upstream schema additions cannot
  break ingestion.
- Rows are fetched newest-first (`startTime` desc) → backfill chunks walk backwards in
  time; incremental polls move forward from the high-water mark.
- **Deprecated endpoints are never called** (`/traces`, `/sessions`, legacy
  `/observations`, legacy ingestion). Only reads: no `POST`/`DELETE`/`PATCH`.

## Data

### Store layout (`--dir`, default `.canon/`)

```
.canon/
├── config.json                 connection + settings (chmod 0600)         [single project]
├── archive/
│   ├── observations.jsonl      append-only raw observation pages, envelope v1
│   ├── scores.jsonl            append-only score rows, envelope v1
│   └── _parts/                 (v0.1 keeps single files; split at ≥ ~200 MB [ASSUMPTION])
├── sync-state.json             checkpoints per project (resume, dedupe watermarks)
├── index.json                  trace + observation line index (rebuildable)
├── proposals/                  one JSON file per proposal (stateful, lifecycled)
├── canon/                      one JSON file per ratified policy version
├── audit.jsonl                 append-only mutation log (compliance backbone)
└── .lock                       O_EXCL advisory lock (PID + stale detection)
```

File formats (all JSON/JSONL, UTF-8, UTC `RFC3339` with ms, versioned envelopes):

`config.json` — settings live here with keys (below); `secretKey` never leaves this
file, never logs, never exports.

```json
{"schema":"canon/config/v1","connection":{"host":"https://cloud.langfuse.com",
 "baseUrl":"https://cloud.langfuse.com/api/public","projectId":"prj-abc",
 "publicKey":"pk-lf-…","secretKey":"sk-lf-…","connectedAt":"2025-09-01T00:00:00.000Z"},
 "settings":{"environment":["production"],"redact":{"ingest":false,"views":true},
 "operator":{"name":""},"sync":{"incrementalOverlapHours":24,"backfillWindowDays":1},
 "http":{"requestTimeoutMs":30000,"maxRetries":5,"retryBaseMs":1000},
 "decay":{"proposalTtlDays":90},"analysis":{"minTraces":3,"maxProposalsPerRun":25}}}
```

Archive line (one Langfuse row per line; `row` stored **verbatim** incl. extra keys):

```json
{"v":1,"kind":"observation","fetchedAt":"2025-09-01T00:00:01.000Z",
 "projectId":"prj-abc","source":"langfuse-v4","page":12,
 "row":{"id":"obs_1","traceId":"tr_9","projectId":"prj-abc","type":"AGENT",
        "name":"refund-agent","startTime":"2025-08-31T23:59:00.000Z",
        "parentObservationId":null,"isRootObservation":true,"level":"INFO",
        "input":"…","output":"…","traceName":"refund_task"}}
```

`sync-state.json` — per-project checkpoints: completed `[from,to)` windows, running
watermarks for observations (`fromStartTime`) and scores (`fromTimestamp`, score time
≠ trace time), last-run counts. Enough to resume a half-finished run without refetch.

`index.json` — rebuilt at the end of each ingest (O(rows) scan of the archive — cheap,
self-healing; corruption ⇒ rebuild): trace summaries (`rootObservationId`, `agentId`,
`taskKey`, outcome, start/end, line span in archive) + `observationId → line` map so
evidence links resolve by targeted seek. `[ASSUMPTION]` v0.1 scale ≤ ~500k rows per
project before index rebuild cost needs revisiting.

Proposal file `proposals/prop_<short>.json` — stateful record (see 03 type
`Proposal`): status lifecycle `pending → ratified|rejected|decayed`, confidence,
coverage, evidence links (trace ids + observation ids), conflicts, reviewer fields,
origin run id. Canon policy file `canon/<ruleKey>.v<N>.json` — immutable per version:
the ratified rule text/constraints/severity plus a provenance snapshot
(`originProposalId`, confidence, coverage, evidence, `ratifiedBy/at`). The *effective*
canon = latest version per ruleKey. Policy edits after ratification are **not**
supported in v0.1 (correction path = a new proposal with the same ruleKey → promotes
to the next version); this keeps `canon/` append-only and reversible `[ASSUMPTION]`.

Audit line `audit.jsonl` (append-only, monotonic `seq`):

```json
{"seq":41,"at":"2025-09-02T09:00:00.000Z","actor":"reviewer@acme",
 "type":"governance.promote","projectId":"prj-abc",
 "payload":{"proposalId":"prop_1a2b","ruleKey":"charge-no-retry","version":1,
            "note":"ok on evidence"}}
```

Audit lines carry ids/counts/timestamps only — **never io content, never keys**.

### Layered knowledge model (simplified SOMA vault — concepts only)

| Layer | Backing store | Writes allowed | Semantic weight | Expiry |
|---|---|---|---|---|
| Archive (raw evidence) | `archive/*.jsonl` | ingest only | historical | never (operator may delete) |
| Emerging (proposals) | `proposals/` | analyze/propose + decay sweep | advisory | decay TTL `[PROPOSED]` 90 d, reset on read |
| Canon (ratified) | `canon/` | governance promote only | mandatory / advisory per rule severity | never |

Rules: no auto-promotion; L4 writes only through governance; promoted/rejected
proposals never decay; decayed proposals are logged and kept (status `decayed`) — the
audit trail outlives the proposal.

### Key queries (prose — no SQL, reads are file scans + index)

- "All rows of trace T": index line span → positional read of `observations.jsonl`.
- "Proposals awaiting review": scan `proposals/*.json` `status=pending`, sort by
  confidence desc, attach conflict flags.
- "Evidence for proposal P": follow evidence links → trace summaries → targeted rows.
- "Effective canon": latest version per ruleKey across `canon/`.
- "Divergence input": traces grouped by `taskKey + environment`, trees rebuilt once
  per analyze run (in-memory), not persisted.
- "Metrics": fold audit events by type + join proposal/canon state (read-only).

## Security & permissions

- **Auth/authz changes:** none introduced server-side. Human roles: single operator
  (runs ingest/analyze/export) and reviewer (promote/reject, attributed via `--as`);
  implemented as convention + audit attribution, not RBAC (out of scope in 01).
- **Secrets.** Langfuse keys are `pk-…`/`sk-…` held only in `.canon/config.json`
  (chmod 0600, dir 0700 enforced at write) or env `CANON_LANGFUSE_PUBLIC_KEY` /
  `CANON_LANGFUSE_SECRET_KEY`. Env wins when set; keys are never written to audit,
  never logged (redactor runs over any string before it reaches a log line), never
  embedded in exports, never put in URLs (Basic auth header only). A redacted
  `config.example.json` is committed; real `.canon/` is gitignored.
- **Transport.** HTTPS only; plain HTTP refused unless the target origin is loopback
  or the operator passes an explicit `--insecure-http` flag on `connect`
  `[ASSUMPTION]`. No TLS verification bypass. `fetch` redirects are disabled; a
  redirect to a different origin fails closed.
- **PII / compliance touchpoints.** `io` and score `comment` fields may contain
  personal data. Two mitigations: (1) **ingest-time redaction**
  (`redact.ingest: true` ⇒ io/metadata/comment values replaced before archive write)
  and (2) **view/export-time redaction on by default** (`redact.views: true`):
  `proposals list/show`, evidence views, and both exports redact content unless
  `--no-redact` is given. Canon rule text is **template-generated from structure
  only** (tool names, levels, counts, task/agent labels) — arbitrary io content is
  never interpolated into policy text, shrinking the PII surface of the canon itself.
- **Content residency.** No server component: raw content stays on the machine that
  runs canon (or in Langfuse). `audit export` v0.1 emits rule text, reviewers,
  timestamps and evidence **links**, never raw io `[ASSUMPTION]`.
- **Attribution.** promote/reject resolve the reviewer `--as` → `CANON_OPERATOR`
  → `settings.operator.name` (the config default reviewer handle); when all three
  are empty the action fails (`exit 2`) — the compliance chain requires "who
  approved", never an anonymous ratification.

## Failure modes

| Failure | Behaviour | Mitigation / recovery |
|---|---|---|
| Langfuse down / network error | typed retryable error; run aborts cleanly | retry w/ exponential backoff (`http.maxRetries`, base 1 s); clear stderr message; nothing corrupts — rerun resumes from checkpoint |
| 429 rate limit (shared per-org bucket) | honor `Retry-After` (seconds or HTTP-date); exponential backoff + jitter | `--small-pages`/polite delay config; advise lower-traffic window or higher tier when exhausted (`exit 1` message) |
| 5xx | treated as retryable | same backoff; exhausted → `exit 1` resume-safe |
| 401 invalid/expired keys | **never retried**; guided message + `canon connect` hint | key rotation documented; config rewrite |
| Partial sync / crash mid-run | each completed page/window checkpointed; rerun resumes; idempotent dedupe by id via index | resume test = injected failure on page N → rerun → exact counts, no dupes |
| Late/updated rows (no `updatedAt` filter on v2) | incremental re-polls an overlap window (`[PROPOSED]` 24 h) behind the watermark; dedupe absorbs overlap | scores polled separately on their own timestamp |
| Oversized page (5 MB server cap) | page fetch fails | automatic halving of `limit` (`--small-pages`, retry) |
| Store corruption (torn JSONL tail, missing index) | tolerant reader skips/repairs trailing partial line and flags it | `index.json` is derived → `canon status --rebuild-index` (or ingest) rebuilds; state files are atomic-rename so they cannot tear |
| Two concurrent processes | O_EXCL lock with PID stale detection | second process exits with clear message; store single-writer |
| Clock skew client↔server | windows are anchored on **server times** from rows/`Retry-After`, never local clock | overlap margins absorb drift |
| SIGINT / Ctrl-C | graceful: finish current page, checkpoint, `exit 130` | no partial state-file writes (rename is atomic) |
| Disk full (ENOSPC) | abort cleanly | write order: state file first (atomic) then audit append; archive partial trailing line tolerated; message tells operator what to free |

## Reversibility

**Low–Medium overall.** Every artifact is human-readable text; nothing is opaque.

- *Low*: store formats and export schema — additive, versioned envelopes (`"schema":
  "…/v1"` on every file); reader tolerates extra keys; archive can be re-ingested from
  Langfuse at any time (deleting `.canon/` loses only local state, not ground truth).
- *Low*: CLI/library split means a later web review queue (01: "later a web review
  queue") can reuse `CanonApp` unchanged.
- *Medium*: switching the trace source later is contained by `TraceSource` (the
  Langfuse-v4 adapter is the only Langfuse-shaped code; archive envelope already names
  `source`); but analysis heuristics are written against the v2 row model and would
  need mapping for an exotic source.
- *Medium*: rule-kind set and confidence formula are heuristic constants — cheap to
  change now (single module), increasingly load-bearing once policies reference them.
  Keep export schema v1 additive-only so consumer rule packs survive changes.
