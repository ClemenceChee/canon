/**
 * Ingest sync-engine verification (04 Slice 3: tests/integration/ingest.test.ts)
 * — real ingest over the fake Langfuse server through the DEFAULT adapter:
 * idempotent backfill with a byte-golden archive, --dry-run writes nothing,
 * injected page-failure resume without duplication, incremental polling from
 * watermarks, DEC-11 http refusal in the source-from-config path, and a CLI
 * end-to-end run.
 */

import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanon, assertBaseUrlAllowed } from '../../src/app.js';
import type { CanonApp } from '../../src/app.js';
import type { CanonConfig } from '../../src/store/index.js';
import { createCanonStore } from '../../src/store/index.js';
import { runCli } from '../../src/cli/main.js';
import { runSync } from '../../src/ingest/sync.js';
import type { TraceSource } from '../../src/trace/traceSource.js';
import type { LfObservationRow } from '../../src/trace/types.js';
import { startFakeLangfuseServer } from '../fixtures/fakeLangfuseServer.js';
import type { FakeServerHandle } from '../fixtures/fakeLangfuseServer.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const WINDOW = REFUNDS.window;
const PROJECT = REFUNDS.projectId;
const INGEST_AT = REFUNDS.ingestAt;
const OBS_UNIQUE = REFUNDS.uniqueObservationRows;
const SCORES = REFUNDS.scoreRows;
const TOTAL = OBS_UNIQUE + SCORES; // full-corpus newRows for one pass

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const servers: FakeServerHandle[] = [];
async function boot(opts?: Parameters<typeof startFakeLangfuseServer>[0]): Promise<FakeServerHandle> {
  const s = await startFakeLangfuseServer(opts);
  servers.push(s);
  return s;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-ingest-'));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

function backfillOpts(extra?: Record<string, unknown>) {
  return {
    mode: 'backfill' as const,
    from: WINDOW.from,
    to: WINDOW.to,
    windowDays: 5, // one chunk covers the whole corpus window
    ...extra,
  };
}

async function connectReal(app: CanonApp, server: FakeServerHandle): Promise<void> {
  await app.connect({
    host: server.url,
    projectId: PROJECT,
    publicKey: 'pk-demo',
    secretKey: 'sk-demo',
  });
}

function frozenApp(
  overrides?: { http?: CanonConfig['settings']['http']; clock?: () => string },
) {
  return createCanon({
    dir,
    clock: overrides?.clock ?? (() => INGEST_AT),
    configOverrides: overrides?.http !== undefined ? { http: overrides.http } : undefined,
  });
}

async function countArchiveLines(name: string): Promise<number> {
  try {
    const raw = await readFile(join(dir, 'archive', name), 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Rows (LINES, incl. duplicate-id lines) a REAL windowed server would return
 * for [from, to) on one route — the fixture server now honors the Langfuse
 * window params the engine sends (SHOULD-3), so this is what a re-poll of an
 * already-archived window fetches (and therefore counts as dupes). The walk
 * mirrors the server's window semantics: pages are replayed newest → oldest
 * and the walk ENDS at the first page whose successor holds nothing ≥ `from`
 * (rows stranded on later pages by the fixture's deliberately out-of-order
 * duplicate lines are unreachable in a windowed walk — Langfuse orders by
 * time, so real projects never strand in-window rows).
 */
async function fixtureLinesInWindow(
  route: 'observations' | 'scores',
  from: string,
  to: string,
): Promise<number> {
  const dirPath = join(FIXTURES_DIR, 'langfuse-http/refunds', route, 'pages');
  const files = (await readdir(dirPath)).filter((x) => x.endsWith('.json')).sort();
  let n = 0;
  for (let i = 0; i < files.length; i += 1) {
    const page = JSON.parse(await readFile(join(dirPath, files[i]!), 'utf8')) as {
      data: Array<Record<string, unknown>>;
    };
    for (const row of page.data) {
      const t = route === 'observations' ? row.startTime : row.timestamp;
      if (typeof t === 'string' && from <= t && t < to) n += 1; // [DEC-08] from incl., to excl.
    }
    const next = files[i + 1];
    if (next === undefined) break;
    const nextPage = JSON.parse(await readFile(join(dirPath, next), 'utf8')) as {
      data: Array<Record<string, unknown>>;
    };
    const nextHoldsWindowRows = nextPage.data.some((row) => {
      const t = route === 'observations' ? row.startTime : row.timestamp;
      return typeof t === 'string' && t >= from;
    });
    if (!nextHoldsWindowRows) break; // server ends the cursor chain here
  }
  return n;
}

describe('ingest sync engine (slice 3)', () => {
  it('backfills the whole corpus: idempotent, byte-golden archive, audit trail', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);

    const r1 = await app.ingest(backfillOpts());
    expect(r1.mode).toBe('backfill');
    expect(r1).toMatchObject({
      windows: 1,
      pages: REFUNDS.observationPages + REFUNDS.scorePages,
      newRows: TOTAL,
      dupes: 2,
    });

    // byte-golden: the store archive equals the committed pre-ingested fixture
    const obsOnDisk = await readFile(join(dir, 'archive/observations.jsonl'), 'utf8');
    const scoresOnDisk = await readFile(join(dir, 'archive/scores.jsonl'), 'utf8');
    const obsGolden = await readFile(join(FIXTURES_DIR, 'archive/refunds/observations.jsonl'), 'utf8');
    const scoresGolden = await readFile(join(FIXTURES_DIR, 'archive/refunds/scores.jsonl'), 'utf8');
    expect(obsOnDisk).toBe(obsGolden);
    expect(scoresOnDisk).toBe(scoresGolden);

    // sync-state checkpoint written; index rebuilt at end of run
    const sync = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(sync.schema).toBe('canon/sync/v1');
    expect(sync.completedWindows.length).toBeGreaterThan(0);
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    expect(index.observationCount).toBe(OBS_UNIQUE);

    // audit: 15+3 ingest.page events + one ingest.complete (plus the connect event)
    const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { type: string });
    expect(audit.filter((e) => e.type === 'ingest.page')).toHaveLength(
      REFUNDS.observationPages + REFUNDS.scorePages,
    );
    expect(audit.filter((e) => e.type === 'ingest.complete')).toHaveLength(1);

    // second identical run: windows already completed → nothing fetched/duplicated
    const r2 = await app.ingest(backfillOpts());
    expect(r2).toMatchObject({ windows: 0, pages: 0, newRows: 0, dupes: 0 });
    expect(await readFile(join(dir, 'archive/observations.jsonl'), 'utf8')).toBe(obsOnDisk);
  });

  it('--dry-run reports the same counts but writes nothing', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);

    const auditBefore = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    const r = await app.ingest(backfillOpts({ dryRun: true }));
    expect(r).toMatchObject({
      windows: 1,
      pages: REFUNDS.observationPages + REFUNDS.scorePages,
      newRows: TOTAL,
      dupes: 2,
    });

    expect(await countArchiveLines('observations.jsonl')).toBe(0);
    expect(await countArchiveLines('scores.jsonl')).toBe(0);
    await expect(stat(join(dir, 'sync-state.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, 'index.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // audit untouched by the dry run (still just the connect event)
    expect(await readFile(join(dir, 'audit.jsonl'), 'utf8')).toBe(auditBefore);
  });

  it('an incremental --dry-run on a populated store counts archived ids in the poll window as dupes', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);
    await app.ingest(backfillOpts());

    // the poll window starts at the stored watermark (WINDOW.to − overlap 24 h)
    // and ends at `later`; the window-aware fixture server only replays rows in
    // it — everything already archived there counts as dupes (SHOULD-3)
    const later = new Date(Date.parse(INGEST_AT) + 2 * 3_600_000).toISOString();
    const pollFrom = new Date(Date.parse(WINDOW.to) - 24 * 3_600_000).toISOString();
    const dry = await app.ingest({ mode: 'incremental', to: later, dryRun: true });
    expect(dry.newRows).toBe(0);
    const inWindowDupes =
      (await fixtureLinesInWindow('observations', pollFrom, later)) +
      (await fixtureLinesInWindow('scores', pollFrom, later));
    expect(dry.dupes).toBe(inWindowDupes); // the poll window's rows, all archived
    // nothing written by the dry run
    expect(await countArchiveLines('observations.jsonl')).toBe(OBS_UNIQUE);
    const sync = await readFile(join(dir, 'sync-state.json'), 'utf8');
    expect(JSON.parse(sync).mode).toBe('backfill'); // untouched by the dry run
  });

  it('resumes after an injected mid-run failure without duplicating rows', async () => {
    const server = await boot({
      // fail obs request #4 (after three pages were appended) with a 5xx;
      // maxRetries 0 means the http layer stops on the very first 500
      behaviors: [{ route: 'observations', after: 3, times: 1, status: 500 }],
    });
    // maxRetries 0: the http layer fails fast so the engine sees the error
    const app = frozenApp({ http: { requestTimeoutMs: 5_000, maxRetries: 0, retryBaseMs: 1 } });
    await connectReal(app, server);

    await expect(app.ingest(backfillOpts())).rejects.toMatchObject({
      code: 'source-down',
      retryable: true,
    });
    // partial progress: first three obs pages appended (24 rows), scores not reached
    expect(await countArchiveLines('observations.jsonl')).toBe(24);
    expect(await countArchiveLines('scores.jsonl')).toBe(0);
    const syncAbort = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(syncAbort.lastRun.aborted).toBe(true);
    expect(syncAbort.completedWindows).toEqual([]); // the window never completed

    // resume on the same server (budget spent): re-walks from page one, dedupes
    const r2 = await app.ingest(backfillOpts());
    // pages 1-3 (24 rows) are dupes; the rest (94 obs + 21 scores) are new;
    // the two duplicate-id lines on the last obs page count as dupes too
    expect(r2.newRows).toBe(OBS_UNIQUE - 24 + SCORES);
    expect(r2.dupes).toBe(24 + 2); // pages 1-3 replayed + the duplicate-id lines

    // final archive matches an uninterrupted run exactly
    const obsFinal = await readFile(join(dir, 'archive/observations.jsonl'), 'utf8');
    const obsGolden = await readFile(join(FIXTURES_DIR, 'archive/refunds/observations.jsonl'), 'utf8');
    expect(obsFinal).toBe(obsGolden);
    const scoreFinal = await readFile(join(dir, 'archive/scores.jsonl'), 'utf8');
    const scoreGolden = await readFile(join(FIXTURES_DIR, 'archive/refunds/scores.jsonl'), 'utf8');
    expect(scoreFinal).toBe(scoreGolden);
  });

  it('incremental polls reuse the watermark: everything already archived is a dupe', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);
    await app.ingest(backfillOpts());

    // two hours later an incremental poll re-scans the overlap + new window
    const later = new Date(Date.parse(INGEST_AT) + 2 * 3_600_000).toISOString();
    const inc = await app.ingest({ mode: 'incremental', to: later });
    expect(inc.mode).toBe('incremental');
    expect(inc.newRows).toBe(0); // the window holds nothing new → zero new rows
    // window-aware server (SHOULD-3): the poll replays ONLY the rows inside
    // [watermark, later); each is already archived → dupe
    const pollFrom = new Date(Date.parse(WINDOW.to) - 24 * 3_600_000).toISOString();
    const inWindowDupes =
      (await fixtureLinesInWindow('observations', pollFrom, later)) +
      (await fixtureLinesInWindow('scores', pollFrom, later));
    expect(inc.dupes).toBe(inWindowDupes);
    const sync = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(sync.mode).toBe('incremental');
    expect(sync.observationWatermark).toBe(new Date(Date.parse(later) - 24 * 3_600_000).toISOString());
  });

  it('plain `canon ingest` on a fresh store defaults to backfill', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);
    const r = await app.ingest(backfillOpts({ mode: undefined }));
    expect(r.mode).toBe('backfill');
    expect(r.newRows).toBe(TOTAL);
  });

  it('SHOULD-3: chunked backfill fetches ONLY the requested windows (fixture server honors Langfuse window params)', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);

    // 1-day chunks over the 5-day corpus, newest → oldest. The window-aware
    // fixture server filters every replayed page to [fromStartTime,
    // toStartTime) / [fromTimestamp, toTimestamp) and ends each walk at the
    // window bound, so the engine's chunk math is actually exercised: every
    // corpus row lands in exactly ONE chunk and no out-of-window row can be
    // archived (a window-math bug would show up as dupes or missing rows).
    const r = await app.ingest({
      mode: 'backfill',
      from: WINDOW.from,
      to: WINDOW.to,
      windowDays: 1,
    });
    expect(r.windows).toBe(5); // five 1-day observation windows (27..31 Aug)
    expect(r.newRows).toBe(TOTAL); // every unique corpus row fetched exactly once
    // the two duplicate-id fixture lines sit out-of-order on the LAST page,
    // which no 1-day window walk reaches (each window's walk ends at the
    // first out-of-window page — real Langfuse orders by time, so it never
    // strands in-window rows) → neither twin is re-fetched → zero dupes
    expect(r.dupes).toBe(0);

    // every fetch carried one of the five UTC-day chunk windows — the engine
    // never let one chunk's walk bleed into another window's rows
    const day = (d: number): string => `2025-08-${String(d).padStart(2, '0')}T00:00:00.000Z`;
    const chunkPairs = new Set([
      `${day(27)}|${day(28)}`,
      `${day(28)}|${day(29)}`,
      `${day(29)}|${day(30)}`,
      `${day(30)}|${day(31)}`,
      `${day(31)}|2025-09-01T00:00:00.000Z`,
    ]);
    const obsReqs = server.requests().filter((x) => x.route === 'observations');
    const scoreReqs = server.requests().filter((x) => x.route === 'scores');
    expect(obsReqs.length).toBeGreaterThan(0);
    expect(scoreReqs.length).toBeGreaterThan(0);
    for (const req of obsReqs) {
      expect(chunkPairs.has(`${req.query.fromStartTime?.[0]}|${req.query.toStartTime?.[0]}`)).toBe(true);
    }
    for (const req of scoreReqs) {
      expect(chunkPairs.has(`${req.query.fromTimestamp?.[0]}|${req.query.toTimestamp?.[0]}`)).toBe(true);
    }

    // only in-window rows can be archived: a second identical run finds every
    // window already completed → nothing fetched, nothing duplicated
    const r2 = await app.ingest({
      mode: 'backfill',
      from: WINDOW.from,
      to: WINDOW.to,
      windowDays: 1,
    });
    expect(r2).toMatchObject({ windows: 0, pages: 0, newRows: 0, dupes: 0 });

    // and a NARROW sub-day window backfills exactly the reachable rows it
    // owns: re-polling [12:00, 23:00) on 31 Aug (not a completed run-1 chunk)
    // fetches ONLY that slice, and every row in it is already archived →
    // all dupes, zero new rows (the fixture's out-of-order dup lines on
    // page-31 are unreachable in a windowed walk — see fixtureLinesInWindow)
    const narrowFrom = '2025-08-31T12:00:00.000Z';
    const narrowTo = '2025-08-31T23:00:00.000Z';
    const narrow = await app.ingest({
      mode: 'backfill',
      from: narrowFrom,
      to: narrowTo,
      windowDays: 5,
    });
    const narrowObs = await fixtureLinesInWindow('observations', narrowFrom, narrowTo);
    const narrowScores = await fixtureLinesInWindow('scores', narrowFrom, narrowTo);
    expect(narrow.windows).toBe(1);
    expect(narrow.newRows).toBe(0);
    expect(narrow.dupes).toBe(narrowObs + narrowScores);
  });

  it('ingest rejects plain-http config for a non-loopback host (DEC-11)', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);

    // hand-edit config to a non-loopback http baseUrl — must refuse, not send keys
    const store = createCanonStore(dir);
    await store.open();
    const cfg = (await store.readConfig())!;
    cfg.connection.baseUrl = 'http://example.com/api/public';
    cfg.settings.http = { requestTimeoutMs: 500, maxRetries: 0, retryBaseMs: 1 };
    await store.writeConfig(cfg);

    await expect(app.ingest(backfillOpts())).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('plain http is refused'),
    });
    // the escape hatch passes the origin gate (unit-level; no network attempted)
    expect(() => assertBaseUrlAllowed('http://example.com/api/public', { insecureHttp: true })).not.toThrow();
    expect(() => assertBaseUrlAllowed('https://example.com/api/public')).not.toThrow();
    expect(() => assertBaseUrlAllowed('http://127.0.0.1:4318/api/public')).not.toThrow();
    expect(() => assertBaseUrlAllowed('http://example.com/api/public')).toThrowError(
      expect.objectContaining({ code: 'validation' }),
    );
    await store.close();
  });

  it('--small-pages halves the page limit until a retryable page failure clears', async () => {
    const server = await boot({
      // page-size-style failure: any request with limit > 50 fails (5x budget),
      // until the engine halves the limit down to ≤ 50 and the page is served
      behaviors: [{ route: 'observations', whenLimitAbove: 50, times: 5, status: 500 }],
    });
    const app = frozenApp({ http: { requestTimeoutMs: 5_000, maxRetries: 0, retryBaseMs: 1 } });
    await connectReal(app, server);

    const r = await app.ingest({ mode: 'backfill', from: WINDOW.from, to: WINDOW.to, windowDays: 5, smallPages: true });
    expect(r.newRows).toBe(TOTAL); // halving recovered page one; the run completed
    const obsReqs = server.requests().filter((x) => x.route === 'observations');
    // page-01: 1000→500→250→125→62 fail (5) then 31 succeeds; pages 2..15 succeed
    expect(obsReqs).toHaveLength(5 + REFUNDS.observationPages);
    // and the limits sent really halved
    const limits = obsReqs.map((x) => Number(x.query.limit?.[0]));
    expect(limits.slice(0, 5)).toEqual([1000, 500, 250, 125, 62]);
    expect(limits[5]).toBe(31);
  });

  it('without --small-pages the same failure aborts the run', async () => {
    const server = await boot({
      behaviors: [{ route: 'observations', whenLimitAbove: 50, times: 5, status: 500 }],
    });
    const app = frozenApp({ http: { requestTimeoutMs: 5_000, maxRetries: 0, retryBaseMs: 1 } });
    await connectReal(app, server);
    await expect(
      app.ingest({ mode: 'backfill', from: WINDOW.from, to: WINDOW.to, windowDays: 5 }),
    ).rejects.toMatchObject({ code: 'source-down', retryable: true });
    expect(await countArchiveLines('observations.jsonl')).toBe(0);
  });

  it('CLI: connect then ingest --backfill reports the corpus; second run reports new rows 0', async () => {
    const server = await boot();
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    try {
      const connectCode = await runCli([
        'connect', '--host', server.url, '--project', PROJECT,
        '--public-key', 'pk-demo', '--secret-key', 'sk-demo', '--dir', dir,
      ]);
      expect(connectCode).toBe(0);

      out.length = 0;
      const ingest1 = await runCli([
        'ingest', '--backfill', '--dir', dir,
        '--from', WINDOW.from, '--to', WINDOW.to, '--window-days', '5',
      ]);
      expect(ingest1).toBe(0);
      const text1 = out.join('\n');
      expect(text1).toContain('ingest complete (backfill)');
      expect(text1).toContain(`new rows ${TOTAL}`);
      expect(text1).toContain('dupes 2');

      out.length = 0;
      const ingest2 = await runCli([
        'ingest', '--backfill', '--dir', dir,
        '--from', WINDOW.from, '--to', WINDOW.to, '--window-days', '5',
      ]);
      expect(ingest2).toBe(0);
      expect(out.join('\n')).toContain('new rows 0');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('DEC-19: a scores-route failure mid-run resumes by skipping the completed observations window', async () => {
    const server = await boot({
      // observations complete; the scores walk fails on its 3rd page request
      // (2 score pages already appended) with a 5xx; maxRetries 0 fails fast
      behaviors: [{ route: 'scores', after: 2, times: 1, status: 500 }],
    });
    const app = frozenApp({ http: { requestTimeoutMs: 5_000, maxRetries: 0, retryBaseMs: 1 } });
    await connectReal(app, server);

    await expect(app.ingest(backfillOpts())).rejects.toMatchObject({
      code: 'source-down',
      retryable: true,
    });
    // observations completed in full; scores stopped after the first two pages
    expect(await countArchiveLines('observations.jsonl')).toBe(OBS_UNIQUE);
    const scoreDir = join(FIXTURES_DIR, 'langfuse-http/refunds/scores/pages');
    const scorePageRows: number[] = [];
    for (const name of (await readdir(scoreDir)).filter((n) => n.endsWith('.json')).sort()) {
      const page = JSON.parse(await readFile(join(scoreDir, name), 'utf8')) as {
        data: unknown[];
      };
      scorePageRows.push(page.data.length);
    }
    const partialScores = scorePageRows[0]! + scorePageRows[1]!; // first two pages archived
    expect(await countArchiveLines('scores.jsonl')).toBe(partialScores);
    // kind-scoped checkpoint: the observations window is complete, scores' is not
    const syncAbort = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(syncAbort.lastRun.aborted).toBe(true);
    expect(syncAbort.completedWindows).toEqual([
      expect.objectContaining({ kind: 'observation' }),
    ]);
    expect(syncAbort.completedWindows.some((w: { kind?: string }) => w.kind === 'score')).toBe(false);

    // resume: the completed obs window is skipped (zero obs requests), the
    // scores walk finishes, nothing is duplicated
    const obsRequestsBefore = server.requests().filter((r) => r.route === 'observations').length;
    const r2 = await app.ingest(backfillOpts());
    expect(r2.windows).toBe(0); // obs window counted complete at resume
    expect(server.requests().filter((r) => r.route === 'observations').length).toBe(
      obsRequestsBefore, // observations were NOT re-walked
    );
    expect(r2.newRows).toBe(SCORES - partialScores);
    expect(r2.dupes).toBe(partialScores);

    // final archive byte-equals an uninterrupted run
    const obsFinal = await readFile(join(dir, 'archive/observations.jsonl'), 'utf8');
    const obsGolden = await readFile(join(FIXTURES_DIR, 'archive/refunds/observations.jsonl'), 'utf8');
    expect(obsFinal).toBe(obsGolden);
    const scoreFinal = await readFile(join(dir, 'archive/scores.jsonl'), 'utf8');
    const scoreGolden = await readFile(join(FIXTURES_DIR, 'archive/refunds/scores.jsonl'), 'utf8');
    expect(scoreFinal).toBe(scoreGolden);
  });

  it('DEC-14: an index-rebuild failure leaves the final checkpoint unwritten; the next run refetches and rebuilds', async () => {
    const server = await boot();
    const app = frozenApp();
    await connectReal(app, server);

    // run 1: a full backfill succeeds and writes watermarks + a fresh index
    await app.ingest(backfillOpts());
    const syncAfter1 = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(syncAfter1.lastRun.aborted).toBeUndefined();
    // backfill end `to` = WINDOW.to; watermark = to − overlap(24h)
    const watermark1 = new Date(Date.parse(WINDOW.to) - 24 * 3_600_000).toISOString();
    expect(syncAfter1.observationWatermark).toBe(watermark1);

    // make the next index rebuild fail deterministically: a plain DIRECTORY
    // occupies the index.json path, so the atomic tmp+rename cannot complete
    const indexPath = join(dir, 'index.json');
    await rm(indexPath, { force: true });
    await mkdir(indexPath, { recursive: true });

    // run 2: the incremental poll walks the new window, then the index rebuild
    // throws — the run aborts BEFORE the final checkpoint (watermarks stay put)
    const later = new Date(Date.parse(INGEST_AT) + 2 * 3_600_000).toISOString();
    await expect(app.ingest({ mode: 'incremental', to: later })).rejects.toMatchObject({
      code: 'io',
    });
    const syncAbort = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(syncAbort.lastRun.aborted).toBe(true);
    expect(syncAbort.observationWatermark).toBe(watermark1); // NOT advanced
    expect(syncAbort.scoreWatermark).toBe(watermark1); // scores watermark matches backfill too

    // operator clears the obstruction; run 3 re-polls from the un-advanced
    // watermark (its window moved past it → pages fetched), rebuilds, and only
    // then writes the final checkpoint
    await rm(indexPath, { recursive: true, force: true });
    const later2 = new Date(Date.parse(INGEST_AT) + 4 * 3_600_000).toISOString();
    const r3 = await app.ingest({ mode: 'incremental', to: later2 });
    expect(r3.pages).toBeGreaterThan(0); // refetched — the stale index was not trusted
    const syncAfter3 = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(syncAfter3.lastRun.aborted).toBeUndefined();
    expect(syncAfter3.observationWatermark).toBe(
      new Date(Date.parse(later2) - 24 * 3_600_000).toISOString(),
    );
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    expect(index.observationCount).toBe(OBS_UNIQUE);
    expect(index.traceCount).toBe(REFUNDS.traces);
  });

  it('SIGINT graceful stop (04 Slice 7 / 02): abort() mid-run finishes the page, checkpoints aborted and a rerun resumes to the full corpus', async () => {
    // Deterministic seam test: the CLI/OS SIGINT handler sets the abort
    // callback; here we drive runSync directly with an abort that fires after
    // the first observation page of a two-page window.
    const store = createCanonStore(dir);
    await store.open();
    const obsRow = (id: string): LfObservationRow => ({
      id,
      traceId: `tr_abort_${id}`,
      projectId: 'prj-abort',
      type: 'AGENT',
      name: 'abort-agent',
      level: 'INFO',
      environment: 'production',
      isRootObservation: true,
      parentObservationId: null,
      startTime: '2025-09-01T00:00:00.000Z',
      endTime: '2025-09-01T00:00:05.000Z',
      traceName: 'abort_task',
      statusMessage: '',
    });
    const pages = {
      obs1: { data: [obsRow('a1'), obsRow('a2'), obsRow('a3'), obsRow('a4')], meta: { cursor: 'c1' } },
      obs2: { data: [obsRow('b1'), obsRow('b2'), obsRow('b3'), obsRow('b4')], meta: { cursor: null } },
    };
    const source: TraceSource = {
      kind: 'abort-double',
      listProjects: async () => [],
      queryObservations: async (_q, cursor) =>
        cursor === undefined || cursor === '' ? pages.obs1 : cursor === 'c1' ? pages.obs2 : { data: [], meta: { cursor: null } },
      queryScores: async () => ({ data: [], meta: { cursor: null } }),
    };
    const calls = { n: 0 };
    const baseOpts = {
      store,
      source,
      clock: (): string => INGEST_AT,
      projectId: 'prj-abort',
      environment: ['production'],
      settings: { backfillWindowDays: 1, incrementalOverlapHours: 24, politeDelayMs: 0 },
      mode: 'backfill' as const,
      windowDays: 5,
      from: '2025-09-01T00:00:00.000Z',
      to: '2025-09-01T02:00:00.000Z',
    };
    const r1 = await runSync({
      ...baseOpts,
      abort: () => {
        calls.n += 1;
        return calls.n >= 1; // fire after the first page boundary
      },
    });
    expect(r1.aborted).toBe(true);
    expect(r1.pages).toBe(1); // finished the page in flight, stopped before the next
    const syncAbort = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(syncAbort.lastRun.aborted).toBe(true);
    expect(syncAbort.observationWatermark).toBeNull(); // never advanced
    expect(syncAbort.completedWindows).toEqual([]); // the interrupted window is not complete
    expect(await countArchiveLines('observations.jsonl')).toBe(4); // page 1 rows appended
    const auditAfterAbort = (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
      .split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as { type: string });
    expect(auditAfterAbort.filter((e) => e.type === 'ingest.complete')).toHaveLength(0);

    // rerun WITHOUT the abort: resumes from the checkpoint, dedupes page 1 and
    // finishes the corpus + a clean final checkpoint
    const r2 = await runSync(baseOpts);
    expect(r2.aborted).toBeUndefined();
    expect(r2.newRows).toBe(4); // page-1 rows were already archived (dupes)
    expect(r2.dupes).toBe(4);
    expect(await countArchiveLines('observations.jsonl')).toBe(8);
    const syncAfter = JSON.parse(await readFile(join(dir, 'sync-state.json'), 'utf8'));
    expect(syncAfter.lastRun.aborted).toBeUndefined();
    expect(syncAfter.observationWatermark).not.toBeNull();
    await store.close();
  });
});
