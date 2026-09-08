/**
 * Slice 1 e2e walk (04: tests/e2e/slice1-walk.test.ts) — drives the CLI
 * in-process (runCli) against an injected TraceSource test double on a temp
 * store dir: connect → analyze (real since slice 4; an empty archive proposes
 * nothing) → proposals list, plus usage-error and not-connected paths. No
 * network: the double is an in-test fake.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import { createCanon } from '../../src/app.js';
import type { CanonApp } from '../../src/app.js';
import type { TraceSource } from '../../src/trace/traceSource.js';
import type { ProjectInfo } from '../../src/trace/types.js';

const FIXED_NOW = '2025-09-01T12:00:00.000Z';

/** TraceSource test double: answers projects; no observation/scores traffic in slice 1. */
function doubleSource(projects: ProjectInfo[]): TraceSource {
  return {
    kind: 'test-double',
    listProjects: async () => projects,
    queryObservations: async () => ({ data: [] }),
    queryScores: async () => ({ data: [] }),
  };
}

let dir: string;
let stdout: string[];
let stderr: string[];
let appFactory: ((opts: { dir: string }) => CanonApp) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-walk-'));
  stdout = [];
  stderr = [];
  appFactory = ({ dir: d }) =>
    createCanon({
      dir: d,
      source: doubleSource([{ id: 'prj-demo', name: 'Demo' }]),
      clock: () => FIXED_NOW,
    });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function cli(argv: string[]): Promise<number> {
  return runCli(argv, { createApp: appFactory });
}

describe('slice 1 CLI walk', () => {
  it('connect → analyze → proposals list end-to-end (empty archive proposes nothing)', async () => {
    // connect probes the injected double (project prj-demo exists) and writes config + audit
    const connectCode = await cli([
      'connect',
      '--host',
      'http://127.0.0.1:4318',
      '--project',
      'prj-demo',
      '--public-key',
      'pk-x',
      '--secret-key',
      'sk-x',
      '--env',
      'production',
      '--dir',
      dir,
    ]);
    expect(connectCode).toBe(0);
    expect(stdout.join('\n')).toContain('connected to project prj-demo');

    const configPath = join(dir, 'config.json');
    const st = await stat(configPath);
    expect(st.mode & 0o777).toBe(0o600); // config chmod 0600, verified by test
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    expect(cfg.schema).toBe('canon/config/v1');
    expect(cfg.connection.baseUrl).toBe('http://127.0.0.1:4318/api/public');
    expect(cfg.connection.connectedAt).toBe(FIXED_NOW);

    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"type":"connect"');
    expect(audit).not.toContain('sk-x'); // keys never reach the audit log

    // slice 3 made ingest real: against the empty test double a backfill
    // completes with zero rows and writes a sync checkpoint
    const ingestCode = await cli(['ingest', '--backfill', '--dir', dir]);
    expect(ingestCode).toBe(0);
    expect(stdout.join('\n')).toContain('ingest complete (backfill)');
    expect(stdout.join('\n')).toContain('new rows 0');
    stdout = [];

    // slice 4 made analyze real: an empty archive produces no trees and no
    // proposals (the empty/insufficient-evidence path)
    const analyzeCode = await cli(['analyze', '--dir', dir]);
    expect(analyzeCode).toBe(0);
    const analyzeOut = stdout.join('\n');
    expect(analyzeOut).toContain('trees 0');
    expect(analyzeOut).toContain('proposals created 0');

    // proposals list reads the (empty) queue back from the store
    const listCode = await cli(['proposals', 'list', '--dir', dir]);
    expect(listCode).toBe(0);
    expect(stdout.join('\n')).toContain('proposals (0 pending)');

    // second analyze is identical (idempotent over a stable archive)
    stdout = [];
    const again = await cli(['analyze', '--dir', dir]);
    expect(again).toBe(0);
    expect(stdout.join('\n')).toContain('trees 0');
    const list2 = await cli(['proposals', 'list', '--dir', dir]);
    expect(list2).toBe(0);
    expect(stdout.join('\n')).toMatch(/proposals \(0 pending\)/);
  });

  it('proposals list --json emits a machine-readable array', async () => {
    await cli([
      'connect',
      '--host',
      'http://127.0.0.1:4318',
      '--project',
      'prj-demo',
      '--public-key',
      'pk-x',
      '--secret-key',
      'sk-x',
      '--dir',
      dir,
    ]);
    stdout = [];
    await cli(['analyze', '--dir', dir]);
    stdout = [];
    const code = await cli(['proposals', 'list', '--status', 'all', '--json', '--dir', dir]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([]); // an empty archive proposes nothing
  });

  it('unknown command → exit 2 with a usage message on stderr', async () => {
    const code = await cli(['nonsense']);
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('unknown command');
  });

  it('connect without required flags → exit 2 (usage)', async () => {
    const code = await cli(['connect', '--dir', dir]);
    expect(code).toBe(2);
    expect(stderr.join('\n')).toContain('canon: error:');
    expect(stderr.join('\n')).toMatch(/missing required (host|project)/);
  });

  it('connect with a double that does not know the project → exit 1 (not-found)', async () => {
    appFactory = ({ dir: d }) =>
      createCanon({
        dir: d,
        source: doubleSource([{ id: 'prj-other', name: 'Other' }]),
        clock: () => FIXED_NOW,
      });
    const code = await cli([
      'connect',
      '--host',
      'http://127.0.0.1:4318',
      '--project',
      'prj-demo',
      '--public-key',
      'pk-x',
      '--secret-key',
      'sk-x',
      '--dir',
      dir,
    ]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('not found');
  });

  it('analyze before connect → exit 1 (not-connected) with a hint', async () => {
    const code = await cli(['analyze', '--dir', dir]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('not connected');
  });

  it('verbs land in their slices: ingest real in slice 3 (needs connect); later slices exit 1', async () => {
    // slice-3 real ingest on a store that was never connected → not-connected
    const ingestCode = await cli(['ingest', '--backfill', '--dir', dir]);
    expect(ingestCode).toBe(1);
    expect(stderr.join('\n')).toContain('not connected');

    // slice-5 verbs are real but need a connected store → not-connected
    stderr = [];
    const promoteCode = await cli(['governance', 'promote', 'prop_00000000', '--as', 'tester', '--dir', dir]);
    expect(promoteCode).toBe(1);
    expect(stderr.join('\n')).toContain('not connected');

    stderr = [];
    const canonCode = await cli(['canon', 'show', '--dir', dir]);
    expect(canonCode).toBe(1);
    expect(stderr.join('\n')).toContain('not connected');

    const helpCode = await cli(['--help']);
    expect(helpCode).toBe(0);
    expect(stdout.join('\n')).toContain('canon governance promote');
    expect(stdout.join('\n')).toContain('canon audit export');

    stdout = [];
    const versionCode = await cli(['--version']);
    expect(versionCode).toBe(0);
    expect(stdout.join('\n')).toMatch(/^canon \d+\.\d+\.\d+$/);
  });
});
