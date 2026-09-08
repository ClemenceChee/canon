/**
 * Tiny hand-rolled argument parser (03 cli/args.ts) — no commander/cac. Verbs +
 * subgroup + flag table; unknown verb/flag/positional → CanonError('usage')
 * which the CLI maps to exit code 2.
 */

import { CanonError } from '../core/errors.js';

export interface ParsedCommand {
  verb: string;
  sub?: string;
  /** canonical camelCase keys; value flags → string, bools → true, multi → string[]. */
  args: Record<string, unknown>;
  /** remaining positional tokens (validated per verb below). */
  positionals: string[];
}

interface FlagDef {
  kind: 'value' | 'bool';
  multi?: boolean;
}

/** Every option canon accepts, keyed by its kebab-case spelling. */
const FLAGS: Record<string, FlagDef> = {
  // connect / ingest (DEC-11)
  'insecure-http': { kind: 'bool' },
  host: { kind: 'value' },
  project: { kind: 'value' },
  'public-key': { kind: 'value' },
  'secret-key': { kind: 'value' },
  env: { kind: 'value', multi: true },
  dir: { kind: 'value' },
  redact: { kind: 'bool' },
  'no-redact': { kind: 'bool' },
  force: { kind: 'bool' },
  wipe: { kind: 'bool' }, // connect --force --wipe: clear previous project's archive/index/sync-state + proposals/canon (DEC-22)
  // ingest
  from: { kind: 'value' },
  to: { kind: 'value' },
  'window-days': { kind: 'value' },
  'small-pages': { kind: 'bool' },
  'dry-run': { kind: 'bool' },
  incremental: { kind: 'bool' },
  backfill: { kind: 'bool' },
  // analyze
  since: { kind: 'value' },
  // proposals
  status: { kind: 'value' },
  kind: { kind: 'value', multi: true },
  json: { kind: 'bool' },
  // governance
  as: { kind: 'value' },
  edit: { kind: 'bool' },
  set: { kind: 'value', multi: true },
  note: { kind: 'value' },
  reason: { kind: 'value' },
  // status
  'rebuild-index': { kind: 'bool' },
  // export / audit export
  format: { kind: 'value' },
  out: { kind: 'value' },
  'verify-links': { kind: 'bool' },
  // global
  help: { kind: 'bool' },
  version: { kind: 'bool' },
};

export const VERBS = [
  'connect',
  'ingest',
  'analyze',
  'proposals',
  'governance',
  'canon',
  'export',
  'audit',
  'metrics',
  'status',
] as const;

const SUBVERBS: Record<string, string[]> = {
  proposals: ['list', 'show'],
  governance: ['promote', 'reject'],
  canon: ['show'],
  audit: ['export'],
};

/** positionals required per verb[:sub]; 0 unless noted. */
const REQUIRED_POSITIONALS: Record<string, number> = {
  'proposals:show': 1,
  'governance:promote': 1,
  'governance:reject': 1,
};

function usage(msg: string): CanonError {
  return new CanonError(msg, { code: 'usage', hint: 'run canon --help for usage' });
}

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function parseCommand(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    throw usage('no command given');
  }
  const verb = argv[0]!;
  if (verb === '--help' || verb === '-h') {
    return { verb: 'help', args: {}, positionals: [] };
  }
  if (verb === '--version' || verb === '-V') {
    return { verb: 'version', args: {}, positionals: [] };
  }
  if (!(VERBS as readonly string[]).includes(verb)) {
    throw usage(`unknown command ${JSON.stringify(verb)}`);
  }

  let i = 1;
  let sub: string | undefined;
  const subs = SUBVERBS[verb];
  const candidate = argv[i];
  if (subs !== undefined && candidate !== undefined && subs.includes(candidate)) {
    sub = candidate;
    i += 1;
  }

  const args: Record<string, unknown> = {};
  const positionals: string[] = [];

  while (i < argv.length) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      i += 1;
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const def = FLAGS[name];
    if (def === undefined) {
      throw usage(`unknown option --${name}`);
    }
    const key = kebabToCamel(name);
    if (def.kind === 'bool') {
      if (inline !== undefined) {
        throw usage(`option --${name} does not take a value`);
      }
      args[key] = true;
      i += 1;
      continue;
    }
    let value: string;
    if (inline !== undefined) {
      value = inline;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw usage(`option --${name} requires a value`);
      }
      value = next;
      i += 1;
    }
    if (def.multi === true) {
      const arr = (args[key] as string[] | undefined) ?? [];
      arr.push(value);
      args[key] = arr;
    } else {
      args[key] = value;
    }
    i += 1;
  }

  const key = sub === undefined ? verb : `${verb}:${sub}`;
  const required = REQUIRED_POSITIONALS[key] ?? 0;
  if (positionals.length !== required) {
    if (required === 1) {
      throw usage(`${key} expects exactly one <id> argument`);
    }
    if (positionals.length > 0) {
      throw usage(`unexpected argument ${JSON.stringify(positionals[0])} for ${key}`);
    }
  }
  // A subgroup verb with no subgroup (e.g. bare `canon proposals`) is a usage
  // error (exit 2), not a missing command — the 02 surface has no such verb
  // without its subgroup. `--help` still wins so `canon proposals --help`
  // prints usage (handled in main before dispatch).
  if (subs !== undefined && sub === undefined && args.help !== true) {
    throw usage(`${verb} requires a subcommand (${subs.join(' | ')})`);
  }
  if (required === 1) {
    args.id = positionals[0]!; // length === required === 1 checked above
  }
  return { verb, sub, args, positionals };
}
