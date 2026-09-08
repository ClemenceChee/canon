/**
 * Slice 6 unit tests (04: tests/unit/metrics.test.ts) — TTRP + precision14
 * hand-computed from scripted audit sequences (03 testing plan: "metrics:
 * hand-computed fixture audit → exact ttrp / precision14 incl. null and
 * 14-day-boundary cases (13 d counts, 15 d does not)").
 */

import { describe, expect, it } from 'vitest';
import { computeMetrics, PRECISION14_WINDOW_MS } from '../../src/metrics/metrics.js';
import type { AuditEvent } from '../../src/store/audit.js';
import type { Proposal } from '../../src/store/proposals.js';

const PROJECT = 'prj-refunds';
const T0 = '2025-09-01T09:00:00.000Z'; // connect
const NOW = '2025-11-01T09:00:00.000Z';

let seq = 0;
function ev(type: AuditEvent['type'], at: string, payload: Record<string, unknown>): AuditEvent {
  seq += 1;
  return { seq, at, actor: type.startsWith('governance') ? 'tester' : 'system', type, projectId: PROJECT, payload };
}

function proposal(partial: Partial<Proposal> & { id: string; status: Proposal['status'] }): Proposal {
  return {
    ruleKey: 'side-effect-retry-chargeback-task-charge-reversal',
    kind: 'side-effect-retry',
    severity: 'advisory',
    title: 't',
    ruleText: 'rt',
    assertion: 'a',
    constraints: {},
    confidence: 0.5,
    coverage: {
      traces: 1, observations: 1, agents: 1, sessions: 1,
      window: { from: T0, to: T0 }, environments: ['production'], consistency: 1,
    },
    evidence: [],
    conflictsWith: [],
    createdAt: T0,
    updatedAt: T0,
    origin: { runId: 'run_1', analyzerVersion: '0.1.0' },
    ...partial,
  };
}

function created(id: string, at: string): AuditEvent {
  return ev('proposal.created', at, { proposalId: id, ruleKey: 'x', kind: 'side-effect-retry', runId: 'run_1' });
}
function promote(id: string, at: string): AuditEvent {
  return ev('governance.promote', at, { proposalId: id, ruleKey: 'x', version: 1 });
}
function reject(id: string, at: string): AuditEvent {
  return ev('governance.reject', at, { proposalId: id, ruleKey: 'x' });
}

function addHours(iso: string, h: number): string {
  return new Date(Date.parse(iso) + h * 3_600_000).toISOString();
}
function addDays(iso: string, d: number): string {
  return new Date(Date.parse(iso) + d * 86_400_000).toISOString();
}

describe('computeMetrics (slice 6)', () => {
  it('TTRP = earliest connect → earliest promote (ms), with queue counts', () => {
    seq = 0;
    const audit = [
      ev('connect', T0, {}),
      created('prop_1', addHours(T0, 1)),
      promote('prop_1', addHours(T0, 5)),
    ];
    const m = computeMetrics(audit, [proposal({ id: 'prop_1', status: 'ratified' })], NOW);
    expect(m.projectId).toBe(PROJECT);
    expect(m.connectedAt).toBe(T0);
    expect(m.firstPromoteAt).toBe(addHours(T0, 5));
    expect(m.ttrp).toEqual({ ms: 5 * 3_600_000 });
    expect(m.proposals).toEqual({ total: 1, pending: 0, ratified: 1, rejected: 0, decayed: 0 });
  });

  it('ttrp is null before any ratified policy (still has a connect)', () => {
    seq = 0;
    const m = computeMetrics([ev('connect', T0, {})], [], NOW);
    expect(m.ttrp).toBeNull();
    expect(m.firstPromoteAt).toBeNull();
  });

  it('precision14: ratified within 14 days of creation counts (13 d in, 15 d out)', () => {
    seq = 0;
    // prop_13: created + promoted 13 days later → within the window
    // prop_15: created + promoted 15 days later → outside the window
    const audit = [
      ev('connect', T0, {}),
      created('prop_13', T0),
      created('prop_15', T0),
      promote('prop_13', addDays(T0, 13)),
      promote('prop_15', addDays(T0, 15)),
    ];
    const m = computeMetrics(audit, [], NOW);
    expect(m.precision14).toEqual({ numerator: 1, denominator: 1, ratio: 1 });
    // a rejected proposal inside the window widens the denominator
    const audit2 = [...audit, created('prop_rej', T0), reject('prop_rej', addDays(T0, 2))];
    const m2 = computeMetrics(audit2, [], NOW);
    expect(m2.precision14).toEqual({ numerator: 1, denominator: 2, ratio: 0.5 });
  });

  it('precision14 is null when no decisions fall in the measurement window', () => {
    seq = 0;
    const audit = [ev('connect', T0, {}), created('prop_x', T0)];
    const m = computeMetrics(audit, [proposal({ id: 'prop_x', status: 'pending' })], NOW);
    expect(m.precision14).toEqual({ numerator: 0, denominator: 0, ratio: null });
  });

  it('decayed proposals are excluded from the denominator (no decision event)', () => {
    seq = 0;
    const audit = [
      ev('connect', T0, {}),
      created('prop_decayed', T0),
      ev('proposal.decayed', addDays(T0, 100), { proposalId: 'prop_decayed', ruleKey: 'x' }),
    ];
    const m = computeMetrics(audit, [proposal({ id: 'prop_decayed', status: 'decayed' })], NOW);
    expect(m.precision14).toEqual({ numerator: 0, denominator: 0, ratio: null });
    // the queue counts still report the decayed state
    expect(m.proposals.decayed).toBe(1);
  });

  it('the measurement window constant is 14 days', () => {
    expect(PRECISION14_WINDOW_MS).toBe(14 * 86_400_000);
  });

  it('is deterministic and ignores the current time argument', () => {
    seq = 0;
    const audit = [
      ev('connect', T0, {}),
      created('prop_1', T0),
      promote('prop_1', addHours(T0, 2)),
    ];
    const a = computeMetrics(audit, [], '2025-09-02T00:00:00.000Z');
    const b = computeMetrics(audit, [], '2030-01-01T00:00:00.000Z');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.ttrp).toEqual({ ms: 2 * 3_600_000 });
  });
});
