/**
 * DEC-13 regression (QA F2): a committed test drives `connect` through the
 * DEFAULT Langfuse HTTP adapter (no injected TraceSource double) against the
 * in-process fake Langfuse server — including the 401 no-retry path. This
 * protects the app/CLI → default-adapter → HTTP seam that slice 1/2 tests
 * left uncovered.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/main.js';
import { startFakeLangfuseServer } from '../fixtures/fakeLangfuseServer.js';
import type { FakeServerHandle } from '../fixtures/fakeLangfuseServer.js';

const servers: FakeServerHandle[] = [];
async function boot(opts?: Parameters<typeof startFakeLangfuseServer>[0]): Promise<FakeServerHandle> {
  const s = await startFakeLangfuseServer(opts);
  servers.push(s);
  return s;
}

let dir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canon-connect-http-'));
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

/** runCli WITHOUT a createApp dep — the default app builds the default Langfuse source. */
async function cli(argv: string[]): Promise<number> {
  return runCli(argv);
}

describe('connect through the default Langfuse HTTP adapter (DEC-13)', () => {
  it('connects over loopback HTTP: config 0600, connect audit without keys, Basic auth sent', async () => {
    const server = await boot(); // scenario refunds → projects fixture has prj-refunds
    const code = await cli([
      'connect',
      '--host',
      server.url,
      '--project',
      'prj-refunds',
      '--public-key',
      'pk-demo',
      '--secret-key',
      'sk-demo',
      '--dir',
      dir,
    ]);
    expect(code).toBe(0);
    expect(stdout.join('\n')).toContain('connected to project prj-refunds');

    // server saw exactly one /projects request with the correct Basic header
    const proj = server.requests().filter((r) => r.route === 'projects');
    expect(proj).toHaveLength(1);
    const expected = `Basic ${Buffer.from('pk-demo:sk-demo').toString('base64')}`;
    expect(proj[0]?.authorization).toBe(expected);
    expect(proj[0]?.pathname).toBe('/api/public/projects');

    // config written 0600, pointing at the fixture server
    const configPath = join(dir, 'config.json');
    const st = await stat(configPath);
    expect(st.mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    expect(cfg.connection.baseUrl).toBe(server.baseUrl);
    expect(cfg.connection.projectId).toBe('prj-refunds');

    // connect audit line contains no key material
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"type":"connect"');
    expect(audit).not.toContain('sk-demo');
    expect(audit).not.toContain('pk-demo');
  });

  it('401 on /projects → auth-failed with zero retries and nothing written', async () => {
    const server = await boot({
      behaviors: [{ route: 'projects', times: 5, status: 401 }], // budget unused: 401 never retried
    });
    const code = await cli([
      'connect',
      '--host',
      server.url,
      '--project',
      'prj-refunds',
      '--public-key',
      'pk-bad',
      '--secret-key',
      'sk-bad',
      '--dir',
      dir,
    ]);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toContain('rejected the credentials');

    const proj = server.requests().filter((r) => r.route === 'projects');
    expect(proj).toHaveLength(1); // zero retries even though the budget allows 5

    // no config.json / audit.jsonl written (probe failed before any state write)
    await expect(stat(join(dir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dir, 'audit.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    // and the keys never appear in any output
    const allOut = [...stdout, ...stderr].join('\n');
    expect(allOut).not.toContain('sk-bad');
  });
});
