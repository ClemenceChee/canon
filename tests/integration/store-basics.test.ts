import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanonStore } from '../../src/store/index.js';
import type { CanonConfig } from '../../src/store/index.js';
import { nowIso } from '../../src/core/time.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sampleConfig(overrides?: Partial<CanonConfig['connection']>): CanonConfig {
  return {
    schema: 'canon/config/v1',
    connection: {
      host: 'https://cloud.langfuse.com',
      baseUrl: 'https://cloud.langfuse.com/api/public',
      projectId: 'prj-abc',
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      connectedAt: '2025-09-01T00:00:00.000Z',
      ...overrides,
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

describe('store basics (slice 1)', () => {
  it('open() creates the store dir with 0700 and tolerates re-open', async () => {
    const store = createCanonStore(dir);
    await store.open();
    const st = await stat(dir);
    expect(st.mode & 0o777).toBe(0o700);
    await store.open(); // idempotent
    await store.close();
  });

  it('writeConfig/readConfig round-trip with chmod 0600; undefined before connect', async () => {
    const store = createCanonStore(dir);
    await store.open();
    expect(await store.readConfig()).toBeUndefined();

    const cfg = sampleConfig();
    await store.writeConfig(cfg);
    const st = await stat(join(dir, 'config.json'));
    expect(st.mode & 0o777).toBe(0o600);

    const read = await store.readConfig();
    expect(read).toEqual(cfg);
    await store.close();
  });

  it('a malformed config.json is store-corrupt, never silently ignored', async () => {
    const store = createCanonStore(dir);
    await store.open();
    await writeFile(join(dir, 'config.json'), '{not json', 'utf8');
    await expect(store.readConfig()).rejects.toMatchObject({ code: 'store-corrupt' });
  });

  it('appendAudit assigns monotonic seq under lock and readAudit folds them', async () => {
    const store = createCanonStore(dir);
    await store.open();
    const at = nowIso();
    const e1 = await store.appendAudit({
      at,
      actor: 'system',
      type: 'connect',
      projectId: 'prj-abc',
      payload: {},
    });
    const e2 = await store.appendAudit({
      at,
      actor: 'system',
      type: 'analysis.run',
      projectId: 'prj-abc',
      payload: { runId: 'run_a' },
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const all = await store.readAudit();
    expect(all.map((e) => e.seq)).toEqual([1, 2]);
    expect(all.map((e) => e.type)).toEqual(['connect', 'analysis.run']);
    await store.close();
  });

  it('tolerates a torn trailing audit line and keeps seq monotonic (self-healing append)', async () => {
    const store = createCanonStore(dir);
    await store.open();
    await store.appendAudit({
      at: nowIso(),
      actor: 'system',
      type: 'connect',
      projectId: 'prj-abc',
      payload: {},
    });
    // simulate a crash mid-append: partial JSON line without trailing newline
    const auditPath = join(dir, 'audit.jsonl');
    const current = await readFile(auditPath, 'utf8');
    await writeFile(auditPath, `${current}{"seq":999,"at":"broken`);

    const e = await store.appendAudit({
      at: nowIso(),
      actor: 'system',
      type: 'analysis.run',
      projectId: 'prj-abc',
      payload: {},
    });
    expect(e.seq).toBe(2); // torn line skipped, next seq = max valid + 1
    const all = await store.readAudit();
    expect(all.length).toBe(2);
    expect(all[1]?.seq).toBe(2);
    await store.close();
  });

  it('saveProposal/loadProposal/listProposals round-trip with confidence ordering', async () => {
    const store = createCanonStore(dir);
    await store.open();
    const base = {
      ruleKey: 'tool-choice-x',
      kind: 'tool-choice' as const,
      status: 'pending' as const,
      severity: 'advisory' as const,
      title: 'T',
      ruleText: 'R',
      assertion: 'A',
      constraints: {},
      confidence: 0.4,
      coverage: {
        traces: 1,
        observations: 1,
        agents: 1,
        sessions: 0,
        window: { from: '2025-08-01T00:00:00.000Z', to: '2025-09-01T00:00:00.000Z' },
        environments: ['production'],
        consistency: 1,
      },
      evidence: [],
      conflictsWith: [],
      createdAt: '2025-09-01T00:00:00.000Z',
      updatedAt: '2025-09-01T00:00:00.000Z',
      origin: { runId: 'run_1', analyzerVersion: '0.1.0' },
    };
    const pLow = { ...base, id: 'prop_low', confidence: 0.3 };
    const pHigh = { ...base, id: 'prop_high', confidence: 0.9 };
    await store.saveProposal(pHigh);
    await store.saveProposal(pLow);

    expect(await store.loadProposal('prop_low')).toMatchObject({ id: 'prop_low' });
    expect(await store.loadProposal('missing')).toBeUndefined();

    const all = await store.listProposals('all');
    expect(all.map((p) => p.id)).toEqual(['prop_high', 'prop_low']); // confidence desc
    const pending = await store.listProposals('pending');
    expect(pending.map((p) => p.id)).toEqual(['prop_high', 'prop_low']);
    await store.close();
  });

  it('audit.jsonl is created 0600 (review N2 — not umask-dependent)', async () => {
    const store = createCanonStore(dir);
    await store.open();
    await store.appendAudit({
      at: nowIso(),
      actor: 'system',
      type: 'connect',
      projectId: 'prj-abc',
      payload: {},
    });
    const st = await stat(join(dir, 'audit.jsonl'));
    expect(st.mode & 0o777).toBe(0o600);
    await store.close();
  });

  it('readAudit flags corrupted lines with a warning instead of silently dropping them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createCanonStore(dir);
    await store.open();
    await store.appendAudit({
      at: nowIso(),
      actor: 'system',
      type: 'connect',
      projectId: 'prj-abc',
      payload: {},
    });
    // corrupt a line mid-file (not just a healable torn tail)
    const auditPath = join(dir, 'audit.jsonl');
    const first = (await readFile(auditPath, 'utf8')).split('\n')[0]!;
    await writeFile(auditPath, `${first}\n{"seq":999,"at":"corrupted\n`, 'utf8');

    const all = await store.readAudit();
    expect(all).toHaveLength(1); // the corrupted line is skipped
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain('1 corrupted line');
    warn.mockRestore();
    await store.close();
  });

  it('lock contention → CanonError locked; stale-lock takeover by dead pid', async () => {
    const storeA = createCanonStore(dir);
    await storeA.open();

    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = storeA.withLock(async () => {
      await gate;
    });

    // let A acquire first
    await new Promise((r) => setTimeout(r, 50));
    const storeB = createCanonStore(dir);
    await storeB.open();
    await expect(storeB.withLock(async () => {})).rejects.toMatchObject({
      code: 'locked',
    });

    release?.();
    await held;

    // now A released; simulate a stale lock from a dead process
    const lockPath = join(dir, '.lock');
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99_999_999, at: '2025-09-01T00:00:00.000Z', nonce: 'stale' }),
      'utf8',
    );
    await expect(storeB.withLock(async () => {})).resolves.toBeUndefined();
    await storeB.close();
    await storeA.close();
  });
});
