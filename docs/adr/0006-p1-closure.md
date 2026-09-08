# ADR-0006 — P1 backlog closure (CAN-102/103/104) + direct-driving note

Status: accepted. Source: docs/product/backlog.md; QA/verification: full gate
suite green (30 files / 197 tests), `scripts/verify-clean-checkout.sh` run.
(Commit hashes cited in the ADRs refer to the pre-publication history, which was
squashed when this repo was opened; they no longer resolve.)

## DEC-28 CAN-102 — metrics decays before it reads
`canon metrics` runs the decay sweep under the store lock before reading
proposal state (mirroring the analyze / proposals-list boundaries), so queue
counts agree with a swept `proposals list`. Injected-clock tests: past-TTL
proposals are not counted pending (90 d boundary), and the 13/15-day
precision14 window semantics are unchanged.

## DEC-29 CAN-103 — promote gates on evidence integrity
`governance promote` verifies the proposal's evidence traceIds still resolve in
the archive before ratifying; dangling links refuse ratification (validation,
exit 1) unless `--force`. The check and the override are recorded:
`governance.promote-override` audit event (ids/counts only), added to the
AuditType union. The dangling definition is shared:
`src/export/evidence.ts` now backs both the export `--verify-links` path and
the promote gate (one source of truth).

## DEC-30 CAN-104 — release hygiene
CHANGELOG.md (v0.1.0 entry, ADR + slice-train references), README Install
section (Node ≥ 20, npm ci, `--cache .npm-cache` note, gates, verify script),
`scripts/verify-clean-checkout.sh` (file:// clone of committed HEAD → npm ci →
typecheck + full vitest; `VERIFY_GATES` subset supported; not part of the unit
suite). Ran clean here.

## Process note (deviation, recorded per ADR-0001's review-blocking rule)
Two delegated builder rounds for CAN-102..104 stalled with no output after
multiple rounds; the driving agent implemented, tested, and gated the issues
directly (deterministic edits + full gate suite). CAN-102/103/104 shipped in
one commit because the changes share `src/app.ts` and no clean per-file split
exists. Factory discipline otherwise held: acceptance criteria
from the backlog, tests before push, gates green, docs updated.

## Consequences / leftovers
- P1 remaining: CAN-101 (live Langfuse validation — needs operator credentials;
  hand-off at docs/product/live-validation-handoff.md).
- Track-2 hand-off complete (the operator runbook it referenced was local to
  the build environment and is not part of the published repo).
- Track-3 cleanup complete: research clones removed or kept as noted at the
  time; the workspace was restored clean.
