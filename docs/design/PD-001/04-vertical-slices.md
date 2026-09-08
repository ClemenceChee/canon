# PD-001 · 04 — Vertical slices

> Stage 4 — the build order for **canon** v0.1, as thin end-to-end slices that grow
> into the product. The builder works through these in order; each slice ends green
> (its tests + the full suite) before the next starts. Contracts come from
> `03-program-design.md`; behaviour from `01-product.md`; components from
> `02-architecture.md`.
>
> Working convention for every slice: **fixtures first** (committed under
> `tests/fixtures/`, modelling the Langfuse v4 *observations/scores* model — rows and
> HTTP pages, never legacy trace JSON), and **no network in tests** — a fake server
> replays fixture pages. LOC estimates are for the slice's production code
> (fixtures/tests excluded) and are indicative, not targets.

### Fixture corpus the goldens encode (author once, in `tests/fixtures/scenarios.ts`)

| Scenario | Purpose | Expected proposal contribution |
|---|---|---|
| `refunds` (project `prj-refunds`) | main e2e corpus: 3 taskKeys, 4 agent identities, ~15 traces, ~120 observation rows incl. AGENT/TOOL/GENERATION types, one failure, duplicates, eval scores on observations **and** a trace | exactly 3 pending proposals: `tool-choice` (refund tool standardisation), `side-effect-retry` (charge double-call after timeout), `model-usage` (costlier model, no success gain) |
| `single-agent-happy` | uniform behaviour, no divergence | zero proposals (analyze runs, nothing proposed — proves the empty/insufficient-evidence path) |
| `edge-rows` | orphan rows, missing parents, unparseable line, GUARDRAIL/EVALUATOR types, io containing `password=`-style text | tree `skipped` list as expected; redaction golden (raw string absent from every view/export artifact) |

Each scenario ships: raw HTTP pages under `tests/fixtures/langfuse-http/<scenario>/`,
pre-ingested envelope JSONL under `tests/fixtures/archive/<scenario>/`, and goldens
under `tests/fixtures/expected/<scenario>/` (trees, proposal set keyed by
ruleKey/kind/coverage — never by generated ids, proposals.json, guardrules pack,
audit digest). Timestamps are fixed (no wall clock), so goldens are byte-stable.

## Slice order

1. **Slice 1 — Thin end-to-end: skeleton + connect + canned analyze/proposals.**
   What it does: package scaffolding (`package.json`, tsconfig, tsup, vitest, eslint,
   empty `dependencies`), `src/index.ts` + `src/app.ts` + `cli/` (main, args, command
   registry with the full 02 verb surface), store primitives needed by the walk
   (`jsonl.ts`, `atomics.ts`, `lock.ts`, `audit.ts`, config read/write with 0600),
   and `connect` implemented end-to-end against an injected `TraceSource` test double
   (writes config.json + `connect` audit event). `analyze` and `proposals list`
   return a **canned proposal** persisted through the real store, proving the full
   wiring: CLI → app → store → audit → stdout (redacted view on by default).
   Every unimplemented verb exits with a clear "not implemented in slice N" message
   and exit code 1, so the registry's usage errors (exit 2) are already testable.
   Verify: commands below + `tests/unit/cli-args.test.ts`, `tests/integration/store-basics.test.ts`,
   `tests/e2e/slice1-walk.test.ts`. ~450 LOC.

2. **Slice 2 — Langfuse v4 adapter (real HTTP).**
   What it does: `trace/types.ts`, `traceSource.ts`, `trace/langfuse/{http,client,normalize}.ts`
   — Basic-auth fetch with retry/backoff, `Retry-After` handling, timeouts, redirect
   guard, 401-no-retry; observations-v2 + scores-v3 URL builders and lenient page
   parsers (`meta.cursor` contract); a `fakeLangfuseServer.ts` that replays committed
   HTTP fixture pages and can inject 429/5xx/delay. No CLI surface yet.
   Verify: `tests/integration/langfuse-adapter.test.ts` (+ fault-injection cases). ~420 LOC.

3. **Slice 3 — Ingest sync engine + archive.**
   What it does: `ingest/sync.ts` + `store/archive.ts` + `index.json` rebuild —
   windowed backfill (walk newest→oldest in `windowDays` chunks), incremental polling
   from watermarks with overlap, scores on their own timestamp watermark, per-page
   checkpoints, idempotent dedupe by id, resume after partial run, `--small-pages`
   fallback, `--dry-run`, `canon status --rebuild-index`. `canon ingest` becomes real.
   Verify: fault-injection resume test, idempotency test, golden archive digest;
   manual `canon ingest --backfill` against the fixture server. ~520 LOC.

