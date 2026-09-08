/**
 * Slice 2 verification (04): tests/integration/langfuse-adapter.test.ts —
 * Langfuse v4 HTTP adapter against the in-process fake server replaying the
 * committed refunds fixture pages. Every 04 case is covered: cursor walk to
 * end, 429+Retry-After, 5xx exhaustion → source-down, 401 → auth-failed with
 * zero retries, cross-origin redirect fails closed, timeout path — plus URL
 * builders, lenient parsePage and listProjects/Basic-auth checks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { isCanonError } from '../../src/core/errors.js';
import type { CanonError } from '../../src/core/errors.js';
import { observationsUrl, scoresUrl, createLangfuseSource } from '../../src/trace/langfuse/client.js';
import { parsePage } from '../../src/trace/langfuse/normalize.js';
import type { ObsQuery, ScoreQuery } from '../../src/trace/traceSource.js';
import type { LfObservationRow, LfScoreRow } from '../../src/trace/types.js';
import { startFakeLangfuseServer } from '../fixtures/fakeLangfuseServer.js';
import type { FakeServerHandle } from '../fixtures/fakeLangfuseServer.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const servers: FakeServerHandle[] = [];
async function boot(opts?: Parameters<typeof startFakeLangfuseServer>[0]): Promise<FakeServerHandle> {
  const s = await startFakeLangfuseServer(opts);
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

// The fixture server honors Langfuse window params (SHOULD-3): it filters
// replayed pages to [from, to) and ends the cursor chain past the window, so
// the adapter walks use the window that covers the WHOLE corpus — otherwise
// the chain would stop at the first out-of-window page.
const WINDOW = {
  from: REFUNDS.window.from,
  to: REFUNDS.window.to,
};

const OBS_QUERY: ObsQuery = {
  projectId: 'prj-refunds',
  window: WINDOW,
  environment: ['production'],
};

const SCORE_QUERY: ScoreQuery = {
  projectId: 'prj-refunds',
  window: WINDOW,
  environment: ['production'],
};

function sourceFor(server: FakeServerHandle, http?: { maxRetries?: number; retryBaseMs?: number; requestTimeoutMs?: number }) {
  return createLangfuseSource({
    baseUrl: server.baseUrl,
    publicKey: 'pk-demo',
    secretKey: 'sk-demo',
    http,
  });
}

async function walkObservations(http?: { maxRetries?: number; retryBaseMs?: number; requestTimeoutMs?: number }) {
  const server = await boot();
  const source = sourceFor(server, http);
  const rows: LfObservationRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await source.queryObservations(OBS_QUERY, cursor);
    rows.push(...page.data);
    const next = page.meta?.cursor;
    if (next === null || next === undefined || next === '') break;
    cursor = next;
  }
  return { server, rows };
}

describe('langfuse-v4 adapter (slice 2)', () => {
  it('cursor walk to end over v2 observations pages', async () => {
    const { server, rows } = await walkObservations();
    // grown DEC-12 corpus: 15 pages x 8 rows = 120 lines incl. 2 duplicate ids
    expect(rows).toHaveLength(REFUNDS.observationRowLines);
    expect(new Set(rows.map((r) => r.id)).size).toBe(REFUNDS.uniqueObservationRows);
    const obsRequests = server.requests().filter((r) => r.route === 'observations');
    expect(obsRequests).toHaveLength(REFUNDS.observationPages);
    // rows share traceId / parentObservationId hierarchy (fixture model)
    const byId = new Map(rows.map((r) => [r.id, r]));
    const agent1 = byId.get('obs_refund_agent_1');
    expect(agent1?.type).toBe('AGENT');
    expect(agent1?.isRootObservation).toBe(true);
    expect(byId.get('obs_refund_tool_1')?.parentObservationId).toBe('obs_refund_agent_1');
    const types = new Set(rows.map((r) => r.type));
    expect(types.has('TOOL')).toBe(true);
    expect(types.has('GENERATION')).toBe(true);
    expect(types.has('SPAN')).toBe(true);
    expect(new Set(rows.map((r) => r.traceName))).toEqual(new Set(REFUNDS.taskKeys));
    // extra/unknown keys preserved verbatim (tolerant of upstream growth)
    expect((agent1 as Record<string, unknown>).samplingWeight).toBe(0.5);
    // cursor param threaded between pages: page-01's meta.cursor is the token for page-02
    expect(obsRequests[0]?.query.cursor).toBeUndefined();
    expect(obsRequests[1]?.query.cursor).toEqual(['cursor-obs-1']);
  });

  it('cursor walk to end over v3 scores pages (scores on their own route)', async () => {
    const server = await boot();
    const source = sourceFor(server);
    const rows: LfScoreRow[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await source.queryScores(SCORE_QUERY, cursor);
      rows.push(...page.data);
      const next = page.meta?.cursor;
      if (next === null || next === undefined || next === '') break;
      cursor = next;
    }
    expect(rows).toHaveLength(REFUNDS.scoreRows);
    expect(server.requests().filter((r) => r.route === 'scores')).toHaveLength(
      REFUNDS.scorePages,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('score_refund_1')?.subject?.kind).toBe('TRACE');
    expect(byId.get('score_tool_1')?.subject?.kind).toBe('OBSERVATION');
    expect(byId.get('score_refund_1')?.traceId).toBe('tr_refund_1');
  });

  it('listProjects parses the projects fixture and sends Basic auth', async () => {
    const server = await boot();
    const source = sourceFor(server);
    const projects = await source.listProjects();
    expect(projects).toEqual([{ id: 'prj-refunds', name: 'Refunds demo' }]);
    const req = server.requests()[0]!;
    const expected = `Basic ${Buffer.from('pk-demo:sk-demo').toString('base64')}`;
    expect(req.authorization).toBe(expected);
    expect(req.pathname).toBe('/api/public/projects');
    expect(source.kind).toBe('langfuse-v4');
  });

  it('429 with Retry-After: seconds → honours the delay, then succeeds (no early call)', async () => {
    const server = await boot({
      behaviors: [
        { route: 'observations', times: 1, status: 429, headers: { 'retry-after': '1' } },
      ],
    });
    const source = sourceFor(server, { maxRetries: 3, retryBaseMs: 5 });
    const page = await source.queryObservations(OBS_QUERY);
    expect(page.data.length).toBeGreaterThan(0); // first fixture page served after the 429
    const reqs = server.requests().filter((r) => r.route === 'observations');
    expect(reqs).toHaveLength(2); // exactly one retry, none before Retry-After
    const gap = reqs[1]!.at - reqs[0]!.at;
    expect(gap).toBeGreaterThanOrEqual(900); // Retry-After: 1s honoured
  });

  it('5xx exhausting retries → CanonError source-down', async () => {
    const server = await boot({
      behaviors: [{ route: 'observations', times: 3, status: 500 }],
    });
    const source = sourceFor(server, { maxRetries: 2, retryBaseMs: 2 });
    await expect(source.queryObservations(OBS_QUERY)).rejects.toMatchObject({
      code: 'source-down',
      retryable: true,
    });
    const obs = server.requests().filter((r) => r.route === 'observations');
    expect(obs).toHaveLength(3); // initial + 2 retries, then exhausted
  });

  it('401 → auth-failed with zero retries', async () => {
    const server = await boot({
      behaviors: [{ route: 'observations', times: 5, status: 401 }],
    });
    const source = sourceFor(server, { maxRetries: 5, retryBaseMs: 2 });
    await expect(source.queryObservations(OBS_QUERY)).rejects.toMatchObject({
      code: 'auth-failed',
      retryable: false,
    });
    const obs = server.requests().filter((r) => r.route === 'observations');
    expect(obs).toHaveLength(1); // never retried
  });

  it('cross-origin redirect fails closed (target origin never contacted)', async () => {
    const target = await boot(); // innocent bystander — must receive nothing
    const server = await boot({
      behaviors: [
        {
          route: 'observations',
          status: 302,
          headers: { location: `${target.url}/api/public/v2/observations` },
        },
      ],
    });
    const source = sourceFor(server, { maxRetries: 0, retryBaseMs: 2 });
    const err: unknown = await source.queryObservations(OBS_QUERY).catch((e) => e);
    expect(isCanonError(err)).toBe(true);
    expect((err as CanonError).code).toBe('source-down');
    expect(target.requests()).toHaveLength(0); // redirect never followed
  });

  it('timeout path → CanonError timeout', async () => {
    const server = await boot({
      behaviors: [{ route: 'observations', status: 200, delayMs: 400 }],
    });
    const source = sourceFor(server, { requestTimeoutMs: 60, maxRetries: 0, retryBaseMs: 2 });
    await expect(source.queryObservations(OBS_QUERY)).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('observationsUrl / scoresUrl carry the documented params (cursor contract)', () => {
    const obs = observationsUrl(OBS_QUERY);
    expect(obs.pathname).toBe('/v2/observations');
    const p = obs.searchParams;
    expect(p.get('projectId')).toBe('prj-refunds');
    expect(p.get('fromStartTime')).toBe(WINDOW.from);
    expect(p.get('toStartTime')).toBe(WINDOW.to);
    expect(p.get('limit')).toBe('1000');
    const fields = p.get('fields') ?? '';
    expect(fields).toContain('core');
    expect(fields).toContain('io');
    expect(fields).not.toContain('prompt'); // prompt group omitted in v0.1 [ASSUMPTION]
    expect(p.getAll('environment')).toEqual(['production']);
    expect(obs.searchParams.get('cursor')).toBeNull();
    const withCursor = observationsUrl(OBS_QUERY, 'c-1');
    expect(withCursor.searchParams.get('cursor')).toBe('c-1');

    const scores = scoresUrl(SCORE_QUERY);
    expect(scores.pathname).toBe('/v3/scores');
    expect(scores.searchParams.get('fromTimestamp')).toBe(WINDOW.from);
    expect(scores.searchParams.get('toTimestamp')).toBe(WINDOW.to);
    expect(scores.searchParams.get('limit')).toBe('100');
    expect(scores.searchParams.getAll('environment')).toEqual(['production']);
  });

  it('parsePage is lenient on cursor contract and strict on page shape', () => {
    const ok = parsePage<{ a: number }>({ data: [{ a: 1 }], meta: { cursor: 'x', extra: 2 } }, 'label');
    expect(ok.data).toEqual([{ a: 1 }]);
    expect(ok.meta?.cursor).toBe('x');
    expect((ok.meta as Record<string, unknown>).extra).toBe(2);

    expect(parsePage({ data: [] }, 'label').meta?.cursor).toBeUndefined();
    expect(parsePage<{ a: number }>({ data: [{ a: 1 }], meta: { cursor: null } }, 'label').meta?.cursor).toBeNull();
    expect(parsePage<{ a: number }>({ data: [{ a: 1 }], meta: { cursor: '' } }, 'label').meta?.cursor).toBe('');

    expect(() => parsePage({ nope: [] }, 'label')).toThrowError(
      expect.objectContaining({ code: 'validation' }),
    );
    expect(() => parsePage({ data: [42] }, 'label')).toThrowError(
      expect.objectContaining({ code: 'validation' }),
    );
    expect(() => parsePage({ data: 'x' }, 'label')).toThrowError(
      expect.objectContaining({ code: 'validation' }),
    );
  });
});
