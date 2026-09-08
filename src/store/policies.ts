/**
 * store/policies.ts — versioned canon store (02 store layout: one immutable
 * JSON file per ratified policy version under canon/<ruleKey>.v<N>.json).
 * The effective canon = latest version per ruleKey; policy files are
 * append-only — a second proposal with the same ruleKey ratifies as
 * version+1 and NEVER rewrites a prior file (03 [DEC-14] governance note /
 * ADR-0001 DEC-3 atomic immutable files).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonError } from '../core/errors.js';
import { mkdirp } from './atomics.js';
import type { IsoTime } from '../core/time.js';
import type { Coverage, EvidenceLink, GuardConstraints, RuleKind, Severity } from './proposals.js';
import { atomicWriteJson } from './atomics.js';

export interface Policy {
  id: string; // pol_… (this version's id)
  ruleKey: string;
  version: number;
  status: 'active';
  severity: Severity;
  ratifiedAt: IsoTime;
  ratifiedBy: string;
  originProposalId: string;
  ruleText: string;
  assertion: string;
  constraints: GuardConstraints;
  provenance: {
    confidence: number;
    coverage: Coverage;
    evidence: EvidenceLink[];
    proposalEdited: boolean;
    /** prior policy versions for the same ruleKey (the version chain). */
    history: Policy[];
  };
}

export function canonDir(dir: string): string {
  return join(dir, 'canon');
}

export function policyPath(dir: string, ruleKey: string, version: number): string {
  return join(canonDir(dir), `${ruleKey}.v${version}.json`);
}

/** Next version for a ruleKey (0 when none exists yet). */
export async function nextPolicyVersion(dir: string, ruleKey: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(canonDir(dir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 1;
    throw new CanonError(`cannot list ${canonDir(dir)}: ${String(e)}`, { code: 'io', cause: e });
  }
  let max = 0;
  const prefix = `${ruleKey}.v`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const versionText = name.slice(prefix.length, -'.json'.length);
    const version = Number.parseInt(versionText, 10);
    if (Number.isFinite(version) && version > max) max = version;
  }
  return max + 1;
}

/**
 * Write a policy file — IMMUTABLE: writing the same (ruleKey, version) path
 * twice throws invalid-state (03 [DEC-14]: the previous policy file is never
 * rewritten).
 */
export async function writePolicyFile(dir: string, policy: Policy): Promise<void> {
  const path = policyPath(dir, policy.ruleKey, policy.version);
  try {
    await readFile(path, 'utf8');
    throw new CanonError(
      `policy ${policy.ruleKey}.v${policy.version} already exists and is immutable`,
      { code: 'invalid-state' },
    );
  } catch (e) {
    if (e instanceof CanonError) throw e;
    // ENOENT — path is free; fall through to write
  }
  await mkdirp(canonDir(dir), 0o700);
  await atomicWriteJson(path, policy, 0o600);
}

export async function listPolicyFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(canonDir(dir))).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CanonError(`cannot list ${canonDir(dir)}: ${String(e)}`, { code: 'io', cause: e });
  }
}

export async function readPolicyFile(dir: string, fileName: string): Promise<Policy | undefined> {
  try {
    const raw = await readFile(join(canonDir(dir), fileName), 'utf8');
    return JSON.parse(raw) as Policy;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new CanonError(`cannot read canon policy ${fileName}: ${String(e)}`, {
      code: 'store-corrupt',
      cause: e,
    });
  }
}

/**
 * All policies, sorted (ruleKey asc, version asc). The effective canon = the
 * last entry per ruleKey.
 */
export async function listPolicies(dir: string): Promise<Policy[]> {
  const files = await listPolicyFiles(dir);
  const out: Policy[] = [];
  for (const file of files) {
    const policy = await readPolicyFile(dir, file);
    if (policy !== undefined) out.push(policy);
  }
  out.sort((a, b) => {
    if (a.ruleKey !== b.ruleKey) return a.ruleKey < b.ruleKey ? -1 : 1;
    return a.version - b.version;
  });
  return out;
}

/** Effective canon: the latest version per ruleKey. */
export function effectivePolicies(policies: Policy[]): Policy[] {
  const latest = new Map<string, Policy>();
  for (const policy of policies) latest.set(policy.ruleKey, policy);
  return [...latest.values()].sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : 1));
}

export function policyId(ruleKey: string, version: number): string {
  return `${ruleKey}.v${version}`;
}

export type { RuleKind, Severity };
