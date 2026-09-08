/**
 * Connect behaviour (DEC-10 + DEC-13 + DEC-15/22 regressions). DEC-10:
 * re-running `canon connect` on an already-connected store MERGES —
 * same-project reconnect (the key-rotation path) preserves every hand-tuned
 * setting group and only applies the options given on this invocation; a
 * --force switch to a different project starts from [PROPOSED] defaults.
 * DEC-15/22: switching projects with --force alone is REFUSED (validation);
 * --force --wipe clears the previous project's archive/index/sync-state AND
 * its derived governance state — pending proposals + ratified canon policies
 * are purged (they would otherwise carry dangling evidence; ADR-0004 DEC-22
 * supersedes DEC-15's kept-wording), while the append-only audit is retained
 * as history. Project-mismatch guards extend to status() and archive reads.
 *
 * These cases drive connect through an injected TraceSource double (no
 * network); the default Langfuse HTTP adapter path is covered in
 * connect-adapter.test.ts (DEC-13).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanon } from '../../src/app.js';
import type { CanonApp } from '../../src/app.js';
import type { TraceSource } from '../../src/trace/traceSource.js';
import type { ProjectInfo } from '../../src/trace/types.js';
import type { LfObservationRow } from '../../src/trace/types.js';
import { createCanonStore } from '../../src/store/index.js';
import type { CanonStore } from '../../src/store/index.js';
import type { Proposal } from '../../src/store/proposals.js';
import type { Policy } from '../../src/store/policies.js';
import type { Envelope } from '../../src/store/archive.js';
import type { SyncState } from '../../src/ingest/sync.js';

const F1 = '2025-09-01T08:00:00.000Z';
const F2 = '2025-09-02T08:00:00.000Z';

function doubleSource(projects: ProjectInfo[]): TraceSource {
  return {
    kind: 'test-double',
    listProjects: async () => projects,
    queryObservations: async () => ({ data: [] }),
    queryScores: async () => ({ data: [] }),
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-connect-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Seed a prj-demo store with a small archive + index + sync-state. */
async function seedDemoStore(projectId = 'prj-demo'): Promise<void> {
  const store = createCanonStore(dir);
  await store.open();
  await store.writeConfig({
    schema: 'canon/config/v1',
    connection: {
      host: 'https://cloud.langfuse.com',
      baseUrl: 'https://cloud.langfuse.com/api/public',
      projectId,
      publicKey: 'pk-a',
      secretKey: 'sk-a',
      connectedAt: F1,
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
  });
  const row: LfObservationRow = {
    id: 'obs_demo_1',
    traceId: 'tr_demo_1',
    projectId,
    type: 'AGENT',
    name: 'demo-agent',
    level: 'INFO',
    environment: 'production',
    isRootObservation: true,
    parentObservationId: null,
    startTime: '2025-08-31T00:00:00.000Z',
    endTime: '2025-08-31T00:00:05.000Z',
    traceName: 'demo_task',
    statusMessage: '',
  };
  const envelope: Envelope<LfObservationRow> = {
    v: 1,
    kind: 'observation',
    fetchedAt: F1,
    projectId,
    source: 'test-double',
    page: 1,
    row,
  };
  await store.appendObservationRows([envelope]);
  await store.rebuildIndex();
  const state: SyncState = {
    schema: 'canon/sync/v1',
    projectId,
    mode: 'backfill',
    completedWindows: [{ from: '2025-08-31T00:00:00.000Z', to: '2025-09-01T00:00:00.000Z', rows: 1, kind: 'observation' }],
    observationWatermark: '2025-08-31T00:00:00.000Z',
    scoreWatermark: null,
  };
  await store.writeSyncState(state);
  await store.close();
}

/** Seed one pending proposal + one ratified canon policy (+audit lines) for the demo project. */
async function seedDemoGovernance(store: CanonStore): Promise<{ proposal: Proposal; policy: Policy }> {
  const coverage = {
    traces: 4,
    observations: 4,
    agents: 2,
    sessions: 4,
    window: { from: '2025-08-01T00:00:00.000Z', to: '2025-08-31T00:00:00.000Z' },
    environments: ['production'],
    consistency: 1,
  };
  const evidence = [{ role: 'supporting' as const, traceId: 'tr_demo_1', observationIds: ['obs_demo_1'] }];
  const proposal: Proposal = {
    id: 'prop_wipe1',
    ruleKey: 'tool-choice-demo-task-demo-standard',
    kind: 'tool-choice',
    status: 'pending',
    severity: 'advisory',
    title: 'title',
    ruleText: 'rule text',
    assertion: 'assertion',
    constraints: { tool: 'demo-standard', taskKeys: ['demo_task'] },
    confidence: 0.6,
    coverage,
    evidence,
    conflictsWith: [],
    createdAt: F1,
    updatedAt: F1,
    origin: { runId: 'run_wipe1', analyzerVersion: '0.1.0' },
  };
  await store.saveProposal(proposal);
  await store.appendAudit({
    at: F1,
    actor: 'system',
    type: 'proposal.created',
    projectId: 'prj-demo',
    payload: { proposalId: proposal.id, ruleKey: proposal.ruleKey, kind: proposal.kind, runId: 'run_wipe1' },
  });
  const policy: Policy = {
    id: 'pol_wipe1',
    ruleKey: proposal.ruleKey,
    version: 1,
    status: 'active',
    severity: 'advisory',
    ratifiedAt: F1,
    ratifiedBy: 'tester',
    originProposalId: proposal.id,
    ruleText: proposal.ruleText,
    assertion: proposal.assertion,
    constraints: { ...proposal.constraints },
    provenance: {
      confidence: proposal.confidence,
      coverage,
      evidence,
      proposalEdited: false,
      history: [],
    },
  };
  await store.writePolicy(policy);
  await store.appendAudit({
    at: F1,
    actor: 'tester',
    type: 'governance.promote',
    projectId: 'prj-demo',
    payload: { proposalId: proposal.id, ruleKey: proposal.ruleKey, version: 1, policyId: policy.id },
  });
  return { proposal, policy };
}

describe('connect merge semantics (DEC-10)', () => {
  it('same-project reconnect preserves hand-tuned settings and rotates keys', async () => {
    const first = createCanon({
      dir,
      source: doubleSource([{ id: 'prj-demo', name: 'Demo' }]),
      clock: () => F1,
    });
    await first.connect({
      host: 'https://cloud.langfuse.com',
      projectId: 'prj-demo',
      publicKey: 'pk-old',
      secretKey: 'sk-old',
    });

    // Hand-tune the stored config exactly as an operator would (no settings CLI).
    const store = createCanonStore(dir);
    await store.open();
    const tuned = (await store.readConfig())!;
    tuned.settings.environment = ['production', 'staging'];
    tuned.settings.redact = { ingest: true, views: false };
    tuned.settings.operator = { name: 'ada' };
    tuned.settings.sync = { incrementalOverlapHours: 72, backfillWindowDays: 7, politeDelayMs: 5 };
    tuned.settings.http = { requestTimeoutMs: 9000, maxRetries: 9, retryBaseMs: 250 };
    tuned.settings.decay = { proposalTtlDays: 120 };
    tuned.settings.analysis = { minTraces: 7, maxProposalsPerRun: 3 };
    await store.writeConfig(tuned);

    // Reconnect = key rotation: only the new credentials are given, plus one
    // explicit environment override.
    const second = createCanon({
      dir,
      source: doubleSource([{ id: 'prj-demo', name: 'Demo' }]),
      clock: () => F2,
    });
    const out = await second.connect({
      host: 'https://cloud.langfuse.com',
      projectId: 'prj-demo',
      publicKey: 'pk-new',
      secretKey: 'sk-new',
      environment: ['production'],
    });

    // keys rotated + connectedAt refreshed
    expect(out.connection.publicKey).toBe('pk-new');
    expect(out.connection.secretKey).toBe('sk-new');
    expect(out.connection.connectedAt).toBe(F2);
    // environment override applied (only option given this invocation)
    expect(out.settings.environment).toEqual(['production']);
    // everything else preserved from the hand-tuned config
    expect(out.settings.redact).toEqual({ ingest: true, views: false });
    expect(out.settings.operator).toEqual({ name: 'ada' });
    expect(out.settings.sync).toEqual({
      incrementalOverlapHours: 72,
      backfillWindowDays: 7,
      politeDelayMs: 5,
    });
    expect(out.settings.http).toEqual({ requestTimeoutMs: 9000, maxRetries: 9, retryBaseMs: 250 });
    expect(out.settings.decay).toEqual({ proposalTtlDays: 120 });
    expect(out.settings.analysis).toEqual({ minTraces: 7, maxProposalsPerRun: 3 });

    // the persisted config matches the returned one
    const reread = await store.readConfig();
    expect(reread?.settings).toEqual(out.settings);
    expect(reread?.connection.secretKey).toBe('sk-new');
    await store.close();
  });

  it('reconnect preserves settings when no environment option is given', async () => {
    const mk = (clock: () => string): CanonApp =>
      createCanon({
        dir,
        source: doubleSource([{ id: 'prj-demo', name: 'Demo' }]),
        clock,
      });
    await mk(() => F1).connect({
      host: 'https://cloud.langfuse.com',
      projectId: 'prj-demo',
      publicKey: 'pk-a',
      secretKey: 'sk-a',
      environment: ['production', 'staging'],
    });
    const store = createCanonStore(dir);
    await store.open();
    const tuned = (await store.readConfig())!;
    tuned.settings.http.maxRetries = 11;
    await store.writeConfig(tuned);

    const out = await mk(() => F2).connect({
      host: 'https://cloud.langfuse.com',
      projectId: 'prj-demo',
      publicKey: 'pk-b',
      secretKey: 'sk-b',
    });
    expect(out.settings.environment).toEqual(['production', 'staging']);
    expect(out.settings.http.maxRetries).toBe(11);
    await store.close();
  });

  it('--force --wipe switch to a different project resets settings to defaults', async () => {
    const first = createCanon({
      dir,
      source: doubleSource([{ id: 'prj-demo', name: 'Demo' }]),
      clock: () => F1,
    });
    await first.connect({
      host: 'https://cloud.langfuse.com',
      projectId: 'prj-demo',
      publicKey: 'pk-a',
      secretKey: 'sk-a',
    });
    const store = createCanonStore(dir);
    await store.open();
    const tuned = (await store.readConfig())!;
    tuned.settings.sync.incrementalOverlapHours = 72;
    tuned.settings.environment = ['production', 'staging'];
    await store.writeConfig(tuned);

    const second = createCanon({
      dir,
      source: doubleSource([
        { id: 'prj-demo', name: 'Demo' },
        { id: 'prj-other', name: 'Other' },
      ]),
      clock: () => F2,
    });
    const out = await second.connect({
      host: 'https://cloud.langfuse.com',
      projectId: 'prj-other',
      publicKey: 'pk-b',
      secretKey: 'sk-b',
      force: true,
      wipe: true,
    });
    expect(out.connection.projectId).toBe('prj-other');
    expect(out.settings.sync.incrementalOverlapHours).toBe(24); // [PROPOSED] default restored
    expect(out.settings.environment).toEqual(['production']);
    expect(out.settings.redact).toEqual({ ingest: false, views: true });
    await store.close();
  });

  describe('project switch requires --wipe (DEC-15 / DEC-22)', () => {
    it('--force to a different project without --wipe is refused with a validation error', async () => {
      await seedDemoStore();
      const store = createCanonStore(dir);
      await store.open();
      await seedDemoGovernance(store);
      await store.close();
      const app = createCanon({
        dir,
        source: doubleSource([
          { id: 'prj-demo', name: 'Demo' },
          { id: 'prj-other', name: 'Other' },
        ]),
        clock: () => F2,
      });
      await expect(
        app.connect({
          host: 'https://cloud.langfuse.com',
          projectId: 'prj-other',
          publicKey: 'pk-b',
          secretKey: 'sk-b',
          force: true,
        }),
      ).rejects.toMatchObject({
        code: 'validation',
        message: expect.stringContaining('requires --wipe'),
      });
      // nothing changed: still connected to the old project, archive intact
      // and governance artifacts untouched (refusal is non-destructive)
      const reread = createCanonStore(dir);
      await reread.open();
      expect((await reread.readConfig())?.connection.projectId).toBe('prj-demo');
      expect((await reread.status()).archive.observations).toBe(1);
      expect((await reread.loadProposal('prop_wipe1'))?.status).toBe('pending');
      expect(await reread.listPolicies()).toHaveLength(1);
      await reread.close();
    });

    it('--force --wipe clears the previous project archive/index/sync-state before connecting', async () => {
      await seedDemoStore();
      const app = createCanon({
        dir,
        source: doubleSource([
          { id: 'prj-demo', name: 'Demo' },
          { id: 'prj-other', name: 'Other' },
        ]),
        clock: () => F2,
      });
      await app.connect({
        host: 'https://cloud.langfuse.com',
        projectId: 'prj-other',
        publicKey: 'pk-b',
        secretKey: 'sk-b',
        force: true,
        wipe: true,
      });

      const store = createCanonStore(dir);
      await store.open();
      expect((await store.readConfig())?.connection.projectId).toBe('prj-other');
      // archive/index/sync-state of the old project are gone
      await expect(readFile(join(dir, 'archive/observations.jsonl'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(dir, 'index.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(dir, 'sync-state.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await store.status()).archive).toEqual({ observations: 0, scores: 0 });
      await store.close();
    });

    it('DEC-22: --force --wipe purges pending proposals + ratified canon (audit retained); promote of a purged id fails cleanly', async () => {
      await seedDemoStore();
      const store = createCanonStore(dir);
      await store.open();
      const { proposal } = await seedDemoGovernance(store);
      const eventsBefore = (await store.readAudit()).length;
      await store.close();

      const app = createCanon({
        dir,
        source: doubleSource([
          { id: 'prj-demo', name: 'Demo' },
          { id: 'prj-other', name: 'Other' },
        ]),
        clock: () => F2,
      });
      await app.connect({
        host: 'https://cloud.langfuse.com',
        projectId: 'prj-other',
        publicKey: 'pk-b',
        secretKey: 'sk-b',
        force: true,
        wipe: true,
      });

      const after = createCanonStore(dir);
      await after.open();
      // governance artifacts of the old project are purged — stale state can
      // no longer suppress or be promoted into the new project
      expect(await after.loadProposal(proposal.id)).toBeUndefined();
      expect(await after.listProposals('all')).toHaveLength(0);
      expect(await after.listPolicies()).toHaveLength(0);
      expect((await after.status()).policies).toBe(0);
      expect((await after.status()).proposalsByStatus.pending).toBe(0);
      // the append-only audit is retained as history (old + new events)
      const audit = await after.readAudit();
      expect(audit.length).toBeGreaterThan(eventsBefore);
      expect(audit.some((e) => e.type === 'proposal.created' && e.payload?.proposalId === proposal.id)).toBe(true);
      expect(audit.some((e) => e.type === 'governance.promote' && e.payload?.proposalId === proposal.id)).toBe(true);
      expect(audit.at(-1)!.type).toBe('connect');
      await after.close();

      // promote of a purged id fails cleanly (not-found, exit 1 at the CLI)
      await expect(app.promote(proposal.id, { actor: 'tester' })).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('status() and archive reads never mix projects (foreign rows excluded / refused)', async () => {
      await seedDemoStore();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createCanonStore(dir);
      await store.open();
      // hand-edited config pointing at another project (the tamper case)
      const cfg = (await store.readConfig())!;
      cfg.connection.projectId = 'prj-tampered';
      await store.writeConfig(cfg);

      // status scopes counts to the current project and flags the exclusion
      const st = await store.status();
      expect(st.archive).toEqual({ observations: 0, scores: 0 });
      expect(warn.mock.calls.join(' ')).toContain('prj-demo');
      expect(warn.mock.calls.join(' ')).toContain('--force --wipe');

      // archive READS refuse to serve foreign rows (invalid-state, not silence)
      await expect(store.readArchiveRows()).rejects.toMatchObject({ code: 'invalid-state' });
      await expect(store.traceLines('tr_demo_1')).rejects.toMatchObject({ code: 'invalid-state' });
      warn.mockRestore();
      await store.close();
    });
  });
});
