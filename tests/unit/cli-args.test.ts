import { describe, expect, it } from 'vitest';
import { parseCommand } from '../../src/cli/args.js';
import { CanonError } from '../../src/core/errors.js';

describe('cli args (hand-rolled parser)', () => {
  it('parses connect flags incl. repeated --env', () => {
    const p = parseCommand([
      'connect',
      '--host',
      'https://cloud.langfuse.com',
      '--project',
      'prj-1',
      '--public-key=pk-a',
      '--secret-key',
      'sk-b',
      '--env',
      'production',
      '--env',
      'staging',
      '--dir',
      '/tmp/x',
      '--force',
      '--wipe',
    ]);
    expect(p.verb).toBe('connect');
    expect(p.sub).toBeUndefined();
    expect(p.args.host).toBe('https://cloud.langfuse.com');
    expect(p.args.project).toBe('prj-1');
    expect(p.args.publicKey).toBe('pk-a');
    expect(p.args.secretKey).toBe('sk-b');
    expect(p.args.env).toEqual(['production', 'staging']);
    expect(p.args.dir).toBe('/tmp/x');
    expect(p.args.force).toBe(true);
    expect(p.args.wipe).toBe(true);
    expect(p.positionals).toEqual([]);
  });

  it('recognises subgroup verbs (proposals show <id> folds the positional into args.id)', () => {
    const p = parseCommand(['proposals', 'show', 'prop_1a2b3c4d', '--json']);
    expect(p.verb).toBe('proposals');
    expect(p.sub).toBe('show');
    expect(p.args.id).toBe('prop_1a2b3c4d');
    expect(p.args.json).toBe(true);
  });

  it('parses boolean and multi flags (governance promote)', () => {
    const p = parseCommand([
      'governance',
      'promote',
      'prop_9',
      '--as',
      'tester',
      '--edit',
      '--set',
      'severity=mandatory',
      '--set',
      'note=x',
      '--note',
      'ok on evidence',
    ]);
    expect(p.args.id).toBe('prop_9');
    expect(p.args.as).toBe('tester');
    expect(p.args.edit).toBe(true);
    expect(p.args.set).toEqual(['severity=mandatory', 'note=x']);
    expect(p.args.note).toBe('ok on evidence');
  });

  it('rejects unknown verbs/options and missing values as usage errors (exit 2)', () => {
    expect(() => parseCommand(['nonsense'])).toThrowError(
      expect.objectContaining({ code: 'usage', exitCode: 2 }),
    );
    expect(() => parseCommand(['connect', '--bogus', '1'])).toThrowError(
      expect.objectContaining({ code: 'usage', exitCode: 2 }),
    );
    expect(() => parseCommand(['connect', '--host'])).toThrowError(
      expect.objectContaining({ code: 'usage' }),
    );
    expect(() => parseCommand(['connect', '--redact=1'])).toThrowError(
      expect.objectContaining({ code: 'usage' }),
    );
    expect(() => parseCommand(['connect', 'stray'])).toThrowError(
      expect.objectContaining({ code: 'usage' }),
    );
  });

  it('requires the single <id> positional where the verb demands it', () => {
    expect(() => parseCommand(['proposals', 'show'])).toThrowError(
      expect.objectContaining({ code: 'usage', exitCode: 2 }),
    );
    expect(() => parseCommand(['proposals', 'show', 'a', 'b'])).toThrowError(
      expect.objectContaining({ code: 'usage' }),
    );
  });

  it('handles --help and --version pseudo-verbs', () => {
    expect(parseCommand(['--help']).verb).toBe('help');
    expect(parseCommand(['--version']).verb).toBe('version');
    const withHelp = parseCommand(['analyze', '--help']);
    expect(withHelp.verb).toBe('analyze');
    expect(withHelp.args.help).toBe(true);
  });

  it('bare subgroup verbs are usage errors (exit 2), --help still wins', () => {
    // reviewer N3: `canon proposals` (no subcommand) is not "not implemented"
    // — the 02 surface has no subgroup-less verb, so it is a usage error.
    for (const argv of [
      ['proposals'],
      ['governance'],
      ['canon'],
      ['audit'],
      ['proposals', '--json'],
      ['governance', '--as', 'tester'],
    ]) {
      expect(() => parseCommand(argv)).toThrowError(
        expect.objectContaining({ code: 'usage', exitCode: 2 }),
      );
    }
    // `canon proposals --help` shows help (parsed with args.help, exit 0 in main)
    const withHelp = parseCommand(['proposals', '--help']);
    expect(withHelp.sub).toBeUndefined();
    expect(withHelp.args.help).toBe(true);
  });

  it('rejects a bare invocation with no command', () => {
    expect(() => parseCommand([])).toThrow(CanonError);
  });
});
