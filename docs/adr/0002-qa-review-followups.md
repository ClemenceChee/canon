# ADR-0002 — QA/review follow-ups (slices 1–2) + slice-3 gate notes

Status: accepted. Source: qa_reports/pd001-slices1-2.md, review_reports/pd001-slices1-2.md.

## DEC-9 Library types are a shipped contract
`package.json` `exports.types` must resolve to a real emitted `dist/index.d.ts`.
Implementation: relative imports use `.js` specifiers (03 convention — the `.ts`
suffix experiment is reverted), `tsup` emits declarations (`dts: true`), and a
`check:types` gate asserts the `.d.ts` exists. QA F1 / review SHOULD S1.

## DEC-10 connect merges, never resets
Re-running `canon connect` on an already-configured `.canon/` preserves all
existing settings (sync/http/decay/analysis/operator) and only applies the
options given on this invocation; key rotation is the documented reconnect path
and must not wipe hand-tuned config. Review SHOULD S2.

## DEC-11 Origin rule applies wherever a source is built from config
Slice 3's source-from-config path enforces the same rules as `connect`:
plain-http only for loopback hosts unless `--insecure-http`; redirects fail
closed. Defense-in-depth for keys over http. Review forward note.

## DEC-12 Fixture corpus is a spec, grown before the goldens
The `refunds` corpus must reach 04-vertical-slices.md's scenario table
(~120 rows / ~15 traces / 3 taskKeys / 4 agents, incl. duplicates and
divergence-relevant rows) before slice-4/5 golden proposals are authored.
Shape is additive (v4 rows); no fixture surgery. Edge rows (e.g. one
unparseable archive line) belong to the archive scenario, not the HTTP pages.
Review SHOULD S3.

## DEC-13 Committed regression for the default adapter path
A committed test drives `connect` through the default Langfuse HTTP adapter
against the fixture server (incl. the 401 no-retry path). QA F2.

## Deviation register (owed from reviewer)
The enumerated, code-commented deviations of slices 1–2 (AuditEventDraft vs
AuditEvent; cross-cutting type homes in store/proposals.ts; per-slice partial
interfaces; HeadersInitLike; placeholder-origin URL builders; canned analyze
ignoring since/env; audit path `.canon/audit.jsonl` — correcting ADR-0001
DEC-8's stale path; `.ts` import suffixes — superseded by DEC-9) are accepted
and recorded here rather than in a separate register file.

## NIT follow-ups accepted
runtime-deps checker widened to catch `import()`/`require()` (QA F3); audit
reader flags corrupted lines instead of silently dropping them (QA F5);
`canon proposals` (bare subgroup) exits usage code 2 (reviewer nit).
Redirect retry-budget burn (QA F4) and determinism posture leaks (QA F9) are
accepted with the documented trade-offs.
