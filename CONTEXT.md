# CONTEXT — canon

Purpose: agent behaviour governance from Langfuse traces. Design-first product
built with the software-factory in-session discipline (driving agent + subagents,
deterministic gates, QA/review phases, human at the design/scope decision points).

## Ground truth (read before doing work)

- Langfuse is **observations-first (server v4)**. Read surfaces: Observations
  API v2 (`GET /api/public/v2/observations`), Scores API v3
  (`GET /api/public/v3/scores`), Metrics API v2. The classic `/api/public/traces`
  endpoints are **deprecated** (Cloud sunset 2026-11-16; 404 on self-hosted v4).
  Trace trees are rebuilt from v2 rows by `traceId` + `parentObservationId`.
- Observation `type` includes `AGENT`, `TOOL`, `CHAIN`, `RETRIEVER`, `GUARDRAIL`
  etc. — decision extraction keys on TOOL/AGENT spans with name/level/status,
  io, usage+cost, model, session/user linkage.
- Reference research: `.research_langfuse/langfuse_trace_source_report.md`
  (kept outside the repo; git-excluded).
- Decision lineage: SOMA, a separate private project, already implements worker
  cascade + four-layer vault + ops/decision intelligence — a reference for
  concepts, **not** code we copy wholesale (proprietary; red test suite).
  gbrain (garrytan/gbrain, MIT) is the memory-layer reference — out of scope here.

## Decisions recorded (ADR index)

- [docs/adr/0001-canon-baseline.md](docs/adr/0001-canon-baseline.md) — v0.1 baseline
  (3 knowledge tiers; Langfuse v4-only behind TraceSource; zero-dep file store;
  redaction default-on; advisory-only machine proposals; decay 90 d; LLM-free
  structural analysis; metric reading points).
- [docs/adr/0002-qa-review-followups.md](docs/adr/0002-qa-review-followups.md) —
  QA/review follow-ups for slices 1-2 (DEC-9 shipped types gate; DEC-10 connect
  merges on reconnect; DEC-11 origin rule in the source-from-config path;
  DEC-12 fixture corpus growth before goldens; DEC-13 default-adapter connect
  regression; accepted deviation register + NIT list).
- [docs/adr/0003-analysis-proposal-semantics.md](docs/adr/0003-analysis-proposal-semantics.md) —
  slices 4-5 semantics: index rebuilt before final checkpoint (DEC-14);
  project-switch requires --wipe (DEC-15); analysis semantics incl. outcome
  inference + decision facts (DEC-16); proposal emission: kinds, floors,
  minConsistency, retry classification, spec-first goldens (DEC-17); corpus
  growth to floor feasibility (DEC-18); gate-round-2 test gaps (DEC-19).
- [docs/adr/0004-slice5-followups.md](docs/adr/0004-slice5-followups.md) —
  slice-5 follow-ups + slices 6-7: maxProposalsPerRun live knob (DEC-20);
  task-scoped ruleKeyFrom contract (DEC-21); --wipe purges project-derived
  state (DEC-22); promote/reject validated under the lock (DEC-23); gate-
  round-3 acceptances incl. tool-choice floor 4 (DEC-24).

## Operating principles (software-factory)

1. Design before code — four design docs per issue (`docs/design/<issue>/`).
2. Humans decide *what* and *how it should be shaped*; agents write code.
3. Vertical slices, not horizontal layers.
4. Own your context — reasoning on disk as markdown; grep beats re-explaining.
5. Success is a number (`01-product.md`), never a feeling.

## Wiring

- Repo: github.com/ClemenceChee/canon. Working clones in sibling `.research-*`
  dirs are git-excluded.
