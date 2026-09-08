/**
 * Store slice-3 verification (04: tests/integration/store.test.ts) — archive
 * envelopes, dedupe, index rebuild (golden), sync-state round-trip + project
 * guard, traceLines, torn/corrupt-line flagging, and `canon status` integrity
 * data.
 */

import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanonStore } from '../../src/store/index.js';
import type { CanonConfig } from '../../src/store/index.js';
import type { Envelope, IndexData } from '../../src/store/archive.js';
import type { LfObservationRow } from '../../src/trace/types.js';
import type { SyncState } from '../../src/ingest/sync.js';
import { runCli } from '../../src/cli/main.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FROZEN = '2025-09-01T12:00:00.000Z';
const WINDOW = REFUNDS.window;
const PROJECT = REFUNDS.projectId;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-store3-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Read the committed refunds archive fixture into envelope arrays (file order). */
async function fixtureRows(): Promise<Array<Envelope<LfObservationRow>>> {
  const raw = await readFile(join(FIXTURES, 'archive/refunds/observations.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Envelope<LfObservationRow>);
}

function sampleConfig(projectId = PROJECT): CanonConfig {
  return {
    schema: 'canon/config/v1',
    connection: {
      host: 'https://cloud.langfuse.com',
      baseUrl: 'https://cloud.langfuse.com/api/public',
      projectId,
      publicKey: 'pk',
      secretKey: 'sk',
      connectedAt: FROZEN,
    },
    settings: {
      environment: ['production'],
      redact: { ingest: false, views: true },
      operator: { name: '' },
      sync: { incrementalOverlapHours: 24, backfillWindowDays: 1, politeDelayMs: 0 },
      http: { requestTimeoutMs: 30_000, maxRetries: 5, retryBaseMs: 1_000 },
      decay: { proposalTtlDays: 90 },
      analysis: { minTraces: 3, maxProposalsPerRun: 25 },
    },
  };
}

describe('store archive + index (slice 3)', () => {
  it('appendObservationRows dedupes by id within a batch and across calls', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    const rows = await fixtureRows();
    // the committed archive fixture holds unique rows only (what a store holds)
    expect(rows).toHaveLength(REFUNDS.uniqueObservationRows);

    const first = await store.appendObservationRows(rows);
    expect(first).toEqual({ appended: REFUNDS.uniqueObservationRows, dupes: 0 });

    // same batch again → everything a dupe
    const again = await store.appendObservationRows(rows);
    expect(again).toEqual({ appended: 0, dupes: REFUNDS.uniqueObservationRows });

    // a batch with a duplicated id (page-overlap case) counts the duplicate
    const dupBatch = [rows[0]!, rows[1]!, rows[0]!, rows[2]!];
    const dupRes = await store.appendObservationRows(dupBatch);
    expect(dupRes).toEqual({ appended: 0, dupes: 4 });

    const st = await stat(join(dir, 'archive/observations.jsonl'));
    expect(st.mode & 0o777).toBe(0o600); // review N2: archive JSONL 0600
    await store.close();
  });

  it('rebuildIndex reproduces a golden IndexData for the refunds corpus', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    await store.writeConfig(sampleConfig()); // real flows rebuild with a config present
    await store.appendObservationRows(await fixtureRows());

    const index = await store.rebuildIndex();
    expect(index.schema).toBe('canon/index/v1');
    expect(index.projectId).toBe(PROJECT);
    expect(index.builtAt).toBe(FROZEN);
    expect(index.traceCount).toBe(REFUNDS.traces);
    expect(index.observationCount).toBe(REFUNDS.uniqueObservationRows);
    expect(Object.keys(index.traces).sort()).toEqual([
      'tr_charge_1',
      'tr_charge_10',
      'tr_charge_2',
      'tr_charge_3',
      'tr_charge_4',
      'tr_charge_5',
      'tr_charge_6',
      'tr_charge_7',
      'tr_charge_8',
      'tr_charge_9',
      'tr_dispute_1',
      'tr_dispute_10',
      'tr_dispute_11',
      'tr_dispute_12',
      'tr_dispute_2',
      'tr_dispute_3',
      'tr_dispute_4',
      'tr_dispute_5',
      'tr_dispute_6',
      'tr_dispute_7',
      'tr_dispute_8',
      'tr_dispute_9',
      'tr_refund_1',
      'tr_refund_2',
      'tr_refund_3',
      'tr_refund_4',
      'tr_refund_5',
      'tr_refund_6',
      'tr_refund_7',
      'tr_refund_8',
    ]);
    const rf1 = index.traces['tr_refund_1']!;
    expect(rf1).toMatchObject({
      rootObservationId: 'obs_refund_agent_1',
      agentId: 'refund-agent',
      taskKey: 'refund_task',
      environment: 'production',
      outcome: 'unknown', // outcome classification is analyze-owned (slice 4)
      lineFrom: 1,
      lineTo: 4,
    });
    expect(index.traces['tr_refund_5']!.agentId).toBe('support-agent');
    expect(index.traces['tr_dispute_1']!.taskKey).toBe('dispute_task');
    // every unique id resolves to a line
    expect(Object.keys(index.observations)).toHaveLength(REFUNDS.uniqueObservationRows);

    // golden byte-stability: the committed expected file matches exactly (both
    // sides rebuilt with the same frozen clock)
    const goldenRaw = JSON.parse(
      await readFile(join(FIXTURES, 'expected/refunds/index.json'), 'utf8'),
    ) as IndexData;
    expect(index).toEqual(goldenRaw);
    await store.close();
  });

  it('readIndex self-heals: missing or corrupt index is rebuilt + written', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    await store.appendObservationRows(await fixtureRows());
    const indexPath = join(dir, 'index.json');
    expect(await store.readIndex()).toBeDefined(); // missing → rebuild+write
    expect((JSON.parse(await readFile(indexPath, 'utf8')) as IndexData).schema).toBe(
      'canon/index/v1',
    );

    await writeFile(indexPath, '{not json', 'utf8'); // operator/disk damage
    const healed = await store.readIndex();
    expect(healed.observationCount).toBe(REFUNDS.uniqueObservationRows);
    expect((JSON.parse(await readFile(indexPath, 'utf8')) as IndexData).schema).toBe(
      'canon/index/v1',
    );
    await store.close();
  });

  it('traceLines returns row line numbers for one trace, in file order', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    await store.appendObservationRows(await fixtureRows());
    // the store dedupes, so the archive holds unique rows only; replicate that
    const seen = new Set<string>();
    const expected = (await fixtureRows())
      .filter((e) => e.row.traceId === 'tr_refund_1')
      .filter((e) => (seen.has(e.row.id) ? false : (seen.add(e.row.id), true)))
      .map((e) => ({ id: e.row.id }))
      .map((x) => x.id);
    const lines = await store.traceLines('tr_refund_1');
    expect(lines.map((l) => l.row.id)).toEqual(expected);
    expect(lines.map((l) => l.line)).toEqual(expected.map((_id, i) => i + 1));
    expect(await store.traceLines('tr_missing')).toEqual([]);
    await store.close();
  });

  it('sync-state round-trips and a project mismatch after --force starts fresh', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    expect(await store.readSyncState()).toBeUndefined();

    const state: SyncState = {
      schema: 'canon/sync/v1',
      projectId: PROJECT,
      mode: 'backfill',
      completedWindows: [{ from: WINDOW.from, to: WINDOW.to, rows: 118, kind: 'observation' }],
      observationWatermark: '2025-09-01T00:00:00.000Z',
      scoreWatermark: null,
    };
    await store.writeSyncState(state);
    expect(await store.readSyncState()).toEqual(state);

    // config now points at another project (--force switch): state is foreign
    await store.writeConfig(sampleConfig('prj-other'));
    expect(await store.readSyncState()).toBeUndefined();
    await store.close();
  });

  it('readStoredRowIds reports archived ids per kind (dry-run accounting)', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    await store.appendObservationRows(await fixtureRows());
    const ids = await store.readStoredRowIds();
    expect(ids.observations.size).toBe(REFUNDS.uniqueObservationRows);
    expect(ids.scores.size).toBe(0);
    await store.close();
  });

  it('status reports integrity; corrupt archive lines are flagged, never silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    expect(await store.status()).toMatchObject({
      connected: false,
      configPermOk: false,
      archive: { observations: 0, scores: 0 },
      indexFresh: false,
      lockHeld: false,
      proposalsByStatus: { pending: 0, ratified: 0, rejected: 0, decayed: 0 },
      policies: 0,
    });

    await store.writeConfig(sampleConfig());
    await store.appendObservationRows(await fixtureRows());
    await store.rebuildIndex();

    // corrupt one archive line mid-file (1-based line 60)
    const obsPath = join(dir, 'archive/observations.jsonl');
    const parts = (await readFile(obsPath, 'utf8')).split('\n');
    parts[59] = '{"v":1,"kind":"observation","row":{"id":"torn';
    await writeFile(obsPath, parts.join('\n'), 'utf8');

    const status = await store.status();
    expect(status.connected).toBe(true);
    expect(status.configPermOk).toBe(true);
    expect(status.archive.observations).toBe(REFUNDS.uniqueObservationRows - 1);
    expect(status.indexFresh).toBe(false); // index count no longer matches the archive
    expect(status.policies).toBe(0);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]!.join(' ')).toContain('1 corrupted line');
    warn.mockRestore();
    await store.close();
  });

  it('rebuildIndex via status keeps the index fresh afterwards', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    await store.writeConfig(sampleConfig());
    await store.appendObservationRows(await fixtureRows());
    expect((await store.status()).indexFresh).toBe(false); // no index yet
    await store.rebuildIndex();
    expect((await store.status()).indexFresh).toBe(true);
    await store.close();
  });

  it('status surfaces lastRun.aborted from the sync state (ADR-0004 DEC-24 / QA M5)', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    await store.writeConfig(sampleConfig());
    await store.writeSyncState({
      schema: 'canon/sync/v1',
      projectId: PROJECT,
      mode: 'backfill',
      completedWindows: [],
      observationWatermark: null,
      scoreWatermark: null,
      lastRun: {
        at: FROZEN,
        pages: 3,
        newRows: 118,
        dupes: 0,
        aborted: true, // a mid-run failure left an abort checkpoint (DEC-14)
      },
    });
    // the StoreStatus record (and therefore `canon status --json`) carries it
    const status = await store.status();
    expect(status.lastRun).toBeDefined();
    expect(status.lastRun!.aborted).toBe(true);
    expect(status.lastRun!.newRows).toBe(118);
    // a clean lastRun without the flag stays clean (no stale marker)
    await store.writeSyncState({
      schema: 'canon/sync/v1',
      projectId: PROJECT,
      mode: 'backfill',
      completedWindows: [],
      observationWatermark: null,
      scoreWatermark: null,
      lastRun: { at: FROZEN, pages: 3, newRows: 118, dupes: 0 },
    });
    expect((await store.status()).lastRun!.aborted).toBeUndefined();
    await store.close();
  });

  it('`canon status` prints lastRun.aborted in the human view and the --json record (DEC-24 / QA M5)', async () => {
    const store = createCanonStore(dir, { clock: () => FROZEN });
    await store.open();
    await store.writeConfig(sampleConfig());
    await store.writeSyncState({
      schema: 'canon/sync/v1',
      projectId: PROJECT,
      mode: 'backfill',
      completedWindows: [],
      observationWatermark: null,
      scoreWatermark: null,
      lastRun: { at: FROZEN, pages: 3, newRows: 118, dupes: 0, aborted: true },
    });
    await store.close();

    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
    try {
      const jsonCode = await runCli(['status', '--json', '--dir', dir]);
      expect(jsonCode).toBe(0);
      expect(JSON.parse(out.join('\n')).lastRun.aborted).toBe(true);

      out.length = 0;
      const humanCode = await runCli(['status', '--dir', dir]);
      expect(humanCode).toBe(0);
      expect(out.join('\n')).toContain('last run');
      expect(out.join('\n')).toContain('(aborted)');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
