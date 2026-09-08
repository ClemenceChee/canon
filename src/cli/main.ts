/**
 * CLI entry (03 cli/main.ts): argv → dispatch → exit code. Shebang is added by
 * tsup (banner) so the file is also importable for in-process tests.
 *
 * DEC-02/02 exit codes: 0 success · 1 runtime error (typed message) · 2 usage.
 * Error discipline: exactly one `canon: error: <message>` line on stderr (+
 * `canon: hint:` when present); stack only under CANON_DEBUG=1. stdout carries
 * command output only; stderr carries diagnostics.
 */

import { pathToFileURL } from 'node:url';
import { createCanon } from '../app.js';
import type { CanonApp } from '../app.js';
import { CANON_VERSION } from '../core/constants.js';
import { CanonError, isCanonError } from '../core/errors.js';
import { parseCommand } from './args.js';
import connect from './commands/connect.js';
import ingest from './commands/ingest.js';
import analyze from './commands/analyze.js';
import { proposalsList, proposalsShow } from './commands/proposals.js';
import { governancePromote, governanceReject } from './commands/governance.js';
import canonShow from './commands/canonShow.js';
import exportCmd from './commands/exportCmd.js';
import auditExport from './commands/auditExport.js';
import metricsCmd from './commands/metricsCmd.js';
import statusCmd from './commands/statusCmd.js';

export interface CommandCtx {
  app: CanonApp;
  args: Record<string, unknown>;
  redactViews: boolean;
  /** SIGINT seam (02 failure table / 04 Slice 7): commands set `syncing`
   * while they run a gracefully-abortable operation; the SIGINT handler then
   * sets `requested` instead of exiting, and the operation returns 130. */
  interrupt: InterruptState;
}

export interface InterruptState {
  syncing: boolean;
  requested: boolean;
}

/** Resolved value = exit code. */
export type Command = (ctx: CommandCtx) => Promise<number>;

/** Keyed by verb (+ subgroup) per the 02 API table. */
export const COMMANDS: Record<string, Command> = {
  connect,
  ingest,
  analyze,
  'proposals:list': proposalsList,
  'proposals:show': proposalsShow,
  'governance:promote': governancePromote,
  'governance:reject': governanceReject,
  'canon:show': canonShow,
  export: exportCmd,
  'audit:export': auditExport,
  metrics: metricsCmd,
  status: statusCmd,
};

export function helpText(): string {
  return `canon ${CANON_VERSION} — agent behaviour governance from Langfuse traces

usage: canon <verb> [args]        (--help / --version also accepted)
options go after the verb; --dir <path> overrides the store location
(default: .canon under the cwd, or $CANON_DIR).

verbs:
  canon connect --host <origin> --project <id> [--public-key <pk>] [--secret-key <sk>]
                [--env production] [--dir <path>] [--redact|--no-redact] [--force]
                [--wipe] (with --force: switch project, clearing the previous
                project's archive/index/sync-state, proposals and canon)
                [--insecure-http] (plain http to a non-loopback host — trusted nets only)
  canon ingest [--incremental|--backfill] [--from <iso>] [--to <iso>]
               [--window-days N] [--small-pages] [--dry-run] [--insecure-http]
               [--dir <path>]
  canon analyze [--since <iso>] [--env <name>…] [--dir <path>]
  canon proposals list [--status pending|all] [--kind <kind>…] [--redact] [--json]
  canon proposals show <proposalId> [--redact] [--json]
  canon governance promote <proposalId> --as <reviewer> [--edit] [--set <field>=<value>]… [--note "<text>"]
  canon governance reject <proposalId> --as <reviewer> [--reason "<text>"]
  canon canon show [--json]
  canon export --format guardrules-json|json [--out <path>] [--verify-links]
  canon audit export [--format json|md] [--out <path>] [--redact]
  canon metrics [--json]
  canon status [--rebuild-index] [--json]
  canon --help | --version

exit codes: 0 ok · 1 runtime error · 2 usage error · 130 interrupted (SIGINT mid-ingest checkpoints and resumes)
environment: CANON_DIR, CANON_LANGFUSE_PUBLIC_KEY, CANON_LANGFUSE_SECRET_KEY,
             CANON_OPERATOR (default reviewer handle), CANON_DEBUG=1 (stacks)`;
}

function dirFromArgs(args: Record<string, unknown>): string {
  if (typeof args.dir === 'string' && args.dir.length > 0) return args.dir;
  const env = process.env.CANON_DIR;
  if (env !== undefined && env.length > 0) return env;
  return '.canon';
}

export interface RunCliDeps {
  /** Test seam: build the app per command (e.g. inject a TraceSource double). */
  createApp?: (opts: { dir: string }) => CanonApp;
}

// Shared SIGINT state: while an ingest run is `syncing`, Ctrl-C requests a
// graceful abort (finish page, checkpoint, exit 130 via the command's return
// code); otherwise SIGINT exits 130 immediately (Node default behaviour).
const interruptState: InterruptState = { syncing: false, requested: false };
let signalWired = false;
function wireSigintHandler(): void {
  if (signalWired) return;
  signalWired = true;
  process.on('SIGINT', () => {
    if (interruptState.syncing) {
      interruptState.requested = true;
      return;
    }
    process.exit(130);
  });
}

/** Parse argv, dispatch one command, return its exit code (never throws). */
export async function runCli(argv: string[], deps?: RunCliDeps): Promise<number> {
  wireSigintHandler();
  try {
    const parsed = parseCommand(argv);
    if (parsed.verb === 'help') {
      console.log(helpText());
      return 0;
    }
    if (parsed.verb === 'version') {
      console.log(`canon ${CANON_VERSION}`);
      return 0;
    }
    if (parsed.args.help === true) {
      console.log(helpText());
      return 0;
    }
    const dir = dirFromArgs(parsed.args);
    const create = deps?.createApp ?? ((o: { dir: string }) => createCanon(o));
    const app = create({ dir });
    // redaction on by default for views; --no-redact opts out for this command
    const redactViews = parsed.args.noRedact === true ? false : true;
    const ctx: CommandCtx = {
      app,
      args: parsed.args,
      redactViews,
      interrupt: interruptState,
    };
    const key = parsed.sub === undefined ? parsed.verb : `${parsed.verb}:${parsed.sub}`;
    const cmd = COMMANDS[key];
    if (cmd === undefined) {
      // registry covers the full 02 verb surface; reaching here is a bug
      console.error(`canon: not implemented: ${key}`);
      return 1;
    }
    return await cmd(ctx);
  } catch (e) {
    const err = isCanonError(e)
      ? e
      : new CanonError(e instanceof Error ? e.message : String(e), {
          code: 'internal',
          cause: e,
        });
    console.error(`canon: error: ${err.message}`);
    if (err.hint !== undefined) console.error(`canon: hint: ${err.hint}`);
    if (process.env.CANON_DEBUG === '1' && !isCanonError(e) && e instanceof Error && e.stack) {
      console.error(e.stack);
    }
    return err.exitCode;
  }
}

// bin entry: run only when executed as the CLI (not when imported in tests)
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`canon: error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
