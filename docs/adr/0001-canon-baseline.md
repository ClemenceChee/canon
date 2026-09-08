# ADR-0001 — canon v0.1 baseline decisions

Status: accepted (design stage, PD-001). Scope: decisions the implementation must
not silently change. Numeric constants are `[PROPOSED]` defaults, single-sourced in
`src/core/constants.ts` so they can be vetoed in one place.

## DEC-1 Knowledge tiers (three, not four)
canon keeps `archive` (raw ingested observations + scores), `advisory` (machine
proposals and human-ratified advisory policies) and `mandatory` (human-set canon).
SOMA's four-layer model had a team working-memory tier; canon v0.1 has no team
context source, so that tier is omitted. Promotion moves advisory → mandatory;
promotion requires a human action. Context: 01-product.md out-of-scope list.

## DEC-2 Trace source = Langfuse server v4 only
Reads use `GET /api/public/v2/observations`, `GET /api/public/v3/scores`,
`GET /api/public/projects`, cursor pagination, `startTime` windows. Deprecated
`/api/public/traces` family is never called (Cloud sunset 2026-11-16; 404 on
self-hosted v4). All Langfuse access sits behind the `TraceSource` interface so a
second source can be added without touching analysis. Source:
`.research_langfuse/langfuse_trace_source_report.md`.

## DEC-3 Zero-dependency file store
`.canon/` holds an append-only JSONL archive, index files, and a lock; writes use
atomic rename; no embedded DB in v0.1. Rationale: fixtures-first product, no native
deps, diffable/backup-able state, mirrors the vault philosophy of the soma
reference while staying simpler. Trade-offs in 03-program-design.md.

## DEC-4 Redaction default-on for views/exports
Archive may store raw `io` (local, user-owned data); every view/export/proposal
path redacts `io` content by default (deterministic redaction). `--redact` at
ingest additionally scrubs before archive. Keys never logged.

## DEC-5 Machine proposals are advisory; mandatory is a human act
Auto-generated proposals ship as `severity: advisory`. `mandatory` is set only by
a human (`canon policy set --severity mandatory`). No auto-promotion path in v0.1.

## DEC-6 Decay
Unratified proposals decay after 90 days `[PROPOSED]` (constant). Ratified policies
never auto-decay in v0.1; archive never decays. Decayed proposals are logged and
hidden from the active queue.

## DEC-7 v0.1 analysis is structural and LLM-free
Decision extraction, agent profiles, divergence, and proposal candidates are
deterministic over observation structure/fields (no model calls in v0.1). Keeps
tests deterministic and free; an LLM synthesis lane is a later slice behind the
proposal-source boundary.

## DEC-8 Success-metric reading points
`canon metrics` reads both 01-product.md metrics: TTRP = connect timestamp →
first `promote` event; proposal precision = promote/(promote+reject) per proposal
within 14 days. Events land in `.canon/audit/events.jsonl`.

## Consequences
Implementation must follow 03-program-design.md types/signatures; deviations are
review-blocking. Owed follow-ups: live-project test mode, guard-rule v1 consumers,
LLM synthesis lane, working-memory tier, AICP preflight integration.
