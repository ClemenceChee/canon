import { describe, expect, it } from 'vitest';
import {
  advanceWatermark,
  backfillWindowFrom,
  chunkWindows,
  incrementalWindowFrom,
} from '../../src/ingest/watermark.js';

describe('ingest watermark helpers', () => {
  it('chunkWindows splits [from,to) into at-most-chunkDays chunks, oldest first', () => {
    const from = '2025-08-27T00:00:00.000Z';
    const to = '2025-09-01T00:00:00.000Z';
    const five = chunkWindows(from, to, 5);
    expect(five).toEqual([{ from: '2025-08-27T00:00:00.000Z', to: '2025-09-01T00:00:00.000Z' }]);

    const two = chunkWindows(from, to, 2);
    // chunked from the top (newest) backwards: the partial chunk is the oldest
    expect(two).toHaveLength(3); // 08-27..08-28 (partial), 08-28..08-30, 08-30..09-01
    expect(two[0]).toEqual({ from: '2025-08-27T00:00:00.000Z', to: '2025-08-28T00:00:00.000Z' });
    expect(two[1]).toEqual({ from: '2025-08-28T00:00:00.000Z', to: '2025-08-30T00:00:00.000Z' });
    expect(two[2]).toEqual({ from: '2025-08-30T00:00:00.000Z', to: '2025-09-01T00:00:00.000Z' });

    // windows are contiguous, ordered, cover the range exactly
    for (let i = 1; i < two.length; i += 1) {
      expect(two[i]!.from).toBe(two[i - 1]!.to);
    }
    expect(two[0]!.from).toBe(from);
    expect(two[two.length - 1]!.to).toBe(to);
  });

  it('chunkWindows returns [] for empty/backwards/zero-size chunks', () => {
    const t = '2025-09-01T00:00:00.000Z';
    expect(chunkWindows(t, t, 1)).toEqual([]);
    expect(chunkWindows('2025-09-02T00:00:00.000Z', t, 1)).toEqual([]);
    expect(chunkWindows('2025-09-01T00:00:00.000Z', '2025-09-02T00:00:00.000Z', 0)).toEqual([]);
  });

  it('partial chunks are allowed at the oldest end', () => {
    const from = '2025-08-27T12:00:00.000Z'; // half-day offset
    const to = '2025-09-01T00:00:00.000Z';
    const chunks = chunkWindows(from, to, 2);
    expect(chunks[0]!.from).toBe(from); // the first (oldest) chunk is partial
    expect(chunks[chunks.length - 1]!.to).toBe(to);
  });

  it('backfillWindowFrom / incrementalWindowFrom / advanceWatermark bookkeeping', () => {
    const now = '2025-09-01T12:00:00.000Z';
    expect(backfillWindowFrom(now, 1)).toBe('2025-08-31T12:00:00.000Z');
    expect(backfillWindowFrom(now, 7)).toBe('2025-08-25T12:00:00.000Z');

    // no watermark → fall back to now − overlap
    expect(incrementalWindowFrom(null, now, 24)).toBe('2025-08-31T12:00:00.000Z');
    expect(incrementalWindowFrom(undefined, now, 24)).toBe('2025-08-31T12:00:00.000Z');
    // stored watermark wins
    expect(incrementalWindowFrom('2025-09-01T00:00:00.000Z', now, 24)).toBe(
      '2025-09-01T00:00:00.000Z',
    );
    // after a poll ending at `now`, the next fromStartTime sits 24h behind it
    expect(advanceWatermark(now, 24)).toBe('2025-08-31T12:00:00.000Z');
  });
});
