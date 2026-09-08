# Changelog

All notable changes follow the PD-001 slice train. Format: semantic version
entries; each entry aggregates its changes per ADR-0001..0005 + backlog issues
(CAN-*). Not published to npm; distribution is by clone and build.

## [v0.1.0] — 2026-09-04

First shippable slice train (PD-001, slices 1–7 + P1 backlog fixes). Zero
runtime dependencies; TypeScript ESM on Node ≥ 20; file-based `.canon/` store.

### Added
- **CLI + library** (`connect`, `ingest`, `analyze`, `proposals`,
  `governance promote|reject`, `canon show`, `export`, `audit export`,
  `metrics`, `status`): full flow from a Langfuse project to guard-rule packs.
- **Langfuse server-v4 TraceSource**: Observations API v2 + Scores API v3 only
  (deprecated `/traces` family never called); Basic auth, cursor pagination,
  `startTime` windows, Retry-After backoff, redirects fail closed, timeouts.
- **Ingest/sync engine**: windowed backfill + incremental polling, kind-scoped
  crash-safe checkpoints, id-dedupe, `--dry-run`, index rebuild before the
  final checkpoint, SIGINT graceful abort (exit 130, resumable).
- **Analysis** (`analyze`): trace-tree rebuild, outcome inference with index
  backfill, decision facts (retries by cause, model usage, failures), agent
  profiles, per-task divergence.
- **Proposals + governance**: structural (LLM-free) proposal engine
  (tool-choice / side-effect-retry / model-usage) with deterministic
  confidence/coverage/evidence, spec-first goldens; human promote/reject;
  evidence-link gate before promote (CAN-103) with audited `--force` override;
  versioned immutable canon (advisory default; mandatory only human-set).
- **Export/audit/metrics**: vendor-neutral guard-rules JSON v1 (schema
  `canon/guard-rules/v1`, `--verify-links`), audit export (json/markdown),
  TTRP + precision14 metrics (decay-sweep aligned, CAN-102).
- **Redaction**: deterministic content scrubbing; ingest-time redaction behind
  `settings.redact.ingest` / `--redact` (default off); views/exports redact by
  default (ADR-0005 DEC-25).
- **Attribution**: `--as` > `CANON_OPERATOR` > `settings.operator.name`
  (ADR-0005 DEC-26).
- **Fixture corpus** (`tests/fixtures/`): realistic Langfuse v4 `refunds`
  scenario (30 traces / 3 taskKeys / 4 agents) + window-aware fixture server +
  edge-row archive; clean-checkout verification script (CAN-104).

### Engineering (process)
- Design-first: `docs/design/PD-001/01–04` + ADR-0001..0005; per-slice
  commits; independent QA (VERIFIED) + reviewer (APPROVED) gates each round;
  goldens authored from spec before their engines.

### Changed
- Reconnect merges settings; `--force --wipe` purges project-derived state
  (proposals + canon, audit retained).
- Backfill horizon default is 24 h (`settings.sync.backfillWindowDays`);
  `--from` enables full history.

### Fixed
- Declarations shipped (`dist/*.d.ts`) with a `check:types` gate.
- `maxProposalsPerRun` is a live config knob.
- Task-scoped rule keys (`ruleKeyFrom` contract) — no cross-task collisions.
- Promote/reject validated under the store lock (no double-ratify).
- Metrics queue counts consistent with the decay sweep.
- Docs no longer claim falsehoods about shipped behavior (README/CONTEXT/02/03).

### Security notes
- Keys never logged/exported; config 0600; audit payloads ids/counts/field
  names only; evidence links verified against the archive at export and now
  before promote (CAN-103).

Backlog for the next cycle: `docs/product/backlog.md` (CAN-101 live-mode
validation, CAN-104 done, CAN-105..114 pending).
