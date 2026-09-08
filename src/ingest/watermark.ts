/**
 * Window/watermark bookkeeping for the sync engine (03 ingest/watermark.ts:
 * "from/to window bookkeeping (obs vs scores)"). Pure functions only — no
 * I/O, no wall clock (all times flow in). Windows follow the [DEC-08]
 * TimeWindow convention: from inclusive, to exclusive.
 */

import { addDays, addHours, clampFrom, compare } from '../core/time.js';
import type { IsoTime } from '../core/time.js';
import type { TimeWindow } from '../trace/traceSource.js';

/**
 * Split [from, to) into consecutive chunks of at most `chunkDays`, returned
 * oldest → newest (the engine walks them newest → oldest). Partial chunks are
 * allowed (the oldest chunk may be shorter). Deterministic on UTC day
 * boundaries. Empty/backwards ranges yield []. Callers must have validated
 * from <= to.
 */
export function chunkWindows(from: IsoTime, to: IsoTime, chunkDays: number): TimeWindow[] {
  const chunks: TimeWindow[] = [];
  if (compare(from, to) >= 0 || chunkDays <= 0) return chunks;
  let cursor = to;
  while (compare(from, cursor) < 0) {
    const start = addDays(cursor, -chunkDays);
    const wFrom = compare(start, from) <= 0 ? from : start;
    chunks.push({ from: wFrom, to: cursor });
    cursor = wFrom;
  }
  chunks.reverse();
  return chunks;
}

/** Default backfill start: `to` minus the configured backfill horizon. */
export function backfillWindowFrom(to: IsoTime, backfillDays: number): IsoTime {
  return addDays(to, -backfillDays);
}

/**
 * Incremental window start: stored watermark when present, else `now` minus
 * the overlap hours — a fresh incremental poll only looks back as far as the
 * configured overlap. (03: watermark = "next incremental fromStartTime".)
 */
export function incrementalWindowFrom(
  watermark: IsoTime | null | undefined,
  now: IsoTime,
  overlapHours: number,
): IsoTime {
  return clampFrom(watermark ?? undefined, addHours(now, -overlapHours));
}

/**
 * Watermark after a successful poll that ended at `to`: the next poll starts
 * `overlapHours` before `to` so late-arriving rows at the window edge are
 * re-polled (dedupe absorbs the overlap).
 */
export function advanceWatermark(runTo: IsoTime, overlapHours: number): IsoTime {
  return addHours(runTo, -overlapHours);
}
