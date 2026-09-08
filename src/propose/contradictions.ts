/**
 * propose/contradictions.ts (03 propose/contradictions.ts) — a new proposal
 * vs canon/pending conflict check. Conflicts are flagged on the proposal
 * (conflictsWith), they do not block it — a later proposal with the same
 * ruleKey supersedes an earlier ratified one (ratifies as version+1).
 * BuildCandidates additionally skips a candidate whose ruleKey already has a
 * PENDING proposal (analyze idempotency — the queue is not re-proposed).
 */

import type { Proposal } from '../store/proposals.js';
import type { Policy } from '../store/policies.js';

export function hasPendingProposal(ruleKey: string, existing: Proposal[]): boolean {
  return existing.some((p) => p.ruleKey === ruleKey && p.status === 'pending');
}

export function checkContradictions(
  candidate: Pick<Proposal, 'ruleKey' | 'kind'>,
  existing: Proposal[],
  policies: Policy[],
): Proposal['conflictsWith'] {
  const conflicts: Proposal['conflictsWith'] = [];
  for (const p of existing) {
    if (p.ruleKey === candidate.ruleKey && p.id !== undefined) {
      if (p.status === 'pending') {
        conflicts.push({ id: p.id, kind: 'proposal', reason: 'a pending proposal with the same ruleKey already exists' });
      } else if (p.status === 'ratified' || p.status === 'rejected') {
        conflicts.push({ id: p.id, kind: 'proposal', reason: `an existing ${p.status} proposal shares this ruleKey` });
      }
    }
  }
  for (const policy of policies) {
    if (policy.ruleKey === candidate.ruleKey) {
      conflicts.push({
        id: policy.id,
        kind: 'canon',
        reason: `canon policy ${policy.ruleKey}.v${policy.version} already exists (a new proposal ratifies version ${policy.version + 1})`,
      });
    }
  }
  return conflicts;
}
