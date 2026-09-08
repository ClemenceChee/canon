# canon

Agent behaviour governance from Langfuse traces.

canon watches the execution traces your agents already produce in Langfuse,
extracts the decisions agents make, finds where they diverge on the same task,
and turns repeated, evidence-backed behaviour into **policy proposals** with
confidence scores and trace-level evidence. A human reviews the queue; ratified
policies land in a **versioned canon** (mandatory / advisory, full provenance,
audit trail, decay) and export as a **guard-rule pack** for your enforcement
plane.

> Status: v0.1 — slices 1–7 of PD-001 built (connect → ingest → analyze →
> proposals → governance → canon → export → audit export → metrics), gate
> green. Built with the ClemenceChee software-factory discipline.
>
> Design docs: [`docs/design/PD-001/`](docs/design/PD-001/) ·
> decisions: [`docs/adr/`](docs/adr/)

## What it is not (v0.1)

- Not an enforcement runtime — it exports rule packs; guards consume them.
- Not an AICP-style preflight authorizer.
- Not world-knowledge memory (people/meetings — different problem class).

## Install & build

Requires **Node ≥ 20** and npm. Runtime dependencies are deliberately empty
(`dependencies: {}`); everything below is dev tooling.

```sh
# from a checkout of this repo (gh repo clone ClemenceChee/canon)
npm ci                      # reproducible install (add --cache .npm-cache if ~/.npm is unwritable)
npm run typecheck && npm run lint && npm test && npm run build
npm run check:runtime-deps && npm run check:types
# the CLI is then dist/cli.js (`npm link` exposes `canon`)

# clean-checkout verification (fresh clone → install → typecheck + tests):
scripts/verify-clean-checkout.sh
```

`npm pack` produces the publishable tarball; canon is not published to the
npm registry, so distribution is by clone/build.

## Quickstart (usage)

canon manages one Langfuse project per store directory (default `.canon`
under the cwd, override with `--dir` or `CANON_DIR`). Keys are stored in
`config.json` chmod 0600; a redacted `config.example.json` is committed and
`.canon/` is gitignored.

```sh
# 1 · connect — validates the project against the Langfuse v4 public API and
# stores the connection (Basic-auth pk:sk; plain http only for loopback hosts)
canon connect --host https://cloud.langfuse.com --project prj-refunds \
    --public-key pk-… --secret-key sk-… [--env production] [--dir .canon]

# 2 · ingest — windowed backfill (newest→oldest); incremental polls ship too
canon ingest --backfill                # backfills the configured horizon —
                                       # by default the last 24 h
                                       # (settings.sync.backfillWindowDays)
canon ingest                           # incremental poll from stored watermarks
                                       # (once a backfill has run)
# full history on a real project: point --from at the project's start
# (optionally bound with --to); the walk then chunks newest→oldest:
canon ingest --backfill --from 2025-08-27T00:00:00.000Z

# 3 · analyze — rebuilds trace trees, infers outcomes, extracts decision
# facts, profiles agents, scans divergence and proposes policy candidates
canon analyze

# 4 · review the queue — pending first, confidence-descending
canon proposals list
canon proposals show prop_1a2b3c4d

# 5 · human gate — ratify or reject; promote/reject are never anonymous.
# Attribution resolves --as > CANON_OPERATOR > settings.operator.name
# (all empty → usage error). Edits (--set) ratify the edited draft; notes
# stay on the proposal, never in the audit log.
canon governance promote prop_1a2b3c4d --as reviewer@acme
canon governance promote prop_1a2b3c4d --as reviewer@acme --edit \
    --set severity=mandatory --note "evidence ok"
canon governance reject  prop_9f8e7d6c --as reviewer@acme --reason "weak signal"

# 6 · the versioned canon — effective rules (latest version per ruleKey)
canon canon show

# 7 · export — vendor-neutral guard-rule pack (schema canon/guard-rules/v1);
# --verify-links refuses to export a rule whose evidence no longer resolves
canon export --format guardrules-json --out guardrules.json --verify-links

# 7b · dashboard export — versioned governance document (metrics + policies +
# divergence) consumed by the langfuse-cost-governance dashboard's
# canon-ingest sidecar (schema canon/dashboard-json v1). Metadata only.
canon export --format json --out canon-state.json

# 8 · compliance report — policy → proposal → evidence chains (json digest | md)
canon audit export --format md --out audit.md

# 9 · product metrics — time-to-first-ratified-policy + proposal precision14
canon metrics [--json]

# state & integrity
canon status [--json] [--rebuild-index]
```

Exit codes: `0` ok · `1` runtime error (typed, actionable) · `2` usage ·
`130` interrupted (Ctrl-C mid-ingest checkpoints and resumes). Environment:
`CANON_DIR`, `CANON_LANGFUSE_PUBLIC_KEY`, `CANON_LANGFUSE_SECRET_KEY`,
`CANON_OPERATOR` (default reviewer handle), `CANON_DEBUG=1` (stack traces).

Full CLI reference: `docs/design/PD-001/02-architecture.md` (API table) and
`docs/design/PD-001/04-vertical-slices.md` (per-slice verification walks).
