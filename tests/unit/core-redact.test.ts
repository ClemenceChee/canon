import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/core/redact.js';

describe('redact [DEC-06]', () => {
  it('is deterministic: same text → same digest', () => {
    const r = createRedactor({ enabled: true });
    expect(r('password=hunter2', 'input')).toBe(r('password=hunter2', 'input'));
    expect(r('password=hunter2', 'input')).toMatch(/^\[redacted:[0-9a-f]{8}\]$/);
  });

  it('never contains raw text in output', () => {
    const r = createRedactor({ enabled: true });
    const out = r('SECRET-TOKEN-abc', 'output') ?? '';
    expect(out).not.toContain('SECRET-TOKEN-abc');
  });

  it('accepts every content kind and passes undefined through', () => {
    const r = createRedactor({ enabled: true });
    for (const kind of ['input', 'output', 'comment', 'metadata', 'statusMessage'] as const) {
      expect(r('x', kind)).toMatch(/^\[redacted:/);
    }
    expect(r(undefined, 'input')).toBeUndefined();
  });

  it('digest prefix is configurable', () => {
    const r = createRedactor({ enabled: true, digestPrefix: 'scrubbed' });
    expect(r('x', 'comment')).toMatch(/^\[scrubbed:[0-9a-f]{8}\]$/);
  });

  it('disabled redactor passes text through unchanged', () => {
    const r = createRedactor({ enabled: false });
    expect(r('raw content', 'input')).toBe('raw content');
    expect(r.scrubJson({ a: 'raw' }, 'input')).toEqual({ a: 'raw' });
  });

  it('scrubJson deep-scrubs strings in nested objects/arrays and keeps structure', () => {
    const r = createRedactor({ enabled: true });
    const v = {
      text: 'hello',
      nested: { inner: 'world' },
      list: ['a', { deep: 'b' }],
      num: 42,
      flag: true,
    };
    const out = r.scrubJson(v, 'metadata') as typeof v;
    expect(out.text).toMatch(/^\[redacted:/);
    expect(out.nested.inner).toMatch(/^\[redacted:/);
    expect(out.list[0]).toMatch(/^\[redacted:/);
    expect((out.list[1] as { deep: string }).deep).toMatch(/^\[redacted:/);
    expect(out.num).toBe(42);
    expect(out.flag).toBe(true);
    // raw content never appears
    expect(JSON.stringify(out)).not.toContain('hello');
  });

  it('hash is a stable full sha256 hex digest (exportable evidence digest)', () => {
    const r = createRedactor({ enabled: true });
    expect(r.hash('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(r.hash('abc')).toBe(r.hash('abc'));
    expect(r.hash('abc')).not.toBe(r.hash('abd'));
  });
});
