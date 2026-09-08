/**
 * Proposal persistence (02 store layout: one JSON file per stateful proposal
 * under proposals/, named `<id>.json`; lifecycle pending → ratified|rejected|
 * decayed). Domain types per 03's Propose section are co-located here because
 * the Proposal *file* is the store record (02 Data); later slices'
 * propose/governance modules import these types from this module.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonError } from '../core/errors.js';
import type { IsoTime } from '../core/time.js';
import type { TimeWindow } from '../trace/traceSource.js';
import { atomicWriteJson } from './atomics.js';

export const RULE_KINDS = [
  'tool-choice',
  'side-effect-retry',
  'retry-budget',
  'failure-escalation',
  'model-usage',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export type Severity = 'mandatory' | 'advisory';
export type ProposalStatus = 'pending' | 'ratified' | 'rejected' | 'decayed';

/** Vendor-neutral guard conditions — the enforcement plane decides semantics. */
export interface GuardConstraints {
  tool?: string;
  tools?: string[];
  taskKeys?: string[];
  environments?: string[];
  agents?: string[];
  maxAttempts?: number;
  windowSeconds?: number;
  sideEffect?: boolean;
  modelFamily?: string[];
  maxCostRatio?: number;
  minSuccessRate?: number;
}

export interface Coverage {
  traces: number;
  observations: number;
  agents: number;
  sessions: number;
  window: TimeWindow;
  environments: string[];
  consistency: number; // ∈ [0,1]
}

export interface EvidenceLink {
  traceId: string;
  observationIds: string[];
  role: 'supporting' | 'divergent';
}

export interface Proposal {
  id: string;
  ruleKey: string;
  kind: RuleKind;
  status: ProposalStatus;
  severity: Severity; // suggested — human may change on promote --edit
  title: string;
  ruleText: string; // template-built, structural tokens only [DEC-07]
  assertion: string; // human-readable invariant sentence
  constraints: GuardConstraints;
  confidence: number;
  coverage: Coverage;
  evidence: EvidenceLink[];
  conflictsWith: Array<{ id: string; kind: 'canon' | 'proposal'; reason: string }>;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  reviewedAt?: IsoTime;
  reviewedBy?: string;
  reviewAction?: 'promote' | 'reject';
  reviewNote?: string;
  decayedAt?: IsoTime;
  origin: { runId: string; analyzerVersion: string };
}

export function proposalsDir(dir: string): string {
  return join(dir, 'proposals');
}

export function proposalPath(dir: string, id: string): string {
  return join(proposalsDir(dir), `${id}.json`);
}

export async function saveProposal(dir: string, p: Proposal): Promise<void> {
  await atomicWriteJson(proposalPath(dir, p.id), p, 0o600);
}

export async function loadProposal(
  dir: string,
  id: string,
): Promise<Proposal | undefined> {
  try {
    const raw = await readFile(proposalPath(dir, id), 'utf8');
    return JSON.parse(raw) as Proposal;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new CanonError(`cannot read proposal ${id}: ${String(e)}`, {
      code: 'store-corrupt',
      cause: e,
    });
  }
}

/** List persisted proposals (sorted by id for determinism). */
export async function listProposalIds(dir: string): Promise<string[]> {
  try {
    const names = await readdir(proposalsDir(dir));
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .sort();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw new CanonError(`cannot list proposals in ${dir}: ${String(e)}`, {
      code: 'io',
      cause: e,
    });
  }
}
