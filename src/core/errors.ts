/** Typed error convention [DEC-02]: throw CanonError; never return error objects. */

export type CanonErrorCode =
  | 'usage'
  | 'not-connected'
  | 'not-found'
  | 'invalid-state'
  | 'validation'
  | 'source-down'
  | 'rate-limited'
  | 'auth-failed'
  | 'timeout'
  | 'store-corrupt'
  | 'locked'
  | 'io'
  | 'internal';

const RETRYABLE_CODES: ReadonlySet<CanonErrorCode> = new Set([
  'source-down',
  'rate-limited',
  'timeout',
]);

/** usage → exit 2, everything else → exit 1 (02 exit codes). */
export function exitCodeFor(code: CanonErrorCode): 1 | 2 {
  return code === 'usage' ? 2 : 1;
}

export class CanonError extends Error {
  readonly code: CanonErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly exitCode: 1 | 2;

  constructor(
    msg: string,
    opts: { code: CanonErrorCode; hint?: string; cause?: unknown },
  ) {
    super(msg, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CanonError';
    this.code = opts.code;
    this.retryable = RETRYABLE_CODES.has(opts.code);
    this.hint = opts.hint;
    this.exitCode = exitCodeFor(opts.code);
  }
}

export function isCanonError(e: unknown): e is CanonError {
  return e instanceof CanonError;
}

/** Rethrow non-CanonError as CanonError('internal', { cause: e }). */
export function fail(e: unknown): never {
  if (isCanonError(e)) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  throw new CanonError(msg, { code: 'internal', cause: e });
}
