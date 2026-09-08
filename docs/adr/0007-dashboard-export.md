# ADR-0007 — canon → dashboard governance export (integration seam)

Status: accepted. Source: `ClemenceChee/langfuse-cost-governance`
`docs/canon-integration-prd.md` (the integration seam) + resolved defaults
(2026-09-08). Partner surface: `canon export --format json --out <path>`.

## DEC-31 — one versioned document per project
`canon export --format json` emits a single self-contained document
(schema `canon/dashboard-json` v1) with `project`, `exportedAt`, `metrics`,
`policies` and `divergence`. The document is written atomically (0600) on
`--out`, else printed to stdout. `--verify-links` is rejected for this format
(it is a guard-rules-only check). An `export.run` audit line records the run
(`format: dashboard-json`, policy count only).

## DEC-32 — metrics are the `canon metrics` reading points
`metrics.ttrpMs` / `metrics.precision14` / `metrics.proposals` reuse
`metrics/metrics.ts` (`computeMetrics`), and the export runs the decay sweep
first (CAN-102) so queue counts agree with a swept store. `ttrpMs` is `null`
until a ratified policy exists.

## DEC-33 — policies are the effective canon, provenance-only
`policies` = the effective canon (latest version per ruleKey), mapped to
`ruleKey`, `kind` (derived from the ruleKey prefix, shared with the guard-rules
pack via `kindOfRuleKey`), `status: 'ratified'`, `confidence`,
`promotedAt` (← `ratifiedAt`), `operator` (← `ratifiedBy`) and
`evidenceTraces` (distinct evidence trace ids). No `input`/`output`/`metadata`,
no trace content — metadata/provenance only.

## DEC-34 — project.name is null
canon v0.1 persists only the project id at connect (`config.json` connection);
the project name is not stored. The export emits `project.name: null` and the
dashboard renders the id when the name is absent. Capturing the name would be a
connect-time (core) change; deferred until the dashboard actually needs it.

## DEC-35 — divergence = tool-choice divergence at model × task-key
The PRD resolved default is model × task-key granularity. The divergence
metric is canon's own decision-divergence signal — the cross-agent
"preferred tool vs group standard" comparison already used by the proposal
engine (`propose/candidates.ts` `specToolChoice`) — rather than a new signal:

- groups form per `analyze/divergence.ts` (`taskKey` + environment);
- a group with fewer than two distinct preferred tools has no divergence;
- the group "standard" tool is the preferred tool with the most group-wide
  usage (ties alphabetical); a trace is "divergent" iff its agent prefers a
  non-standard tool and used it;
- each divergent/non-divergent trace is attributed to its GENERATION models
  and aggregated into `{model, taskKey, divergentTraces, totalTraces}` cells
  (traces without a taskKey or model are excluded).

This keeps the export a pure read (trees rebuilt in memory from the archive,
exactly as `analyze` does) and does not touch canon's core (decision
extraction, scoring, ratification).

## Consequences / leftovers
- The dashboard ingests this document via its `canon-ingest` sidecar (this
  repo is unchanged on the ingest side; the seam is the file).
- `project.name` stays null until a future connect change captures it; the
  dashboard must tolerate `name: null`.
