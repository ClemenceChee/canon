/**
 * Time helpers [DEC-08]: RFC3339 UTC, millisecond precision, always 'Z'.
 * No wall clock inside logic — Clock injection only.
 */

import { CanonError } from './errors.js';

export type IsoTime = string; // RFC3339 UTC, ms precision, always 'Z'
export type Clock = () => IsoTime;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function realNow(): IsoTime {
  return new Date().toISOString();
}

/** Current UTC time as IsoTime; injectable for determinism. */
export function nowIso(clock?: Clock): IsoTime {
  return (clock ?? realNow)();
}

/** Epoch ms; CanonError('validation') on malformed/non-UTC/naive input. */
export function parseIso(t: IsoTime): number {
  if (!ISO_RE.test(t)) {
    throw new CanonError(`not an RFC3339 UTC ms timestamp: ${t}`, {
      code: 'validation',
    });
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) {
    throw new CanonError(`not an RFC3339 UTC ms timestamp: ${t}`, {
      code: 'validation',
    });
  }
  return ms;
}

export function toIso(epochMs: number): IsoTime {
  return new Date(epochMs).toISOString();
}

/** Epoch compare: < 0 when a < b, 0 equal, > 0 when a > b. */
export function compare(a: IsoTime, b: IsoTime): number {
  return parseIso(a) - parseIso(b);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000; // canonical store math is UTC ms; window arithmetic

/** t + N days (N may be negative) — windowed sync helpers (03 core/time.ts). */
export function addDays(t: IsoTime, days: number): IsoTime {
  return toIso(parseIso(t) + days * DAY_MS);
}

/** t + N hours (N may be negative) — overlap/watermark math. */
export function addHours(t: IsoTime, hours: number): IsoTime {
  return toIso(parseIso(t) + hours * HOUR_MS);
}

/**
 * Window start resolution: prefer a caller-supplied bound, else the fallback
 * (used to merge explicit --from/--to with stored watermarks; 03 signature).
 */
export function clampFrom(t: IsoTime | undefined, fallback: IsoTime): IsoTime {
  return t !== undefined ? t : fallback;
}
