/**
 * CAN-102 — metrics/decay alignment (P1 backlog): `canon metrics` must run the
 * decay sweep before reading, so queue counts agree with a swept
 * `proposals list`. Uses the store clock seam: analyze at FROZEN, then advance
 * past the 90-day proposal TTL and ask metrics again.
 */
import { fileURLToPath } from 'node:url';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCanon } from '../../src/app.js';
import type { CanonConfig } from '../../src/store/index.js';
import { createCanonStore } from '../../src/store/index.js';
import { addDays } from '../../src/core/time.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const FROZEN = '2025-09-01T12:00:00.000Z';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-can102-'));
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
      operator: { name: '' },
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

describe('CAN-102: metrics runs the decay sweep', () => {
  it('a proposal past the 90 d TTL is not counted pending by metrics (matches a swept proposals list)', async () => {
    await seedRefunds();
    let now = FROZEN;
    const app = createCanon({ dir, clock: () => now });

    const report = await app.analyze({});
    expect(report.proposed).toBe(3);

    // before the boundary: 3 pending in both views
    expect((await app.proposals({ status: 'pending' })).length).toBe(3);
    expect((await app.metrics()).proposals.pending).toBe(3);

    // advance past the 90 d TTL (seeded decay.proposalTtlDays = 90)
    now = addDays(FROZEN, 91);

    // the queue view sweeps internally…
    expect((await app.proposals({ status: 'pending' })).length).toBe(0);
    // …and metrics must too (this assertion is red without the CAN-102 fix)
    const m = await app.metrics();
    expect(m.proposals.pending).toBe(0);
    expect(m.proposals.decayed).toBe(3);
    expect(m.proposals.total).toBe(3);
  });

  it('13/15-day precision14 boundaries are unaffected by the sweep', async () => {
    await seedRefunds();
    let now = FROZEN;
    const app = createCanon({ dir, clock: () => now });
    await app.analyze({});

    // ratify one proposal 13 d after creation (inside the 14 d window)
    now = addDays(FROZEN, 13);
    const pending = await app.proposals({ status: 'pending' });
    const first = pending[0]!;
    await app.promote(first.id, { actor: 'tester' });

    const inside = await app.metrics();
    expect(inside.precision14.numerator).toBe(1);
    expect(inside.precision14.denominator).toBe(1);
    expect(inside.precision14.ratio).toBe(1);

    // a reject that lands at day 15 is OUTSIDE the window: excluded from both
    // numerator and denominator (02 reading; unit boundaries already covered).
    now = addDays(FROZEN, 15);
    const rest = (await app.proposals({ status: 'pending' }))[0]!;
    await app.reject(rest.id, { actor: 'tester', reason: 'late decision' });
    const outside = await app.metrics();
    expect(outside.precision14.denominator).toBe(1);
    expect(outside.precision14.numerator).toBe(1);
  });
});
