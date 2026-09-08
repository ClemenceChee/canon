# PD-001 · 01 — Product: agent behaviour governance from Langfuse traces

> Working codename: **canon** *(pending human confirmation — see Open questions)*.
> Stage 1 of program design — no technology decisions here.

## Problem

Engineering organisations run many AI agents on top of Langfuse (or a Langfuse-native
observability stack). Those agents behave *emergent*, and the organisation has no
governed answer to: *"what are my agents actually doing, where do they diverge, and
which behavioural norms should be organisation policy?"*

Who has it: **agent-platform / ML-infra / AI-engineering leads** at companies whose
agents execute real work (tool calls, writes, payments-adjacent steps, code changes)
inside Langfuse-traced systems. Their traces already contain the evidence — decisions,
tool choices, outcomes, costs — but it sits unread.

What they do today instead:

- **Grep Langfuse manually** after an incident ("why did agent B fail?"), instead of
  having divergence surfaced continuously.
- **Write guardrails / prompt rules by hand** — static rules with no evidence, no
  confidence, no versioning, no audit trail tying a rule back to the traces that
  justified it.
- **React, not learn** — a policy that causes harm ("always retry 3×" → duplicate
  transactions) stays in force until someone notices; nothing measures whether a rule
  is followed or still correct.
- **Fail audits** — EU AI Act / ISO 42001 / NIST AI RMF governance evidence demands
  "which policy, why, on what evidence, who approved" — impossible to produce from
  traces + prose rules.

The knowledge exists but never becomes policy with provenance.

## Success criteria (measurable)

For v0.1 (single Langfuse project → first ratified policy), two metrics:

- Metric 1 — **Time-to-first-ratified-policy** (TTRP)
  - Baseline (today): weeks-to-never (manual analysis of a trace dump)
  - Target (after): **≤ 1 working day** from connecting a Langfuse project with
    existing traces to the first human-ratified canon policy
  - How we measure it: product telemetry — connect timestamp → first `promote` event
- Metric 2 — **Proposal precision** (share of auto-proposed policies a human accepts)
  - Baseline (today): n/a (no proposals exist)
  - Target (after): **≥ 50%** of proposals reaching the review queue are ratified
    (unchanged or edited-then-ratified) within 14 days
  - How we measure it: governance queue events (`promote` / `reject` per proposal id)

North-star signal for the category: every ratified policy carries a resolvable
evidence chain (policy → traces → decisions) and a full audit line, so a compliance
export is *producible, not promised*.

## The announcement

> **canon: agent behaviour governance from the traces you already have.**
>
> Your agents execute on Langfuse. Until now, that data told you what happened, not
> what *should* happen. canon watches the same traces and does the analytical work
> your team was doing by hand: it extracts the decisions agents make, finds where
> agents diverge on the same task, and turns repeated, evidence-backed behaviour into
> **policy proposals** with confidence scores and the exact traces behind them.
>
> A human reviews the queue — promote, reject, or edit. Ratified policies land in a
> **versioned canon**: mandatory vs advisory, with full provenance back to the raw
> traces, a mutation audit trail, and decay for proposals that never get ratified.
> One command exports today's canon as a **guard-rule pack** your enforcement layer
> consumes (guardrail engines, policy sources, hook files) — so the rules agents live
> under are the ones your organisation ratified on evidence, not the ones someone
> typed into a prompt in March.
>
> It is the governance layer agent platforms were missing: decision intelligence that
> learns from every run, a human gate that keeps machine patterns honest, and
> compliance evidence that exports instead of embarrassing you in an audit.

## User flow / mockups

- **Entry point:** CLI (`canon connect --project <id> --host <url> --public-key …`)
  then `canon ingest --backfill`; later a web review queue.
- **Happy path (step by step):**
  1. `canon connect` → validates Langfuse project, stores key config.
  2. `canon ingest --backfill` → pulls trace history (incremental on later runs).
  3. `canon analyze` → decision extraction, agent profiles, divergence scan.
  4. `canon proposals list` → policy candidates, each with confidence, coverage
     (n traces / m agents), and evidence links.
  5. `canon governance promote <id> [--edit]` → human ratifies (or rejects).
  6. `canon canon show` → versioned effective canon (mandatory/advisory).
  7. `canon export --format guardrules-json` → rule pack for enforcement.
  8. `canon audit export` → provenance + mutations report (compliance evidence).
- **Empty / loading / error states:** no traces yet → "connect a project with
  execution traces"; extraction on small sample (< N traces) → "insufficient
  evidence", confidence capped; Langfuse down → clear error, safe resume (ingest is
  idempotent, checkpointed); invalid keys → guided fix.
- **Edge cases:** duplicate/retried runs; same task done by many agents with mixed
  success (the interesting case); privacy — trace content redaction option before
  proposals are shown; conflicting proposals → contradiction surfaced to reviewer;
  decayed/unratified proposals → demoted and logged.

## Out of scope

- ❌ An **enforcement runtime** — canon exports rule packs; it does not gate agents
  itself (enforcement lives in the consumer's guardrails / AICP-style plane).
- ❌ **AICP-style preflight authorizer** (Propose→Authorize→Execute runtime).
- ❌ **World-knowledge memory / retrieval** (people, meetings — that is GBrain-class
  territory; canon is about *agent behaviour norms*).
- ❌ Multi-tenant SaaS, SSO, RBAC beyond a single operator + reviewer role.
- ❌ Non-Langfuse trace sources in v0.1 (adapter interface exists, only Langfuse ships).
- ❌ Fine-tuning / model work; dashboards beyond the review queue + divergence summary.

## Open questions

1. **Repo name & owner** — proposal: `canon` under github.com/ClemenceChee;
   alternatives: `precedent`, `ratify`, `verdict`.
2. **Test target for v0.1** — no live Langfuse project assumed: fixtures first +
  optional `--live` mode. Does the user have a real project to validate against?
3. **Primary export consumer** — generic guard-rule JSON (v0.1) vs. also AgentFlow
  `PolicySource`-shaped output given existing soma policy-bridge code?
4. **Runtime/stack** — TypeScript/Node like soma, or Python (factory's native
  language)? Recommendation: TypeScript/Node (soma logic reuse, Langfuse TS SDK).