4. **Slice 4 — Analyze: trees, decisions, profiles, divergence.**
   What it does: `analyze/{tree,decisions,profiles,divergence}.ts` — rebuild trace
   trees from archive rows (`traceId` + `parentObservationId` + `isRootObservation`),
   infer outcomes, extract structural decision facts (tool choice, retries, failures,
   model usage), build agent profiles, group divergence by `taskKey+environment`, and
   write `analysis.run` audit events. `canon analyze` prints the summary report.
   Redactor is applied to any displayed content. No proposals yet.
   Verify: golden tree/decision tests per fixture scenario; CLI run on the pre-ingested
   `refunds` archive prints expected counts. ~460 LOC.

5. **Slice 5 — Proposals + governance gate + canon store.**
   What it does: `propose/{kinds,scoring.constants,scoring,templates,candidates,contradictions}.ts`
   and `governance/gate.ts` + `store/{proposals,policies}.ts` — candidates →
   proposals (confidence/coverage/evidence links/conflict flags, per-run circuit
   breaker), `proposals list|show` (pending first, redaction default on), promote /
   reject / `--edit` with mandatory `--as` attribution, versioned canon policies
   (same ruleKey ratifies version+1; policy files immutable), decay sweep on
   `analyze` + `proposals list` boundaries. `canon canon show` real.
   Verify: state-machine tests (promote/reject/decay boundaries), rule-text never
   contains io content test, golden proposal set on `refunds`. ~520 LOC.

6. **Slice 6 — Export + metrics + status + audit report.**
   What it does: `export/{guardRules,auditReport,schema-guard-rules-v1}.ts` —
   `canon export --format guardrules-json` (schema v1, `--verify-links`),
   `canon audit export --format json|md` (compliance report: policy → proposal →
   evidence chains), `canon metrics` (TTRP + precision14 reading points), `canon status`.
   Verify: export output validates against the committed JSON Schema; golden pack file;
   metrics hand-computed from a scripted audit sequence. ~360 LOC.

7. **Slice 7 — End-to-end happy path + edge hardening.**
   What it does: tie the whole product flow together on the `refunds` fixture corpus
   through the **built CLI** in a temp dir: connect → ingest (backfill) → analyze →
   proposals list → promote (with `--as` + one `--edit` severity change) → canon show
   → export → audit export → metrics; plus hardening tests folded in: 429 mid-run
   resume, SIGINT checkpoint, torn-archive-tail recovery, redacted-view assertion.
   Verify: `tests/e2e/full-flow.test.ts` + the manual command walk below. ~280 LOC
   (excludes committed fixture corpus).

## Verification per slice

- **Slice 1:**
  - `npm run typecheck && npm run lint && npm run test && npm run build`
  - `node dist/cli.js --help` lists the full 02 verb surface; `node dist/cli.js connect --host http://127.0.0.1:PORT --project prj-demo --public-key pk-x --secret-key sk-x` against the test-double server → writes `.canon/config.json` (0600, verified by test) and `connect` audit event.
  - `node dist/cli.js analyze && node dist/cli.js proposals list` → one canned proposal printed; exit 0; `node dist/cli.js nonsense` → exit 2.
  - `vitest run tests/e2e/slice1-walk.test.ts` (walks the above in-process).
- **Slice 2:** `vitest run tests/integration/langfuse-adapter.test.ts` — every case green: cursor walk to end, 429+`Retry-After`, 5xx exhaustion → `source-down`, 401 → `auth-failed` with zero retries, cross-origin redirect fails, timeout path.
- **Slice 3:** `vitest run tests/integration/ingest.test.ts tests/integration/store.test.ts`; then manual:
  - `node dist/cli.js ingest --backfill --dir /tmp/canon-demo` against fixture server → report `windows/pages/newRows/dupes`; run twice → second run `newRows: 0` (idempotency, dupes counted).
  - Injected page-N failure test: rerun completes with identical final counts; `--dry-run` leaves the store untouched.
