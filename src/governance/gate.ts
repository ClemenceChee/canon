/**
 * governance/gate.ts (03 governance/gate.ts + 04 Slice 5) — the human gate:
 * promote / reject / decay sweep.
 *
 * - promote validates status === 'pending' and a non-empty actor (--as or
 *   CANON_OPERATOR — never anonymous, 02 attribution); writes an immutable
 *   canon policy canon/<ruleKey>.v<N>.json with provenance (origin proposal,
 *   confidence, coverage, evidence, ratified by/at) and flips the proposal to
 *   'ratified'. A second proposal with the same ruleKey ratifies version+1 —
 *   the previous policy file is never rewritten [03 [DEC-14]].
 * - edit (--edit / --set, 03 [DEC-16]): edits the working draft BEFORE
 *   ratification; edited fields land on the policy and are recorded on the
 *   governance.promote audit payload as field NAMES (DEC-11: audit payloads
 *   are ids/counts/field names only — note/reason text never enters audit).
 * - reject flips the proposal to 'rejected' (reason kept on the proposal,
 *   the decision recorded in the audit trail).
 * - decaySweep runs at the start of `analyze` and `proposals list` under
 *   lock (03 [DEC-15]-internal): pending proposals past their TTL decay.
 *
 * Time/clock: gate functions accept an optional frozen `at` for deterministic
 * tests (additive; the canonical store clock seam otherwise lives behind the
 * store); audit projectId comes from the store config.
 */

import type { IsoTime } from '../core/time.js';
import { newId } from '../core/id.js';
import type { CanonStore } from '../store/index.js';
import type { Proposal, Severity } from '../store/proposals.js';
import type { Policy } from '../store/policies.js';
import { nextPolicyVersion, writePolicyFile } from '../store/policies.js';
import { CanonError } from '../core/errors.js';

export interface PromoteEdit {
  severity?: Severity;
  ruleText?: string;
  assertion?: string;
}

export interface PromoteOptions {
  actor: string;
  note?: string;
  edit?: PromoteEdit;
  /**
   * CAN-103: `true` allows ratifying a proposal whose evidence links no longer
   * resolve in the archive. The app layer enforces the check and audits the
   * override (`governance.promote-override` event); the gate itself never
   * bypasses state rules.
   */
  force?: boolean;
}

export interface PromoteResult {
  proposalId: string;
  policyId: string;
  ruleKey: string;
  version: number;
  policyPath: string;
  createdAt: IsoTime;
  severity: Severity;
  proposalEdited: boolean;
  editedFields: string[];
}

export interface RejectOptions {
  actor: string;
  reason?: string;
}

export interface DecayConstants {
  proposalTtlDays: number;
}

export interface PromoteContext {
  /** frozen 'now' for deterministic tests; defaults to the real clock. */
  at?: IsoTime;
  /** v0.1: allowing a human-edited ruleText is a policy gate (03 signature). */
  allowEditedRuleText?: boolean;
}

/**
 * Effective reviewer handle for a governance action (02 attribution; acceptance
 * SHOULD-2): `--as` argument > CANON_OPERATOR env > settings.operator.name (the
 * config default reviewer handle). Throws usage when all three are empty —
 * promote/reject are never anonymous. The CLI and app layer resolve here so the
 * precedence lives in ONE place; gate.promote/reject keep actorOf() (no config
 * at gate level) as the enforcement backstop for direct callers.
 */
export function effectiveActor(fromArg: string | undefined, configuredName?: string): string {
  const fromArgTrimmed = fromArg?.trim() ?? '';
  if (fromArgTrimmed.length > 0) return fromArgTrimmed;
  const fromEnv = (process.env.CANON_OPERATOR ?? '').trim();
  if (fromEnv.length > 0) return fromEnv;
  const fromConfig = configuredName?.trim() ?? '';
  if (fromConfig.length > 0) return fromConfig;
  throw new CanonError(
    'promote/reject require an attributed reviewer (--as <reviewer>, CANON_OPERATOR, or settings.operator.name)',
    {
      code: 'usage',
      hint: 'compliance: never ratify anonymously',
    },
  );
}

function actorOf(actor: string | undefined): string {
  return effectiveActor(actor); // --as > CANON_OPERATOR; gate has no config access
}

async function projectIdOf(store: CanonStore): Promise<string> {
  const cfg = await store.readConfig();
  return cfg?.connection.projectId ?? '';
}

