import { describe, expect, it } from 'vitest';
import { CanonError, exitCodeFor, fail, isCanonError } from '../../src/core/errors.js';

describe('errors [DEC-02]', () => {
  it('maps usage → exit 2 and everything else → exit 1', () => {
    expect(exitCodeFor('usage')).toBe(2);
    expect(exitCodeFor('not-connected')).toBe(1);
    expect(exitCodeFor('source-down')).toBe(1);
    expect(exitCodeFor('internal')).toBe(1);
  });

  it('flags retryable only for source-down | rate-limited | timeout', () => {
    expect(new CanonError('x', { code: 'source-down' }).retryable).toBe(true);
    expect(new CanonError('x', { code: 'rate-limited' }).retryable).toBe(true);
    expect(new CanonError('x', { code: 'timeout' }).retryable).toBe(true);
    expect(new CanonError('x', { code: 'auth-failed' }).retryable).toBe(false);
    expect(new CanonError('x', { code: 'usage' }).retryable).toBe(false);
    expect(new CanonError('x', { code: 'locked' }).retryable).toBe(false);
  });

  it('carries hint and exitCode', () => {
    const e = new CanonError('boom', {
      code: 'auth-failed',
      hint: 'rotate keys',
    });
    expect(e.message).toBe('boom');
    expect(e.hint).toBe('rotate keys');
    expect(e.exitCode).toBe(1);
    expect(e.code).toBe('auth-failed');
  });

  it('isCanonError distinguishes typed errors', () => {
    expect(isCanonError(new CanonError('x', { code: 'io' }))).toBe(true);
    expect(isCanonError(new Error('x'))).toBe(false);
  });

  it('fail() rethrows CanonError unchanged and wraps others as internal', () => {
    const typed = new CanonError('typed', { code: 'validation' });
    expect(() => fail(typed)).toThrowError(typed);
    expect(() => fail(new Error('raw'))).toThrowError(
      expect.objectContaining({ code: 'internal', message: 'raw' }),
    );
  });
});
