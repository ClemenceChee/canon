import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanonError } from '../../src/core/errors.js';
import {
  asObject,
  asOptionalIso,
  asOptionalString,
  asString,
  asStringArray,
} from '../../src/core/validators.js';

describe('validators [DEC-04 lenient]', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asObject/asString accept well-formed input and throw validation otherwise', () => {
    expect(asObject({ a: 1 }, 'x')).toEqual({ a: 1 });
    expect(asString('v', 'x')).toBe('v');
    for (const bad of [null, undefined, [1], 's', 3]) {
      expect(() => asObject(bad, 'x')).toThrowError(
        expect.objectContaining({ code: 'validation' }),
      );
    }
    expect(() => asString(1, 'x')).toThrow(CanonError);
  });

  it('optional accessors degrade to undefined, never throw', () => {
    expect(asOptionalString(5)).toBeUndefined();
    expect(asOptionalString('ok')).toBe('ok');
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray(['a', 2, 'b'])).toEqual(['a', 'b']);
  });

  it('asOptionalIso returns undefined for absent or malformed values (warn once, lenient)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(asOptionalIso(undefined)).toBeUndefined();
    expect(asOptionalIso(42)).toBeUndefined();
    expect(asOptionalIso('garbage')).toBeUndefined();
    expect(asOptionalIso('2025-09-01T12:00:00.000Z')).toBe('2025-09-01T12:00:00.000Z');
    expect(warn).toHaveBeenCalledTimes(1); // malformed warned once globally
    vi.restoreAllMocks();
  });
});
