# ADR-0003 — analysis & proposal semantics (slices 4–5) + gate-round-2 follow-ups

Status: accepted. Source: qa_reports/pd001-fix-slice3.md, review_reports/pd001-fix-slice3.md.

## DEC-14 Index is rebuilt before the final sync checkpoint
`sync.ts` previously wrote the final checkpoint then rebuilt the index; a crash
between the two left a stale-but-present index that a no-new-rows resume never
refreshes. Order is inverted: rebuild index first, then write the final
checkpoint. Residual staleness remains recoverable via `canon status
--rebuild-index`.

## DEC-15 Project switch requires an explicit wipe
`canon connect --force <different-project>` is refused with a validation error
unless `--wipe` is also given. `--wipe` clears the archive, index, and sync
state of the previous project before connecting. Project-mismatch guards
extend to `status()` and archive reads, not just index/sync-state.

## DEC-16 Analysis semantics (slice 4)
- Trace outcome is inferred by `analyze` and back-filled into the index
  (`TraceSummary.outcome`), replacing the slice-3 `'unknown'` placeholder.
  Index consumers remain geometry-only.
- Decision-fact schema: per trace, ordered decision points = tool calls with
  {name, side-effect flag, step, outcome}; retries recorded with cause
  (`after-error` | `after-timeout` | `after-unknown`); model usage read from
  GENERATION rows (model name, input/output tokens); failures from
  ERROR-level/statusMessage rows.
- taskKey = traceName + environment (03); divergence is defined within a
  taskKey group across ≥2 agents: tool-choice frequency vs outcome.

## DEC-17 Proposal emission semantics (slice 5)
- Candidate kinds in v0.1: `tool-choice`, `side-effect-retry`, `model-usage`.
- Floors (traces per taskKey group): tool-choice 4, side-effect-retry 5,
  model-usage 8 `[PROPOSED]` — constants in `src/core/constants.ts`.
- `minConsistency` 0.6 = fraction of group agents exhibiting the pattern;
  confidence single-agent cap 0.5, global cap 0.95; max 25 proposals per run;
  every proposal `severity: advisory`. Deterministic formulas only (no LLM).
- Retry classification pinned: a side-effect retry = a second call to a
  side-effect tool (e.g. charge/reversal class) in the same trace after the
  first failed or timed out; cause recorded per DEC-16 and counts toward the
  `side-effect-retry` kind regardless of cause.
- Goldens are authored from the 04 pattern map BEFORE the engine ships, then
  the engine must reproduce them exactly (no self-fulfilling goldens).

## DEC-18 Corpus growth for floor feasibility
The `refunds` corpus is grown additively (v4 row shape unchanged) so every
DEC-17 floor is reachable with margin: side-effect-retry ≥5 traces including
both after-error and after-timeout cases; model-usage ≥8 traces comparing
gpt-4o vs gpt-4o-mini within the same taskKey. Resolves QA F5 / reviewer
SHOULD-3 without weakening the constants.

## DEC-19 Gate-round-2 test gaps
- Add a scores-route failure resume test (obs-complete / scores-missing axis).
- ADR-0002's deviation register is appended with slice-3's accepted deviations
  (kind-scoped completedWindows; index outcome placeholder — superseded by
  DEC-16; traceLines full-scan; additive store methods; clock seam; window-level
  checkpoints; `--insecure-http`; archive fixture split).
- Accepted NITs: check:types remains an existence gate for v0.1 (a downstream
  consumer compile test is a later milestone); out-of-order duplicate rows on
  fixture page 15 are a benign authoring artifact.