export async function promote(
  p: Proposal,
  opts: PromoteOptions,
  store: CanonStore,
  ctx?: PromoteContext,
): Promise<PromoteResult> {
  const actor = actorOf(opts.actor);
  if (p.status !== 'pending') {
    throw new CanonError(`proposal ${p.id} is ${p.status}; only pending proposals can be promoted`, {
      code: 'invalid-state',
    });
  }
  const edit: PromoteEdit = opts.edit ?? {};
  const editFields: string[] = [];
  if (edit.severity !== undefined) editFields.push('severity');
  if (edit.ruleText !== undefined) editFields.push('ruleText');
  if (edit.assertion !== undefined) editFields.push('assertion');
  if (edit.ruleText !== undefined && ctx?.allowEditedRuleText === false) {
    throw new CanonError('edited ruleText is not allowed for this store', {
      code: 'invalid-state',
    });
  }
  const at = ctx?.at ?? new Date().toISOString();
  const severity = edit.severity ?? p.severity;
  const ruleText = edit.ruleText ?? p.ruleText;
  const assertion = edit.assertion ?? p.assertion;
  const projectId = await projectIdOf(store);

  const policies = await store.listPolicies();
  const history = policies
    .filter((x) => x.ruleKey === p.ruleKey)
    .sort((a, b) => a.version - b.version)
    .map((x) => ({ ...x }));
  const version = await nextPolicyVersion(store.dir, p.ruleKey);
  const policyId = newId('pol');

  const policy: Policy = {
    id: policyId,
    ruleKey: p.ruleKey,
    version,
    status: 'active',
    severity,
    ratifiedAt: at,
    ratifiedBy: actor,
    originProposalId: p.id,
    ruleText,
    assertion,
    constraints: { ...p.constraints },
    provenance: {
      confidence: p.confidence,
      coverage: { ...p.coverage, window: { ...p.coverage.window } },
      evidence: p.evidence.map((e) => ({ ...e, observationIds: [...e.observationIds] })),
      proposalEdited: editFields.length > 0,
      history,
    },
  };

  // state durable first: policy file (append-only per version), proposal flip
  const updated: Proposal = {
    ...p,
    status: 'ratified',
    severity,
    ruleText,
    assertion,
    updatedAt: at,
    reviewedAt: at,
    reviewedBy: actor,
    reviewAction: 'promote',
    ...(opts.note !== undefined ? { reviewNote: opts.note } : {}),
  };
  await writePolicyFile(store.dir, policy);
  await store.saveProposal(updated);
  await store.appendAudit({
    at,
    actor,
    type: 'governance.promote',
    projectId,
    payload: {
      proposalId: p.id,
      ruleKey: p.ruleKey,
      version,
      policyId,
      ...(editFields.length > 0 ? { editedFields: editFields } : {}),
    },
  });
  return {
    proposalId: p.id,
    policyId,
    ruleKey: p.ruleKey,
    version,
    policyPath: `canon/${p.ruleKey}.v${version}.json`,
    createdAt: at,
    severity,
    proposalEdited: editFields.length > 0,
    editedFields: editFields,
  };
}

export async function reject(
  p: Proposal,
  opts: RejectOptions,
  store: CanonStore,
  ctx?: { at?: IsoTime },
): Promise<{ proposalId: string; status: 'rejected'; at: IsoTime }> {
  const actor = actorOf(opts.actor);
  if (p.status !== 'pending') {
    throw new CanonError(`proposal ${p.id} is ${p.status}; only pending proposals can be rejected`, {
      code: 'invalid-state',
    });
  }
  const at = ctx?.at ?? new Date().toISOString();
  const projectId = await projectIdOf(store);
  const updated: Proposal = {
    ...p,
    status: 'rejected',
    updatedAt: at,
    reviewedAt: at,
    reviewedBy: actor,
    reviewAction: 'reject',
    ...(opts.reason !== undefined ? { reviewNote: opts.reason } : {}),
  };
  await store.saveProposal(updated); // state durable first
  await store.appendAudit({
    at,
    actor,
    type: 'governance.reject',
    projectId,
    payload: { proposalId: p.id, ruleKey: p.ruleKey },
  });
  return { proposalId: p.id, status: 'rejected', at };
}

/**
 * Decay sweep (ADR-0001 DEC-6 + 03): pending proposals whose createdAt is
 * older than the TTL become 'decayed' (kept on disk + audit line; hidden
 * from the active queue). Runs at the start of analyze and proposals list.
 */
export async function decaySweep(
  store: CanonStore,
  now: IsoTime,
  constants: DecayConstants,
): Promise<Proposal[]> {
  const pending = await store.listProposals('pending');
  const cutoffMs = Date.parse(now) - constants.proposalTtlDays * 86_400_000;
  const projectId = await projectIdOf(store);
  const decayed: Proposal[] = [];
  for (const p of pending) {
    const createdMs = Date.parse(p.createdAt);
    if (Number.isNaN(createdMs) || createdMs >= cutoffMs) continue;
    const updated: Proposal = { ...p, status: 'decayed', updatedAt: now, decayedAt: now };
    await store.saveProposal(updated); // state durable first
    await store.appendAudit({
      at: now,
      actor: 'system',
      type: 'proposal.decayed',
      projectId,
      payload: { proposalId: p.id, ruleKey: p.ruleKey },
    });
    decayed.push(updated);
  }
  return decayed;
}

export function policyFileName(ruleKey: string, version: number): string {
  return `${ruleKey}.v${version}.json`;
}
