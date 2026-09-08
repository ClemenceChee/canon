# ADR-0005 — acceptance MUST-1 closure + operator attribution + window semantics

Status: accepted. Source: review_reports/pd001-acceptance.md, qa_reports/pd001-acceptance.md,
and the builder round that closed acceptance MUST-1. (Commit hashes cited in the
ADRs refer to the pre-publication history, which was squashed when this repo was
opened; they no longer resolve.)

## DEC-25 Ingest-time redaction is implemented (DEC-4 completed)
`settings.redact.ingest` (default **false**) and `canon connect --redact/--no-redact`
now actually control scrubbing at envelope append in the sync path. Scrub scope
(established by tracing every consumer): observation `input`, `output`, `metadata`
(deep scrub, key order preserved), `statusMessage`; score `comment`. Structural
fields (ids, traceId, types, names, levels, times, environment, model, usage/cost,
session/user, parent/root linkage) are never touched — a redacted archive yields an
analysis report byte-equal to a raw run (test-pinned). Empty-string values pass
through (digesting `''` would corrupt blank-vs-present failure signals); the digest
is deterministic so resumes re-scrub identically. `CanonOptions.redactor` injection
is honored. Closes reviewer MUST-1; the earlier unrecorded-deviation state is
resolved by this record.

## DEC-26 Effective operator attribution
Governance attribution resolves `--as` > `CANON_OPERATOR` env >
`settings.operator.name`; empty on all rungs is a usage error (exit 2), never an
anonymous action. Closes reviewer SHOULD-2.

## DEC-27 Backfill windows are real and documented
Default backfill horizon is `settings.sync.backfillWindowDays` (1 d `[PROPOSED]`);
full history requires an explicit start (`--from`). The fixture Langfuse server
honors the engine's window params (observations `fromStartTime`/`toStartTime`,
scores `fromTimestamp`/`toTimestamp`), so chunked-backfill and incremental-poll
semantics are exercised by tests, not hidden. README no longer claims "full
history" by default. Closes reviewer SHOULD-3.

## Accepted residuals (v0.1 release)
Listed in review_reports/pd001-acceptance.md NIT/D items and recorded here:
inert `--redact` view flags on list/show/audit-export (view redaction is already
default-on; flags are future scope selectors); metrics queue counts read without a
decay sweep (sweep runs on analyze/proposals-list — cosmetic for TTRP/precision14);
`--wipe` purges the whole proposals/ dir (superset of ADR-0003 wording, deliberate);
audit-export md shows assertion, not full ruleText (02-vs-03 prose drift); `--base-url`,
`--verbose`, `$EDITOR` mode documented-but-absent; `canonVersion` literal; help-wins
convention; remaining doc drift D4/D7/D10/D11/D13/D15/D16/D17 as listed.
