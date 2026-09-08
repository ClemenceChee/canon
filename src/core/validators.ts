/**
 * Lenient field parsers [DEC-04] — never zod, never strict schemas. Only the
 * fields canon consumes are guaranteed; extra keys pass through verbatim.
 * `asOptional*`/lenient readers degrade to skip-and-report; the strict `as*`
 * parsers throw CanonError('validation').
 */

import { CanonError } from './errors.js';
import type { IsoTime } from './time.js';

function validation(label: string, detail: string): CanonError {
  return new CanonError(`${label}: ${detail}`, { code: 'validation' });
}

/** v must be a plain-ish object (not null, not array). */
export function asObject(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw validation(label, 'expected an object');
  }
  return v as Record<string, unknown>;
}

export function asString(v: unknown, label: string): string {
  if (typeof v !== 'string') throw validation(label, 'expected a string');
  return v;
}

export function asOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v;
}

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

let warnedMalformedIso = false;

/**
 * undefined when absent OR malformed (warn once, lenient — tolerant of upstream
 * growth). Used by page/row readers that must not die on one bad timestamp.
 */
export function asOptionalIso(v: unknown): IsoTime | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) {
    if (!warnedMalformedIso) {
      warnedMalformedIso = true;
      console.warn(`canon: warning: malformed ISO timestamp ignored (lenient): ${v}`);
    }
    return undefined;
  }
  if (Number.isNaN(Date.parse(v))) {
    if (!warnedMalformedIso) {
      warnedMalformedIso = true;
      console.warn(`canon: warning: malformed ISO timestamp ignored (lenient): ${v}`);
    }
    return undefined;
  }
  return v;
}
