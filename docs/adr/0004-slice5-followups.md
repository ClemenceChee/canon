# ADR-0004 — slice-5 follow-ups + slice 6/7 scope notes

Status: accepted. Source: qa_reports/pd001-slices4-5.md, review_reports/pd001-slices4-5.md.

## DEC-20 maxProposalsPerRun is a live knob
`settings.analysis.maxProposalsPerRun` is consumed by the proposal engine
(default 25 `[PROPOSED]`); remove the hard-coded constant in
`propose/candidates.ts`. Resolves QA M1 / review S1.

## DEC-21 ruleKeyFrom contract restored, keys task-scoped
`core/id.ts` implements 03's `ruleKeyFrom` (kebab-case, lowercase, dedupe) and
the proposal engine uses it. Tool-bound rule keys include the taskKey so
distinct tasks cannot collide at dedupe/pending-suppression; policy filenames
derive from the normalized ruleKey. Deliberate consequence: ruleKey strings in
the committed goldens change format only (confidence/coverage/evidence values
unchanged); goldens are revised with this justification, not by engine output.
Resolves review S2.

## DEC-22 --wipe purges project-derived state
`--force --wipe` on project switch removes the previous project's pending
proposals AND ratified canon policies (they are derived from that project's
traces and would otherwise carry dangling evidence). The append-only audit log
is retained as history. This supersedes ADR-0003 DEC-15's "proposals/canon kept"
wording. Same-ruleKey proposals in the new project are no longer suppressed by
stale state, and promote of a purged id fails cleanly. Resolves review S3.

## DEC-23 promote/reject validated under the lock
Proposal snapshot load + status validation happen inside `withLock`, closing
the promote/reject TOCTOU (two processes cannot double-ratify one id into two
policy versions). A two-store-instance concurrency test proves exactly one
succeeds. Resolves review S4.

## DEC-24 acceptances from gate round 3
- tool-choice emission floor is **4** (ADR-0003 DEC-17 + constants), superseding
  03's veto-list "5"; noted in the constants comment. (QA M3 / reviewer NIT.)
- Score corroboration in v0.1 fires on any negative score attached to an
  evidence trace; documented as intended v0.1 reading, refinement deferred.
  (QA M4.)
- Emission drop paths (floor / consistency / per-run breaker) get direct unit
  tests. (QA M2.)
- `status` surfaces `lastRun.aborted` from sync state when present. (QA M5.)
- Accepted NITs (recorded, not fixed in v0.1): optional reject reason vs 03
  signature; `$EDITOR` mode; slice-4 golden ordering not provable; evidence
  role-label inversion across kinds; failure-fact tool mislabel; thin
  model-usage margin; 02 "reset on read" staleness wording.
