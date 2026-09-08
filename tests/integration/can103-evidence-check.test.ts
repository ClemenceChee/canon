/**
 * CAN-103 — evidence-link integrity before promote (P1 backlog): promoting a
 * proposal whose evidence traceIds no longer resolve in the archive must be
 * refused (validation, exit 1) unless `--force`, which is audited as a
 * governance.promote-override event. Shares the export-side definition of
 * dangling (src/export/evidence.ts).
 */
import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import { createCanon } from '../../src/app.js';
import type { CanonConfig } from '../../src/store/index.js';
import { createCanonStore } from '../../src/store/index.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FROZEN = '2025-09-01T12:00:00.000Z';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-can103-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(): CanonConfig {
  return {
    schema: 'canon/config/v1',
    connection: {
      host: 'https://cloud.langfuse.com',
      baseUrl: 'https://cloud.langfuse.com/api/public',
      projectId: REFUNDS.projectId,
      publicKey: 'pk',
      secretKey: 'sk',
      connectedAt: FROZEN,
    },
    settings: {
      environment: ['production'],
      redact: { ingest: false, views: true },
      operator: { name: 'ops-bot' },
      sync: { incrementalOverlapHours: 24, backfillWindowDays: 1, politeDelayMs: 0 },
      http: { requestTimeoutMs: 30_000, maxRetries: 5, retryBaseMs: 1_000 },
      decay: { proposalTtlDays: 90 },
      analysis: { minTraces: 3, maxProposalsPerRun: 25 },
    },
  };
}

async function seedRefunds(): Promise<void> {
  await mkdir(join(dir, 'archive'), { recursive: true });
  await copyFile(join(FIXTURES, 'archive/refunds/observations.jsonl'), join(dir, 'archive/observations.jsonl'));
  await copyFile(join(FIXTURES, 'archive/refunds/scores.jsonl'), join(dir, 'archive/scores.jsonl'));
  const store = createCanonStore(dir);
  await store.open();
  await store.writeConfig(config());
  await store.rebuildIndex();
  await store.close();
}

async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => err.push(a.map(String).join(' ')));
  try {
    const code = await runCli(argv);
    return { code, stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    vi.restoreAllMocks();
  }
}

async function auditEvents(): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
  return (await readFile(join(dir, 'audit.jsonl'), 'utf8'))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('CAN-103: pre-promote evidence-link gate', () => {
  it('promote refuses dangling evidence (validation) unless --force, which is audited', async () => {
    await seedRefunds();
    const app = createCanon({ dir, clock: () => FROZEN });

    const report = await app.analyze({});
    expect(report.proposed).toBe(3);
    const pendingAll = await app.proposals({ status: 'pending' });
    const proposal = pendingAll[0]!;
    expect(proposal.evidence.length).toBeGreaterThan(0);

    // happy path first: with the archive intact, promote succeeds
    const ok = await app.promote(proposal.id, { actor: 'tester' });
    expect(ok.ruleKey).toBe(proposal.ruleKey);

    // analyze the remaining two, then empty the archive rows so every
    // remaining proposal's evidence dangles (missing file == no rows; the
    // store's tolerant reader treats an absent file as an empty archive)
    const rest = (await app.proposals({ status: 'pending' })).map((p) => p.id);
    expect(rest.length).toBe(2);
    const target = rest[0]!;
    await writeFile(join(dir, 'archive/observations.jsonl'), '');

    // refusal without --force (app-level: validation error)
    await expect(app.promote(target, { actor: 'tester' })).rejects.toMatchObject({
      code: 'validation',
    });

    // refusal via CLI: exit 1 (no --force)
    const refused = await cli(['governance', 'promote', target, '--as', 'tester', '--dir', dir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('dangling');

    // override via CLI --force: exit 0 + audited override + canon rule exists
    const forced = await cli(['governance', 'promote', target, '--as', 'tester', '--force', '--dir', dir]);
    expect(forced.code).toBe(0);

    const events = await auditEvents();
    const override = events.find((e) => e.type === 'governance.promote-override');
    expect(override).toBeDefined();
    expect(override!.payload).toMatchObject({ proposalId: target });
    expect((override!.payload as { dangling?: number }).dangling).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'governance.promote' && (e.payload as { proposalId?: string })?.proposalId === target).length).toBe(1);

    const canon = await app.showCanon();
    expect(canon.some((p) => p.ruleKey === proposal.ruleKey)).toBe(true);
  });
});
