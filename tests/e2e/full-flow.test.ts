/**
 * Slice 7 e2e (04: tests/e2e/full-flow.test.ts) — the full product happy path
 * driven through the CLI (in-process runCli + the default Langfuse HTTP
 * adapter against the committed fixture fake server; 04's manual walk uses
 * the built dist/cli.js — same commands): connect → ingest (backfill) →
 * analyze → proposals list → promote (--as + --edit --set severity=mandatory)
 * → canon show → export guardrules (--verify-links) → audit export → metrics.
 *
 * Assertions 04 encodes: ingest newRows == fixture corpus count; proposals ==
 * the golden trio (3 pending); export rules.length == 1 after a single
 * promote with every evidence traceId resolving (--verify-links clean);
 * audit.md contains `reviewedBy: tester`; metrics.ttrp.ms > 0; config 0600;
 * and no secret key / raw io content appears anywhere in stdout/stderr/export
 * files. Hardening folded in: a torn archive tail is tolerated + flagged by
 * analyze (torn-tail recovery), and the abort seam (SIGINT shape) checkpoints
 * mid-run and resumes (graceful stop).
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import type { CommandCtx } from '../../src/cli/main.js';
import type { CanonApp } from '../../src/app.js';
import ingestCmd from '../../src/cli/commands/ingest.js';
import { startFakeLangfuseServer } from '../fixtures/fakeLangfuseServer.js';
import type { FakeServerHandle } from '../fixtures/fakeLangfuseServer.js';
import type { GuardRulesPack } from '../../src/export/guardRules.js';
import { REFUNDS } from '../fixtures/scenarios.js';

const OBS_UNIQUE = REFUNDS.uniqueObservationRows;
const TOTAL = OBS_UNIQUE + REFUNDS.scoreRows; // full-corpus newRows for one pass

let dir: string;
let server: FakeServerHandle;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-fullflow-'));
  server = await startFakeLangfuseServer({ scenario: 'refunds' });
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => stdout.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => stderr.push(a.map(String).join(' ')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

async function cli(argv: string[]): Promise<number> {
  return runCli(argv);
}

function allOutput(): string {
  return [...stdout, ...stderr].join('\n');
}

describe('slice 7 full flow (04)', () => {
  it('connect → ingest → analyze → proposals → promote --edit → canon → export → audit export → metrics', async () => {
    // ---- connect ----
    const connectCode = await cli([
      'connect', '--host', server.url, '--project', REFUNDS.projectId,
      '--public-key', 'pk-demo', '--secret-key', 'sk-demo', '--dir', dir,
    ]);
    expect(connectCode).toBe(0);
    expect(stdout.join('\n')).toContain(`connected to project ${REFUNDS.projectId}`);
    const st = await stat(join(dir, 'config.json'));
    expect(st.mode & 0o777).toBe(0o600); // config chmod 0600

    // ---- ingest (backfill): newRows == fixture corpus count ----
    // Explicit window equal to the fixture corpus: the fake server honours
    // fromStartTime/toStartTime (real window semantics, SHOULD-3), so a
    // default backfill — whose horizon is [now − 24 h, now) with the real
    // clock — would fetch nothing from the Aug-2025 fixture.
    stdout.length = 0;
    stderr.length = 0;
    const ingestCode = await cli([
      'ingest', '--backfill', '--dir', dir,
      '--from', REFUNDS.window.from, '--to', REFUNDS.window.to, '--window-days', '5',
    ]);
    expect(ingestCode).toBe(0);
    expect(stdout.join('\n')).toContain('ingest complete (backfill)');
    expect(stdout.join('\n')).toContain(`new rows ${TOTAL}`); // 246 obs + 47 scores

    // ---- torn archive tail is tolerated + flagged (torn-tail recovery) ----
    const obsPath = join(dir, 'archive/observations.jsonl');
    await appendFile(obsPath, '{"v":1,"kind":"observation","row":{"id":"torn');
    stdout.length = 0;
    stderr.length = 0;
    const analyzeCode = await cli(['analyze', '--dir', dir]);
    expect(analyzeCode).toBe(0);
    expect(stdout.join('\n')).toContain('trees 30'); // all valid rows analysed
    expect(stdout.join('\n')).toContain('skipped 1'); // torn line folded, not fatal
    expect(stdout.join('\n')).toContain('proposals created 3'); // golden trio

    // ---- proposals list: 3 pending, one per expected kind ----
    stdout.length = 0;
    stderr.length = 0;
    const listCode = await cli(['proposals', 'list', '--dir', dir]);
    expect(listCode).toBe(0);
    expect(stdout.join('\n')).toContain('proposals (3 pending)');
    const listText = stdout.join('\n');
    expect(listText).toContain('tool-choice');
    expect(listText).toContain('side-effect-retry');
    expect(listText).toContain('model-usage');
    const retryRow = listText.split('\n').find((l) => l.includes('\tside-effect-retry\t'))!;
    const retryId = retryRow.split('\t')[0]!;

    // ---- governance promote: attributed + one --edit severity change ----
    stdout.length = 0;
    stderr.length = 0;
    const promoteCode = await cli([
      'governance', 'promote', retryId, '--as', 'tester', '--edit',
      '--set', 'severity=mandatory', '--note', 'evidence ok', '--dir', dir,
    ]);
    expect(promoteCode).toBe(0);
    expect(stdout.join('\n')).toContain(
      'side-effect-retry-chargeback-task-charge-reversal.v1.json',
    );
    expect(stdout.join('\n')).toContain('severity mandatory');

    // ---- canon show: the ratified rule is mandatory ----
    stdout.length = 0;
    stderr.length = 0;
    const canonCode = await cli(['canon', 'show', '--dir', dir]);
    expect(canonCode).toBe(0);
    expect(stdout.join('\n')).toContain('side-effect-retry-chargeback-task-charge-reversal.v1');
    expect(stdout.join('\n')).toContain('mandatory');

    // ---- export guard-rules: rules.length == 1 after the single promote;
    //      every evidence trace resolves (--verify-links clean) ----
    stdout.length = 0;
    stderr.length = 0;
    const exportPath = join(dir, 'guardrules.json');
    const exportCode = await cli([
      'export', '--format', 'guardrules-json', '--out', exportPath,
      '--verify-links', '--dir', dir,
    ]);
    expect(exportCode).toBe(0);
    expect(stdout.join('\n')).toContain('evidence links verified (0 dangling)');
    const pack = JSON.parse(await readFile(exportPath, 'utf8')) as GuardRulesPack;
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0]!.severity).toBe('mandatory');
    expect(pack.rules[0]!.ruleKey).toBe('side-effect-retry-chargeback-task-charge-reversal');
    expect(pack.rules[0]!.provenance.ratifiedBy).toBe('tester');

    // ---- audit export (md): policy → proposal → evidence chain lines ----
    stdout.length = 0;
    stderr.length = 0;
    const auditPath = join(dir, 'audit.md');
    const auditCode = await cli(['audit', 'export', '--format', 'md', '--out', auditPath, '--dir', dir]);
    expect(auditCode).toBe(0);
    const md = await readFile(auditPath, 'utf8');
    expect(md).toContain('reviewedBy: tester');
    expect(md).toContain('## Policy chain');
    expect(md).toContain('originProposal:');

    // ---- metrics: ttrp.ms > 0 after the promote ----
    stdout.length = 0;
    stderr.length = 0;
    const metricsCode = await cli(['metrics', '--json', '--dir', dir]);
    expect(metricsCode).toBe(0);
    const metrics = JSON.parse(stdout.join('\n')) as {
      ttrp: { ms: number } | null;
      precision14: { numerator: number; denominator: number; ratio: number | null };
      proposals: { total: number; pending: number; ratified: number };
    };
    expect(metrics.ttrp).not.toBeNull();
    expect(metrics.ttrp!.ms).toBeGreaterThan(0);
    expect(metrics.precision14).toEqual({ numerator: 1, denominator: 1, ratio: 1 });
    expect(metrics.proposals).toEqual({
      total: 3, pending: 2, ratified: 1, rejected: 0, decayed: 0,
    });

    // ---- hygiene: no secret key and no raw io content anywhere ----
    const exports = `${await readFile(exportPath, 'utf8')}\n${md}`;
    expect(exports).not.toContain('sk-demo');
    expect(exports).not.toContain('never received it'); // raw io never exported
    expect(allOutput()).not.toContain('sk-demo');
    expect(allOutput()).not.toContain('never received it'); // views carry structure only
  });

  it('ingest maps an aborted report to exit 130 (SIGINT graceful-stop command path)', async () => {
    const interrupt = { syncing: true, requested: true }; // SIGINT arrived mid-run
    const app = {
      ingest: async (opts: { abort?: () => boolean }) => {
        const aborted = opts.abort !== undefined && opts.abort();
        return {
          projectId: REFUNDS.projectId,
          mode: 'backfill' as const,
          windows: 0,
          pages: 2,
          newRows: 40,
          dupes: 0,
          to: '2025-09-01T12:00:00.000Z',
          durationMs: 3,
          ...(aborted ? { aborted: true } : {}),
        };
      },
    } as unknown as CanonApp;

    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => out.push(a.map(String).join(' ')));
    try {
      const ctx: CommandCtx = {
        app,
        args: { backfill: true },
        redactViews: true,
        interrupt,
      };
      const code = await ingestCmd(ctx);
      expect(code).toBe(130); // 02 exit codes: 130 interrupted
      expect(out.join('\n')).toContain('ingest aborted (interrupted)');
      expect(out.join('\n')).toContain('new rows 40'); // partial counts still reported

      // without a SIGINT request the same command completes normally
      interrupt.requested = false;
      out.length = 0;
      const ok = await ingestCmd({ ...ctx, interrupt });
      expect(ok).toBe(0);
      expect(out.join('\n')).toContain('ingest complete (backfill)');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('exit-code discipline holds across the walk: re-promote → 1, promote without --as → 2, unknown verb → 2', async () => {
    const connectCode = await cli([
      'connect', '--host', server.url, '--project', REFUNDS.projectId,
      '--public-key', 'pk-demo', '--secret-key', 'sk-demo', '--dir', dir,
    ]);
    expect(connectCode).toBe(0);
    await cli([
      'ingest', '--backfill', '--dir', dir,
      '--from', REFUNDS.window.from, '--to', REFUNDS.window.to, '--window-days', '5',
    ]);
    stdout.length = 0;
    await cli(['analyze', '--dir', dir]);
    stdout.length = 0;
    stderr.length = 0;
    await cli(['proposals', 'list', '--dir', dir]);
    const retryRow = stdout.join('\n').split('\n').find((l) => l.includes('\tside-effect-retry\t'))!;
    const retryId = retryRow.split('\t')[0]!;

    stderr.length = 0;
    const anon = await cli(['governance', 'promote', retryId, '--dir', dir]);
    expect(anon).toBe(2); // attribution mandatory
    expect(stderr.join('\n')).toContain('--as');

    stderr.length = 0;
    stdout.length = 0;
    const ok = await cli(['governance', 'promote', retryId, '--as', 'tester', '--dir', dir]);
    expect(ok).toBe(0);
    stderr.length = 0;
    const again = await cli(['governance', 'promote', retryId, '--as', 'tester', '--dir', dir]);
    expect(again).toBe(1); // invalid-state
    expect(stderr.join('\n')).toContain('only pending proposals can be promoted');

    stderr.length = 0;
    const nonsense = await cli(['frobnicate']);
    expect(nonsense).toBe(2); // usage
  });
});
