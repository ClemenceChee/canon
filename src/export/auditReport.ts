/**
 * export/auditReport.ts (04 Slice 6 / 03 AuditDigest) — the compliance/
 * provenance report: `canon audit export --format json|md`. The JSON digest
 * (schema canon/audit/v1) folds the audit log + policy state into the
 * compliance shape; the markdown report is the human-readable version with
 * policy → proposal → evidence chain lines (02: "audit export emits rule
 * text, reviewers, timestamps and evidence links, never raw io" — io content
 * never enters this surface, so DEC-4 redaction-on-by-default has nothing to
 * scrub, mirroring the proposals-view convention).
 *
 * Every policy VERSION is listed in the chain (v1, v2, … per ruleKey) — the
 * full ratification history, each with its origin proposal and evidence
 * count; "the effective canon = latest version" stays a canon-show concept.
 */

import type { Policy } from '../store/policies.js';
import type { AuditEvent } from '../store/audit.js';
import type { IsoTime } from '../core/time.js';

export const AUDIT_DIGEST_SCHEMA = 'canon/audit/v1';

export interface AuditDigest {
  schema: 'canon/audit/v1';
  projectId: string;
  generatedAt: IsoTime;
  events: number;
  connectAt?: IsoTime;
  promoteCount: number;
  rejectCount: number;
  policyChain: Array<{
    ruleKey: string;
    version: number;
    ratifiedBy: string;
    ratifiedAt: IsoTime;
    originProposalId: string;
    evidenceTraceIds: number;
  }>;
}

export interface AuditDigestContext {
  projectId: string;
  generatedAt: IsoTime;
}

/** Fold audit events + ratified policy versions into the compliance digest. */
export function buildAuditDigest(
  audit: AuditEvent[],
  policies: Policy[],
  ctx: AuditDigestContext,
): AuditDigest {
  const connects = audit.filter((e) => e.type === 'connect');
  const promotes = audit.filter((e) => e.type === 'governance.promote');
  const rejects = audit.filter((e) => e.type === 'governance.reject');
  const policyChain: AuditDigest['policyChain'] = [...policies]
    .sort((a, b) => {
      if (a.ruleKey !== b.ruleKey) return a.ruleKey < b.ruleKey ? -1 : 1;
      return a.version - b.version;
    })
    .map((p) => ({
      ruleKey: p.ruleKey,
      version: p.version,
      ratifiedBy: p.ratifiedBy,
      ratifiedAt: p.ratifiedAt,
      originProposalId: p.originProposalId,
      evidenceTraceIds: p.provenance.evidence.length,
    }));
  return {
    schema: AUDIT_DIGEST_SCHEMA,
    projectId: ctx.projectId,
    generatedAt: ctx.generatedAt,
    events: audit.length,
    ...(connects.length > 0 ? { connectAt: connects[0]!.at } : {}),
    promoteCount: promotes.length,
    rejectCount: rejects.length,
    policyChain,
  };
}

/**
 * Human-readable provenance report (markdown). For every ratified policy
 * version: policy → proposal → evidence chain lines (`reviewedBy` is printed
 * from the policy's ratifiedBy — promote records the same reviewer handle on
 * the proposal and the policy), then the raw decision log of promote/reject
 * audit events (ids + times only).
 */
export function auditReportMarkdown(
  digest: AuditDigest,
  audit: AuditEvent[],
  policies: Policy[],
): string {
  const lines: string[] = [];
  lines.push('# canon audit export');
  lines.push('');
  lines.push(
    `project ${digest.projectId} · generated ${digest.generatedAt} · ` +
      `${digest.events} audit event(s) · promote ${digest.promoteCount} · reject ${digest.rejectCount}`,
  );
  lines.push('');
  lines.push('## Policy chain');
  lines.push('');
  if (digest.policyChain.length === 0) {
    lines.push('_no ratified policies yet_');
    lines.push('');
  } else {
    for (const entry of digest.policyChain) {
      lines.push(`### ${entry.ruleKey}.v${entry.version}`);
      lines.push('');
      lines.push(`- ruleKey: ${entry.ruleKey}`);
      lines.push(`- version: ${entry.version}`);
      lines.push(`- reviewedBy: ${entry.ratifiedBy}`);
      lines.push(`- ratifiedAt: ${entry.ratifiedAt}`);
      lines.push(`- originProposal: ${entry.originProposalId}`);
      const policy = policies.find(
        (p) => p.ruleKey === entry.ruleKey && p.version === entry.version,
      );
      if (policy !== undefined) {
        lines.push(`- severity: ${policy.severity}`);
        lines.push(`- assertion: ${policy.assertion}`);
        lines.push(`- evidence: ${chainTraceList(policy.provenance.evidence.map((e) => e.traceId))}`);
      }
      lines.push('');
    }
  }
  lines.push('## Decision log');
  lines.push('');
  const decisions = audit.filter(
    (e) => e.type === 'governance.promote' || e.type === 'governance.reject',
  );
  if (decisions.length === 0) {
    lines.push('_no promote/reject decisions yet_');
  } else {
    for (const e of decisions) {
      const ruleKey = typeof e.payload?.ruleKey === 'string' ? e.payload.ruleKey : '';
      lines.push(`- [${e.seq}] ${e.at} ${e.actor} ${e.type} proposal ${e.payload?.proposalId}${ruleKey.length > 0 ? ` ruleKey ${ruleKey}` : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function chainTraceList(traceIds: string[]): string {
  if (traceIds.length === 0) return '_none_';
  const shown = traceIds.slice(0, 20).join(', ');
  return traceIds.length > 20 ? `${shown}, … (${traceIds.length} total)` : shown;
}

export type { Policy, AuditEvent };