- **Slice 4:** `vitest run tests/integration/analyze.test.ts tests/unit/analyze-*.test.ts`; manual `node dist/cli.js analyze --dir /tmp/canon-demo` prints tree/agent/divergence counts matching the fixture's expected summary.
- **Slice 5:** `vitest run tests/unit/propose-*.test.ts tests/unit/governance.test.ts tests/integration/governance.test.ts`; manual:
  - `node dist/cli.js proposals list` → only `refunds` scenario's expected pending proposals, confidence-descending.
  - `node dist/cli.js governance promote <id> --as tester` → creates `canon/<ruleKey>.v1.json`; `promote` again on the same id → exit 1 (`invalid-state`).
  - `node dist/cli.js governance promote <id2> --as tester --edit --set severity=mandatory --note "evidence ok"` → policy severity `mandatory`; audit `governance.promote` records the edited-field diff.
  - promote a **new** proposal with the same ruleKey → `.v2.json` exists and `.v1.json` is byte-identical to before.
  - `promote <id>` without `--as` → exit 2.
- **Slice 6:** `vitest run tests/unit/export.test.ts tests/unit/metrics.test.ts`; manual:
  - `node dist/cli.js export --format guardrules-json --out /tmp/guardrules.json --verify-links` → output validates against `schema-guard-rules-v1.ts` (schema test), rules carry provenance (proposalId, confidence, coverage, evidence trace ids).
  - `node dist/cli.js audit export --format md --out /tmp/audit.md` → contains the policy→proposal→evidence chain lines; `--format json` digest equals expected.
  - `node dist/cli.js metrics` → `ttrp.ms` non-null after a promote, matching hand-computed value from the audit sequence.
- **Slice 7 (Definition-of-Done gate):** `vitest run` (full suite) then the manual end-to-end walk on the fixture corpus:
  ```
  cd $(mktemp -d)
  node <repo>/dist/cli.js connect --host http://127.0.0.1:PORT --project prj-refunds \
      --public-key pk-demo --secret-key sk-demo
  node <repo>/dist/cli.js ingest --backfill
  node <repo>/dist/cli.js analyze
  node <repo>/dist/cli.js proposals list
  node <repo>/dist/cli.js governance promote prop_<side-effect-retry-id> --as tester --edit --set severity=mandatory --note "evidence ok"
  node <repo>/dist/cli.js canon show
  node <repo>/dist/cli.js export --format guardrules-json --out guardrules.json --verify-links
  node <repo>/dist/cli.js audit export --format md --out audit.md
  node <repo>/dist/cli.js metrics --json
  ```
  Assertions the e2e test encodes: ingest newRows == fixture corpus count; proposals == expected golden set (kinds `tool-choice`, `side-effect-retry`, `model-usage` on the `refunds` corpus); export `rules.length == 1` after a single promote; every exported rule's evidence `traceId`s resolve in the archive (`--verify-links` clean); `audit.md` contains `reviewedBy: tester`; `metrics.ttrp.ms > 0`; `.canon/config.json` chmod 0600 and no secret key appears anywhere in stdout/stderr/export files.

## Definition of done

Checklist that must pass before this is a reviewable PR:

- [ ] Every slice above was committed separately when driving manually (one commit per slice — the factory's loop commits the build for you when it drives).
- [ ] All five gates pass from a clean checkout: `npm run typecheck`, `npm run lint`, `npm run test` (vitest full suite), `npm run build`, `npm run check:runtime-deps` (runtime `dependencies` remains empty).
- [ ] Every gate can fail: fixtures/golden tests are red before their slice's code exists; removing the feature under test breaks the suite (no decoration tests).
- [ ] The success metrics from `01-product.md` have defined reading points and are read somewhere runnable: `canon metrics` prints TTRP and precision14 from audit + state; Slice 7 asserts a non-null TTRP after promote.
- [ ] Fixture corpus is committed under `tests/fixtures/` and models the **v4 observations/scores model** (HTTP pages + envelope JSONL rows with `traceId`/`parentObservationId`/`type`/`io`/scores-by-subject) — no legacy `/traces` JSON anywhere.
- [ ] `.canon/` is gitignored; `config.example.json` committed with placeholder keys only; no key material or unredacted io content appears in any committed fixture, golden file, or log fixture.
- [ ] Audit invariants hold by test: every state change has an audit line; audit lines contain ids/counts/times only; promote/reject are always attributed (`--as`/`CANON_OPERATOR`).
- [ ] `CONTEXT.md` / `docs/adr/*` are updated if an external fact or recorded decision changed during the build (note: ADRs distilling this stage's `[DEC-*]` decisions are still owed — human approval step at stage-2/3 review, per CONTEXT.md).
- [ ] QA can reproduce the five gates locally and reports VERIFIED against this checklist before merge.
