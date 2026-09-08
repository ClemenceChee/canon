/**
 * Deterministic redactor [DEC-06 / ADR DEC-4]: view/export-time redaction is on
 * by default; ingest-time redaction is a connect setting. Deterministic digest
 * per content string, deep scrub for objects/arrays, stable full-hash for
 * evidence digests. Keys and raw io content never reach logs or views.
 */

import { createHash } from 'node:crypto';

export type ContentKind =
  | 'input'
  | 'output'
  | 'comment'
  | 'metadata'
  | 'statusMessage';

export interface RedactorOptions {
  enabled: boolean;
  digestPrefix?: string; // default 'redacted'
}

export interface Redactor {
  /** '[redacted:<sha256(text).slice(0,8)>]' when enabled; else pass-through. */
  (text: string | undefined, kind: ContentKind): string | undefined;
  /** Deep scrub of strings in object/array leaves. */
  scrubJson(v: unknown, kind: ContentKind): unknown;
  /** Stable, exportable digest (full sha256 hex) — evidence digests. */
  hash(v: string): string;
}

function digestOf(text: string, prefix: string): string {
  const short = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
  return `[${prefix}:${short}]`;
}

export function createRedactor(opts?: RedactorOptions): Redactor {
  const options: Required<RedactorOptions> = {
    enabled: opts?.enabled ?? false,
    digestPrefix: opts?.digestPrefix ?? 'redacted',
  };

  const redactor = ((text: string | undefined, _kind: ContentKind) => {
    if (!options.enabled) return text;
    if (text === undefined) return undefined;
    return digestOf(text, options.digestPrefix);
  }) as Redactor;

  redactor.scrubJson = (v: unknown, kind: ContentKind): unknown => {
    if (!options.enabled) return v;
    if (typeof v === 'string') return digestOf(v, options.digestPrefix);
    if (Array.isArray(v)) return v.map((item) => redactor.scrubJson(item, kind));
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(v)) {
        out[key] = redactor.scrubJson(value, kind);
      }
      return out;
    }
    return v;
  };

  redactor.hash = (v: string): string =>
    createHash('sha256').update(v, 'utf8').digest('hex');

  return redactor;
}
