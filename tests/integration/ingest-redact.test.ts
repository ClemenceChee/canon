/**
 * Acceptance MUST-1 (ADR-0001 DEC-4): ingest-time redaction is REAL. When
 * settings.redact.ingest is on (connect --redact), content-bearing row
 * fields are scrubbed at envelope construction BEFORE the archive write —
 * observation input/output/metadata/statusMessage and score comment. The
 * scrub is structural-field-preserving (ids, keys, timestamps, type/name/
 * level, usage/cost/model prices stay byte-identical) because analyze reads
 * structure only, so a redacted archive yields the same analysis report as a
 * raw one. Default (redact.ingest false) keeps rows verbatim — the committed
 * byte-goldens in ingest.test.ts guard that.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanon } from '../../src/app.js';
import { createRedactor } from '../../src/core/redact.js';
import { runCli } from '../../src/cli/main.js';
import { runSync } from '../../src/ingest/sync.js';
import { createCanonStore } from '../../src/store/index.js';
import type { TraceSource } from '../../src/trace/traceSource.js';
import type { LfObservationRow, LfScoreRow } from '../../src/trace/types.js';
import { startFakeLangfuseServer } from '../fixtures/fakeLangfuseServer.js';
import type { FakeServerHandle } from '../fixtures/fakeLangfuseServer.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const WINDOW = REFUNDS.window;
const PROJECT = REFUNDS.projectId;
const INGEST_AT = REFUNDS.ingestAt;
const OBS_UNIQUE = REFUNDS.uniqueObservationRows;
const SCORES = REFUNDS.scoreRows;
const TOTAL = OBS_UNIQUE + SCORES;

const DIGEST_RE = /^\[redacted:[0-9a-f]{8}\]$/;

/** Content samples from the committed refunds fixture (page-01 / scores page-01). */
const RAW_INPUT = 'Summarise refund R-1001 outcome';
const RAW_OUTPUT = 'Refund issued to customer via standard flow.';
const RAW_STATUS = 'damage photo unclear';
const RAW_COMMENT = 'Correctly issued refund';

