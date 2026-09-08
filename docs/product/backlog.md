# canon — Linear-ready backlog (post-PD-001)

Each issue is written for Linear (label `factory:ready`), with acceptance
criteria the software-factory loop can gate on. PD-001 (v0.1 slice train) is
shipped; these continue the product.

Priorities: P1 = blocks v0.2 credibility; P2 = rounds out v0.2; P3 = polish.

## P1

### CAN-101 Live Langfuse validation mode
**Problem:** v0.1 is fixture-validated; the v4 adapter + window semantics have not
been exercised against a real Langfuse project (Cloud or OSS ≥ server v4).
**Acceptance:** `canon connect --host <real> --project …` + `ingest --from` +
`analyze` + `proposals list` run against a real project (or a locally hosted OSS
v4) and produce sane results; wire-param assumptions in
`src/trace/langfuse/client.ts` confirmed against the live API (field groups,
cursor, rate-limit 429 behavior). Metric hook: no change to 01 metrics.

### CAN-102 Metrics count alignment with decay sweep
**Problem (QA M1):** `canon metrics` queue counts read without running the decay
sweep (sweep runs on analyze/proposals-list); cosmetic today but wrong on stale
stores.
**Acceptance:** `canon metrics` performs or respects a decay pass (or documents a
single sweep boundary); counts match `proposals list` after sweep; tests at the
13 d/15 d and 90 d boundaries.

### CAN-103 Evidence-link integrity before promote
**Problem (reviewer S3 residue):** stale pending proposals (surviving edge cases,
e.g. restored archives) can be promoted with evidence links that no longer exist.
**Acceptance:** `governance promote` runs a link check (reuse export's
verify-evidence logic) and refuses dangling evidence unless `--force`; test with a
purged/restored archive.

### CAN-104 Release hygiene for v0.1
**Problem:** repo has no CHANGELOG/release note or install path docs beyond README
quickstart.
**Acceptance:** CHANGELOG entry for the shipped slice train; `npm pack` / build
artifacts verified; README "Install" section; gates green on a clean checkout from
a fresh clone (npm ci path with `--cache` note).

## P2

### CAN-105 `--base-url` / `--verbose` real flags (doc-drift D4/D16)
**Acceptance:** flags exist, honored, documented, tested; help matrix == README ==
02 CLI table.

### CAN-106 LLM synthesis lane (behind proposal-source boundary)
**Acceptance:** optional provider-backed proposal *drafting* that augments (never
replaces) structural candidates; default off; deterministic mode unchanged; ADR
records the boundary and eval approach.

### CAN-107 AgentFlow PolicySource-shaped export
**Acceptance:** second export format emitting SOMA-policy-bridge-shaped rules from
the same canon; schema test; documented consumer mapping.

### CAN-108 Type-surface consumer compile test
**Acceptance:** a downstream TS project (fixture) type-checks against the packed
library (index + subpath exports); wired into CI so `exports` drift fails red.
(Upgrades check:types from existence-gate to consumer-gate.)

### CAN-109 Redaction scope selectors for views
**Acceptance:** `--redact` on list/show/audit-export selects granularity
(full/digest/none) instead of being inert; view default stays digest; tests for
content leakage at each level.

### CAN-110 Multi-project operator UX
**Acceptance:** `canon project list/switch` without `--force`; project scoping
explicit in status/queue output; `--wipe` purge semantics documented in help.

## P3

### CAN-111 AICP preflight evaluation module (product roadmap)
**Acceptance:** standalone library function evaluating a proposed action against
the effective canon (advisory/mandatory) returning proceed/warning/block —
consumer-side; ADR + tests; no runtime wiring.

### CAN-112 Large-corpus benchmark
**Acceptance:** synthetic 5k-trace corpus; ingest/analyze wall-time and memory
budgets recorded; pagination/window boundaries verified; results in
docs/external/ or a bench report.

### CAN-113 Editor review mode + remaining accepted NITs
**Acceptance:** `$EDITOR` for proposal review; permission literals,
`canonVersion` meta, help-wins convention cleanup per review_reports NIT list.

### CAN-114 Doc drift batch (D7/D10/D11/D13/D15/D17)
**Acceptance:** docs state nothing false about shipped behavior; a CI
docs-vs-help check (help matrix snapshot) prevents regression.

---
Roadmap notes: PD-002 candidate — decision intelligence for orgs (cross-project
aggregation + trend/drift over canon); PD-003 candidate — enforcement plane
integration (guardrails/hook consumption of the guard-rules pack). Both stay
out of scope for the v0.2 backlog above.
