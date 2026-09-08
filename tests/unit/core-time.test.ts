import { describe, expect, it } from 'vitest';
import { CanonError } from '../../src/core/errors.js';
import {
  addDays,
  addHours,
  clampFrom,
  compare,
  nowIso,
  parseIso,
  toIso,
} from '../../src/core/time.js';
import type { Clock } from '../../src/core/time.js';

const FIXED: Clock = () => '2025-09-01T12:00:00.000Z';

describe('time [DEC-08 UTC ms Z]', () => {
  it('nowIso honours an injected clock (no wall clock in logic)', () => {
    expect(nowIso(FIXED)).toBe('2025-09-01T12:00:00.000Z');
  });

  it('nowIso without a clock returns the current RFC3339 UTC ms Z time', () => {
    const t = nowIso();
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('toIso/parseIso round-trip at ms precision', () => {
    const ms = Date.parse('2025-09-01T12:00:00.123Z');
    expect(toIso(ms)).toBe('2025-09-01T12:00:00.123Z');
    expect(parseIso(toIso(ms))).toBe(ms);
  });

  it('parseIso rejects non-UTC, naive, and non-ms forms', () => {
    for (const bad of [
      '2025-09-01T12:00:00Z', // no ms
      '2025-09-01T12:00:00+02:00', // non-UTC
      '2025-09-01 12:00:00.000Z', // space separator
      'not-a-time',
      '',
    ]) {
      expect(() => parseIso(bad)).toThrowError(
        expect.objectContaining({ code: 'validation' }),
      );
    }
    expect(() => parseIso('not-a-time')).toThrow(CanonError);
  });

  it('compare returns epoch ordering', () => {
    expect(compare('2025-09-01T12:00:00.000Z', '2025-09-01T12:00:00.000Z')).toBe(0);
    expect(compare('2025-09-01T12:00:00.000Z', '2025-09-01T12:00:01.000Z')).toBeLessThan(0);
    expect(compare('2025-09-02T12:00:00.000Z', '2025-09-01T12:00:01.000Z')).toBeGreaterThan(0);
  });

  it('addDays/addHours shift by exact UTC day/hour units (incl. negative)', () => {
    const t = '2025-09-01T12:00:00.000Z';
    expect(addDays(t, 0)).toBe(t);
    expect(addDays(t, 1)).toBe('2025-09-02T12:00:00.000Z');
    expect(addDays(t, -1)).toBe('2025-08-31T12:00:00.000Z');
    // DST-free UTC: 30-day + 24-hour arithmetic stays exact across month ends
    expect(addDays('2025-08-31T00:00:00.000Z', 1)).toBe('2025-09-01T00:00:00.000Z');
    expect(addDays('2025-01-01T00:00:00.000Z', -1)).toBe('2024-12-31T00:00:00.000Z');
    expect(addHours(t, 24)).toBe('2025-09-02T12:00:00.000Z');
    expect(addHours(t, -1)).toBe('2025-09-01T11:00:00.000Z');
    expect(addHours(t, 0.5)).toBe('2025-09-01T12:30:00.000Z');
  });

  it('addDays/addHours reject non-UTC input via parseIso', () => {
    expect(() => addDays('2025-09-01T12:00:00Z', 1)).toThrowError(
      expect.objectContaining({ code: 'validation' }),
    );
  });

  it('clampFrom prefers the given bound and falls back when undefined', () => {
    const fallback = '2025-09-01T00:00:00.000Z';
    expect(clampFrom('2025-08-01T00:00:00.000Z', fallback)).toBe('2025-08-01T00:00:00.000Z');
    expect(clampFrom(undefined, fallback)).toBe(fallback);
  });
});
