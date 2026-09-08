# CAN-101 — Live Langfuse validation — hand-off

Status: P1, blocked on operator credentials (needs a real Langfuse project).

## What must happen
Exercise the v4 adapter + window semantics against a real Langfuse server
(Cloud or self-hosted OSS ≥ server v4), confirming the wire assumptions made in
`src/trace/langfuse/client.ts` and recorded in `.research_langfuse/…` (outside
this repo, git-excluded): field-group param names, cursor contract, rate-limit
429 behavior, score timing.

## You will need
- A Langfuse project (Cloud Hobby is free: 50k units/mo, 30-day access; or
  self-hosted OSS on server v4) with a public/secret key pair
  (project-scoped; Basic auth `pk-…:sk-…`).
- A run that produced agent-ish traces (AGENT/TOOL/GENERATION observations,
  parent/root discipline). A few dozen traces suffice for CAN-102/103/104 logic;
  ≥ a few hundred to sanity-check pagination and windows.

## Steps
1. `npm ci --cache .npm-cache && npm run build`
2. `node dist/cli.js connect --host <base-url> --project <id> --public-key … --secret-key …`
   - Cloud base URLs: `https://cloud.langfuse.com`, `https://us.cloud.langfuse.com`
     (`/api/public` is appended by the client); OSS: your host. Loopback plain
     http is allowed; remote http is refused without `--insecure-http`.
3. `node dist/cli.js ingest --backfill --from <project-start>` (full history) or
   plain `--backfill` (default 24 h).
4. `node dist/cli.js analyze` then `node dist/cli.js proposals list`
5. `node dist/cli.js metrics --json`

## Acceptance
- connect/ingest/analyze/proposals/metrics all succeed against the live API.
- Any wire-param mismatch found is fixed in `src/trace/langfuse/client.ts` +
  the fixture server, with a regression test.
- Rate-limit handling observed under real 429s (Cloud org-wide buckets are
  30/100/1000 req/min on the General API depending on plan).
- Record findings in `docs/external/live-validation-<date>.md`.

## Known open wire assumptions (to validate)
- `fields=` comma-joined groups (core/basic/time/io/metadata/model/usage/metrics/
  trace_context; prompt omitted).
- Environment filter param repetition; cursor param name; `limit` max 1,000.
- Observations arrive within 15–30 s (up to ~15 min from old SDKs/OTel without
  `x-langfuse-ingestion-version: 4`); scores arrive async — poll separately.
- No trace-level event webhooks exist (prompt webhooks only) — polling is the
  sync mechanism.
