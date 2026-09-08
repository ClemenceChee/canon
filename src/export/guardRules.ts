/**
 * export/guardRules.ts (04 Slice 6 / 03 Policy + guard-rules export) — the
 * vendor-neutral guard-rule pack writer (schema canon/guard-rules/v1).
 *
 * The pack is built from the EFFECTIVE canon (latest version per ruleKey of
 * the ratified policies) — 02: "One command exports today's canon as a
 * guard-rule pack your enforcement layer consumes". Every exported field is
 * structural/provenance content only (rule text is template-built from
 * structural tokens [DEC-07]; evidence links carry trace/observation IDs;
 * provenance is ids/counts/times + the reviewer handle). Raw io content and
 * keys NEVER enter the export surface (02 security + DEC-4 redaction-on-by-
 * default is trivially satisfied — there is no content-class data to emit;
 * mirroring the proposals-view convention).
 *
 * `scope.agents` cannot come from the persisted Policy alone (Coverage.agents
 * is a count; the agent names live in the index trace summaries), so the
 * builder takes an additive `traceAgents` lookup (review slice-6 seam note:
 * "derive agent names per rule from evidence trace summaries (index.json
 * TraceSummary.agentId)") — the app layer reads the index and passes it.
 *
 * Rule `id` is deterministic (`<ruleKey>.v<version>` — the policy FILE is
 * canon/<ruleKey>.v<N>.json) so export goldens stay byte-stable and are never
 * keyed on generated ids (04: goldens "never by generated ids").
 */

import type { Policy } from '../store/policies.js';
import type { Coverage, EvidenceLink, GuardConstraints, RuleKind, Severity } from '../store/proposals.js';
import { RULE_KINDS } from '../store/proposals.js';
import { CanonError } from '../core/errors.js';
import type { IsoTime } from '../core/time.js';
import type { CanonStore } from '../store/index.js';
import { findDanglingEvidenceTraceIds } from './evidence.js';

export interface GuardRulePackMeta {
  projectId: string;
  exportedAt: IsoTime;
  /** Generation of the canon policy store (1 for v1) — not the tool version. */
  canonVersion: number;
  source: { tool: 'canon'; version: string };
}

export interface GuardRuleScope {
  environments: string[];
  agents: string[];
  taskKeys: string[];
}

export interface GuardRuleProvenance {
  proposalId: string;
  confidence: number;
  coverage: Coverage;
  evidence: EvidenceLink[];
  ratifiedBy: string;
  ratifiedAt: IsoTime;
}

export interface GuardRule {
  id: string;
  ruleKey: string;
  kind: RuleKind;
  severity: Severity;
  version: number;
  assertion: string;
  scope: GuardRuleScope;
  constraints: GuardConstraints;
  provenance: GuardRuleProvenance;
}

export interface GuardRulesPack {
  schema: 'canon/guard-rules/v1';
  meta: GuardRulePackMeta;
  rules: GuardRule[];
}

export interface BuildGuardRulesOptions {
  /** traceId → agentId (from index.json TraceSummary) for scope.agents derivation. */
  traceAgents?: ReadonlyMap<string, string | undefined>;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Rule kind from a ruleKey. Policy files persist no kind field (03 Policy),
 * but every ruleKey is built as `<kind>-<task/tool tokens>` (DEC-21), so a
 * prefix match IS the kind — deterministic and loss-free for keys canon
 * itself created. Anything else means foreign/corrupt state → refuse loudly.
 */
export function kindOfRuleKey(ruleKey: string): RuleKind {
  const known = RULE_KINDS.find(
    (k) => ruleKey === k || ruleKey.startsWith(`${k}-`),
  );
  if (known !== undefined) return known;
  throw new CanonError(`policy ruleKey ${JSON.stringify(ruleKey)} does not carry a known kind`, {
    code: 'internal',
    hint: 'the canon store holds a rule key canon did not create',
  });
}

/**
 * Effective canon → pack. Deterministic: effective rules are emitted sorted
 * by ruleKey; rule ids derive from (ruleKey, version); scope arrays are
 * sorted unique.
 */
export function buildGuardRulesPack(
  policies: Policy[],
  meta: GuardRulePackMeta,
  opts?: BuildGuardRulesOptions,
): GuardRulesPack {
  const traceAgents = opts?.traceAgents;
  // effective canon = latest version per ruleKey (03 effectivePolicies)
  const latest = new Map<string, Policy>();
  for (const policy of policies) latest.set(policy.ruleKey, policy);

  const rules: GuardRule[] = [];
  for (const ruleKey of [...latest.keys()].sort()) {
    const policy = latest.get(ruleKey)!;
    const agents = sortedUnique(
      policy.provenance.evidence
        .map((e) => (traceAgents === undefined ? undefined : traceAgents.get(e.traceId)))
        .filter((a): a is string => a !== undefined && a.length > 0),
    );
    rules.push({
      id: `${policy.ruleKey}.v${policy.version}`,
      ruleKey: policy.ruleKey,
      kind: kindOfRuleKey(policy.ruleKey),
      severity: policy.severity,
      version: policy.version,
      assertion: policy.assertion,
      scope: {
        environments: sortedUnique(policy.provenance.coverage.environments),
        agents,
        taskKeys: sortedUnique(policy.constraints.taskKeys ?? []),
      },
      constraints: policy.constraints,
      provenance: {
        proposalId: policy.originProposalId,
        confidence: policy.provenance.confidence,
        coverage: policy.provenance.coverage,
        evidence: policy.provenance.evidence,
        ratifiedBy: policy.ratifiedBy,
        ratifiedAt: policy.ratifiedAt,
      },
    });
  }
  return { schema: 'canon/guard-rules/v1', meta, rules };
}

/**
 * Verify that every exported rule's evidence traceIds resolve in the archive
 * (used by `canon export --verify-links`). Returns one entry per rule with
 * dangling evidence links; an empty result means every link resolves.
 * Evidence is the compliance backbone — a policy whose traces were purged
 * (or a --wipe project switch that left artifacts behind) must be caught.
 * CAN-103: delegates to the shared export/evidence helper that the
 * `governance promote` pre-ratification gate uses, so both paths share one
 * definition of dangling.
 */
export async function verifyEvidenceLinks(
  pack: GuardRulesPack,
  store: CanonStore,
): Promise<Array<{ ruleId: string; dangling: number }>> {
  const out: Array<{ ruleId: string; dangling: number }> = [];
  for (const rule of pack.rules) {
    const missing = await findDanglingEvidenceTraceIds(rule.provenance.evidence, store);
    if (missing.length > 0) out.push({ ruleId: rule.id, dangling: missing.length });
  }
  return out;
}

export type { Policy };
