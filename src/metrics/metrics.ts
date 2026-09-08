/**
 * metrics/metrics.ts (04 Slice 6 / 03 Metrics reading points) — the two
 * 01-product.md success metrics, read from audit events + proposal state:
 *
 *  Metric 1 — TTRP (time-to-first-ratified-policy): the earliest `connect`
 *  audit event of the project → the earliest `governance.promote` event.
 *  `null` (with the CLI hint) until a promote exists.
 *
 *  Metric 2 — proposal precision14: of the proposals that reached a decision
 *  WITHIN 14 days of their creation (the measurement window, 02 reading:
 *  "promoted + rejected within the measurement window"), the share ratified
 *  (edited-then-ratified counts as ratified). Proposal creation times come
 *  from `proposal.created` audit events; decision times from
 *  `governance.promote`/`governance.reject`. Decayed proposals never reach a
 *  decision, so they are excluded from the denominator by construction.
 *
 * The app layer passes ONLY the current project's audit events (wipe keeps
 * the previous project's events as history; 03's computeMetrics signature
 * takes no projectId — the projectId reported is the events' own).
 *
 * Deterministic: no wall clock — `now` is an argument; results are rounded
 * to 4 decimals so JSON output is byte-stable.
 */

import type { AuditEvent } from '../store/audit.js';
import type { Proposal, ProposalStatus } from '../store/proposals.js';
import type { IsoTime } from '../core/time.js';
import { parseIso } from '../core/time.js';

/** 02 Metric 2 measurement window: a decision counts within 14 days of creation. */
export const PRECISION14_WINDOW_MS = 14 * 86_400_000;

export interface MetricsResult {
  projectId: string;
  connectedAt: IsoTime | null;
  firstPromoteAt: IsoTime | null;
  /** null ⇒ 'no ratified policy yet' (02: prints null with a hint). */
  ttrp: { ms: number } | null;
  proposals: Record<ProposalStatus | 'total', number>;
  /** ratified ≤ 14 d after createdAt over promoted+rejected within the window. */
  precision14: { numerator: number; denominator: number; ratio: number | null };
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** Fold the (project-scoped) audit log + proposal state into the metrics. */
export function computeMetrics(
  audit: AuditEvent[],
  proposals: Proposal[],
  _now: IsoTime,
): MetricsResult {
  const projectId = audit.find((e) => typeof e.projectId === 'string')?.projectId ?? '';
  const connects = audit
    .filter((e) => e.type === 'connect')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const promotes = audit
    .filter((e) => e.type === 'governance.promote')
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const connectedAt = connects.length > 0 ? connects[0]!.at : null;
  const firstPromoteAt = promotes.length > 0 ? promotes[0]!.at : null;
  const ttrp =
    connectedAt !== null && firstPromoteAt !== null
      ? { ms: parseIso(firstPromoteAt) - parseIso(connectedAt) }
      : null;

  const counts: Record<ProposalStatus | 'total', number> = {
    total: proposals.length,
    pending: 0,
    ratified: 0,
    rejected: 0,
    decayed: 0,
  };
  for (const p of proposals) counts[p.status] += 1;

  // proposal.created events give each proposal's creation time
  const createdBy = new Map<string, IsoTime>();
  for (const e of audit) {
    if (e.type !== 'proposal.created') continue;
    const proposalId = e.payload?.proposalId;
    if (typeof proposalId === 'string') createdBy.set(proposalId, e.at);
  }
  // decision per proposal (earliest wins — a proposal is decided once)
  const decisionBy = new Map<string, { type: 'promote' | 'reject'; at: IsoTime }>();
  for (const e of audit) {
    const proposalId = e.payload?.proposalId;
    if (typeof proposalId !== 'string') continue;
    const type = e.type === 'governance.promote' ? ('promote' as const) : e.type === 'governance.reject' ? ('reject' as const) : null;
    if (type === null) continue;
    const existing = decisionBy.get(proposalId);
    if (existing === undefined || e.at < existing.at) decisionBy.set(proposalId, { type, at: e.at });
  }

  let numerator = 0;
  let denominator = 0;
  for (const [proposalId, decision] of decisionBy) {
    const createdAt = createdBy.get(proposalId);
    if (createdAt === undefined) continue; // no creation event in this project's log
    const withinWindow = parseIso(decision.at) - parseIso(createdAt) <= PRECISION14_WINDOW_MS;
    if (!withinWindow) continue; // outside the 14-day measurement window
    denominator += 1;
    if (decision.type === 'promote') numerator += 1;
  }
  return {
    projectId,
    connectedAt,
    firstPromoteAt,
    ttrp,
    proposals: counts,
    precision14: {
      numerator,
      denominator,
      ratio: denominator > 0 ? round4(numerator / denominator) : null,
    },
  };
}

export type { ProposalStatus };