const servers: FakeServerHandle[] = [];
async function boot(): Promise<FakeServerHandle> {
  const s = await startFakeLangfuseServer({ scenario: 'refunds' });
  servers.push(s);
  return s;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-redact-'));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

function frozenApp() {
  return createCanon({ dir, clock: () => INGEST_AT });
}

async function readArchives(): Promise<{ obs: string; scores: string }> {
  return {
    obs: await readFile(join(dir, 'archive/observations.jsonl'), 'utf8'),
    scores: await readFile(join(dir, 'archive/scores.jsonl'), 'utf8'),
  };
}

describe('ingest-time redaction (ADR DEC-4 / acceptance MUST-1)', () => {
  it('redact.ingest=true: content fields scrubbed at archive write; structural fields intact; analyze report equals a raw run', async () => {
    const server = await boot();
    const app = frozenApp();
    await app.connect({
      host: server.url,
      projectId: PROJECT,
      publicKey: 'pk-demo',
      secretKey: 'sk-demo',
      redactIngest: true,
    });

    const r = await app.ingest({
      mode: 'backfill',
      from: WINDOW.from,
      to: WINDOW.to,
      windowDays: 5,
    });
    expect(r.newRows).toBe(TOTAL); // same corpus as a raw run

    const { obs, scores } = await readArchives();
    // raw content never lands in the archive
    for (const sample of [RAW_INPUT, RAW_OUTPUT, RAW_STATUS, RAW_COMMENT]) {
      expect(obs + '\n' + scores).not.toContain(sample);
    }
    // digest placeholders landed instead
    expect(obs).toContain('[redacted:');
    expect(scores).toContain('[redacted:');

    // structural fields byte-intact per row: parse every archived row and
    // verify ids/times/usage/costs/names/levels survived the scrub
    const obsRows = obs
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).row as Record<string, unknown>);
    const scoreRows = scores
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).row as Record<string, unknown>);
    expect(obsRows).toHaveLength(OBS_UNIQUE);
    expect(scoreRows).toHaveLength(SCORES);
    const digestFields = ['input', 'output', 'statusMessage'];
    for (const row of obsRows) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.traceId).toBe('string');
      expect(row.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof row.type).toBe('string');
      expect(typeof row.name).toBe('string');
      // usage/cost never scrubbed (analysis ranks models on them)
      if (row.costDetails !== undefined) {
        expect(typeof (row.costDetails as { total?: unknown }).total).toBe('number');
      }
      for (const f of digestFields) {
        const v = row[f];
        if (typeof v === 'string' && v.length > 0) {
          expect(v).toMatch(DIGEST_RE); // non-empty content → digest
        } else {
          expect(v).toBe(''); // empty content passes through (presence signals)
        }
      }
    }
    for (const row of scoreRows) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.name).toBe('string');
      expect(typeof row.value).not.toBe('undefined');
      // comment is the only free-text field on a score row
      const c = row.comment;
      if (c === undefined) continue;
      if (typeof c === 'string' && c.length > 0) expect(c).toMatch(DIGEST_RE);
      else expect(c).toBe('');
    }

    // downstream analyze still works AND is byte-equivalent in its report to
    // a raw run over the same corpus (structure is all it reads)
    const analysis = await app.analyze();
    expect(analysis.trees).toBe(REFUNDS.traces);
    expect(analysis.proposed).toBeGreaterThan(0);

    // companion RAW run in a second store dir (raw corpus committed under
    // tests/fixtures/archive/refunds) — same reports prove scrubbing changed
    // nothing analysis depends on
    const rawDir = await mkdtemp(join(tmpdir(), 'canon-redact-raw-'));
    try {
      const raw = createCanon({ dir: rawDir, clock: () => INGEST_AT });
      await raw.connect({
        host: server.url,
        projectId: PROJECT,
        publicKey: 'pk-demo',
        secretKey: 'sk-demo',
      });
      await raw.ingest({ mode: 'backfill', from: WINDOW.from, to: WINDOW.to, windowDays: 5 });
      const rawAnalysis = await raw.analyze();
      for (const key of [
        'trees',
        'skipped',
        'facts',
        'agents',
        'divergenceGroups',
        'proposed',
        'decayed',
      ] as const) {
        expect(analysis[key]).toBe(rawAnalysis[key]);
      }
      // contrast: the raw archive carries the io content the redacted one lacks
      const rawObs = await readFile(join(rawDir, 'archive/observations.jsonl'), 'utf8');
      expect(rawObs).toContain(RAW_INPUT);
      expect(rawObs).not.toContain('[redacted:');
    } finally {
      await rm(rawDir, { recursive: true, force: true });
    }
  });

  it('CLI: connect --redact persists settings.redact.ingest and a CLI ingest archives scrubbed content', async () => {
    const server = await boot();
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    try {
      const connectCode = await runCli([
        'connect', '--host', server.url, '--project', PROJECT,
        '--public-key', 'pk-demo', '--secret-key', 'sk-demo',
        '--redact', '--dir', dir,
      ]);
      expect(connectCode).toBe(0);
      const cfg = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as {
        settings: { redact: { ingest: boolean } };
      };
      expect(cfg.settings.redact.ingest).toBe(true); // --redact wired to the setting

      out.length = 0;
      err.length = 0;
      const ingestCode = await runCli([
        'ingest', '--backfill', '--dir', dir,
        '--from', WINDOW.from, '--to', WINDOW.to, '--window-days', '5',
      ]);
      expect(ingestCode).toBe(0);
      expect(out.join('\n')).toContain(`new rows ${TOTAL}`);

      const { obs, scores } = await readArchives();
      expect(obs + '\n' + scores).not.toContain(RAW_INPUT);
      expect(obs + '\n' + scores).not.toContain(RAW_COMMENT);
      expect(obs).toContain('[redacted:');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('redact off (default): rows archived verbatim — no digest tokens, raw io present', async () => {
    const server = await boot();
    const app = frozenApp();
    await app.connect({
      host: server.url,
      projectId: PROJECT,
      publicKey: 'pk-demo',
      secretKey: 'sk-demo',
    });
    await app.ingest({ mode: 'backfill', from: WINDOW.from, to: WINDOW.to, windowDays: 5 });
    const { obs } = await readArchives();
    expect(obs).toContain(RAW_INPUT);
    expect(obs).not.toContain('[redacted:');
    // byte-golden against the committed pre-ingested archive (default path)
    const golden = await readFile(join(FIXTURES_DIR, 'archive/refunds/observations.jsonl'), 'utf8');
    expect(obs).toBe(golden);
  });

  it('runSync scrubs exactly the content fields — incl. nested metadata and empty-string preservation — when given an enabled redactor; verbatim without one', async () => {
    const store = createCanonStore(dir);
    await store.open();
    const obsRow = (id: string, statusMessage: string, input: string): LfObservationRow => ({
      id,
      traceId: `tr_scrub_${id}`,
      projectId: 'prj-scrub',
      type: 'TOOL',
      name: 'credential-lookup',
      level: 'INFO',
      environment: 'production',
      isRootObservation: false,
      parentObservationId: 'root',
      startTime: '2025-09-01T00:00:00.000Z',
      endTime: '2025-09-01T00:00:05.000Z',
      traceName: 'scrub_task',
      input,
      output: 'sensitive output',
      metadata: { nested: { secret: 'hunter2' }, hits: ['password'] },
      statusMessage,
      costDetails: { input: 1, output: 2, total: 3 }, // usage/cost must survive
      usageDetails: { input: 10, output: 20, total: 30 },
    });
    const scoreRow = (id: string, comment: string): LfScoreRow => ({
      id,
      projectId: 'prj-scrub',
      traceId: `tr_scrub_${id}`,
      name: 'no-secrets-leaked',
      dataType: 'BOOLEAN',
      value: false,
      timestamp: '2025-09-01T00:01:00.000Z',
      subject: { kind: 'TRACE', id: `tr_scrub_${id}`, traceId: `tr_scrub_${id}` },
      comment,
    });
    const source: TraceSource = {
      kind: 'scrub-double',
      listProjects: async () => [],
      queryObservations: async () => ({
        data: [obsRow('a1', '', 'please redact me'), obsRow('b1', 'timeout waiting', '')],
        meta: { cursor: null },
      }),
      queryScores: async () => ({
        data: [scoreRow('s1', 'comment with secrets'), scoreRow('s2', '')],
        meta: { cursor: null },
      }),
    };
    const baseOpts = {
      store,
      source,
      clock: (): string => INGEST_AT,
      projectId: 'prj-scrub',
      environment: ['production'],
      settings: { backfillWindowDays: 1, incrementalOverlapHours: 24, politeDelayMs: 0 },
      mode: 'backfill' as const,
      windowDays: 5,
      from: '2025-09-01T00:00:00.000Z',
      to: '2025-09-01T02:00:00.000Z',
    };

    // 1) enabled redactor → scrubbed archive
    const r1 = await runSync({ ...baseOpts, redact: createRedactor({ enabled: true }) });
    expect(r1.newRows).toBe(4);
    const { obs, scores } = await readArchives();
    expect(obs).not.toContain('please redact me');
    expect(obs).not.toContain('sensitive output');
    expect(obs).not.toContain('hunter2');
    expect(obs).not.toContain('password');
    expect(obs).not.toContain('timeout waiting');
    expect(scores).not.toContain('comment with secrets');
    const obsRows = obs.trim().split('\n').map((l) => JSON.parse(l).row as Record<string, unknown>);
    const scoreRows = scores.trim().split('\n').map((l) => JSON.parse(l).row as Record<string, unknown>);
    const a1 = obsRows.find((r) => r.id === 'a1')!;
    const b1 = obsRows.find((r) => r.id === 'b1')!;
    expect(a1.input).toMatch(DIGEST_RE);
    expect(a1.output).toMatch(DIGEST_RE);
    expect((a1.metadata as { nested: { secret: string } }).nested.secret).toMatch(DIGEST_RE);
    expect((a1.metadata as { hits: string[] }).hits[0]).toMatch(DIGEST_RE);
    expect(a1.statusMessage).toBe(''); // empty statusMessage preserved (presence signal)
    expect(a1.costDetails).toEqual({ input: 1, output: 2, total: 3 }); // usage/cost intact
    expect(a1.usageDetails).toEqual({ input: 10, output: 20, total: 30 });
    expect(a1.id).toBe('a1');
    expect(a1.name).toBe('credential-lookup');
    expect(a1.startTime).toBe('2025-09-01T00:00:00.000Z');
    expect(b1.input).toBe(''); // empty io passes through unchanged
    expect(b1.statusMessage).toMatch(DIGEST_RE); // non-empty statusMessage scrubbed
    const s1 = scoreRows.find((r) => r.id === 's1')!;
    const s2 = scoreRows.find((r) => r.id === 's2')!;
    expect(s1.comment).toMatch(DIGEST_RE);
    expect(s2.comment).toBe('');
    expect(s1.value).toBe(false); // score payloads intact
    expect(s1.name).toBe('no-secrets-leaked');
    expect(s1.timestamp).toBe('2025-09-01T00:01:00.000Z');
    await store.close();

    // 2) no redactor (default) → rows archived VERBATIM: raw content present,
    // zero digest tokens — the byte-golden path (ingest.test.ts) guards it too
    const rawDir = await mkdtemp(join(tmpdir(), 'canon-redact-verbatim-'));
    try {
      const store2 = createCanonStore(rawDir);
      await store2.open();
      await runSync({ ...baseOpts, store: store2 });
      await store2.close();
      const verbatim = await readFile(join(rawDir, 'archive/observations.jsonl'), 'utf8');
      expect(verbatim).toContain('please redact me');
      expect(verbatim).toContain('sensitive output');
      expect(verbatim).toContain('hunter2');
      expect(verbatim).not.toContain('[redacted:');
    } finally {
      await rm(rawDir, { recursive: true, force: true });
    }
  });
});
