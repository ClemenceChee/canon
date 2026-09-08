/**
 * fetch wrapper (trace/langfuse/http.ts): Basic-auth header helper, retries
 * with exponential backoff, Retry-After honouring, per-request timeout,
 * redirects disabled [DEC-05].
 *
 * Classification (02 failure modes):
 *  - 401/403 → CanonError('auth-failed'), never retried
 *  - 429     → honour Retry-After (seconds | HTTP-date) + backoff; exhausted →
 *              CanonError('rate-limited')
 *  - 5xx / network / timeout → backoff up to maxRetries; exhausted →
 *              CanonError('source-down') for 5xx/network, CanonError('timeout')
 *              when the final failure was a request timeout
 *  - redirect (fetch redirect:'error' rejects) → treated as network-class
 *    failure; it never follows the redirect, so it always fails closed
 *
 * Determinism: backoff is deterministic (no random jitter) — retry/order
 * assertions in tests stay stable; sleeps use real timers, injected Clock is
 * accepted per the 03 signature but no wall-clock values enter logic.
 */

import { DEFAULT_HTTP_CONFIG } from '../../core/constants.js';
import { CanonError } from '../../core/errors.js';
import type { Clock } from '../../core/time.js';

export interface HttpConfig {
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  minIntervalMs?: number;
}

export type HttpConfigResolved = Required<HttpConfig> & { clock: Clock };

/**
 * Equivalent of the DOM `HeadersInit` (03 signature uses HeadersInit, which is
 * not available without the DOM lib; Node fetch accepts any of these).
 */
export type HeadersInitLike =
  | Headers
  | Record<string, string>
  | [string, string][];

/** Basic auth header value for Langfuse pk:sk. */
export function basicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`, 'utf8').toString('base64')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for request-timeout aborts (node fetch: TimeoutError DOMException) and other aborts. */
function isAbortLike(e: unknown): boolean {
  if (typeof e === 'object' && e !== null) {
    const name = (e as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    // undici wraps signal aborts as TypeError('fetch failed') with an abort cause
    const cause = (e as { cause?: unknown }).cause;
    if (typeof cause === 'object' && cause !== null) {
      const causeName = (cause as { name?: unknown }).name;
      if (causeName === 'TimeoutError' || causeName === 'AbortError') return true;
    }
  }
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/** Retry-After: integer seconds or HTTP-date → delay ms; undefined when absent/unparseable. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - Date.now());
}

function backoffMs(baseMs: number, failedAttempt: number): number {
  return baseMs * 2 ** failedAttempt;
}

function asCanonError(kind: 'network' | 'timeout', msg: string): CanonError {
  if (kind === 'timeout') {
    return new CanonError(msg, { code: 'timeout' });
  }
  return new CanonError(msg, { code: 'source-down' });
}

/**
 * GET `path` (absolute href, built by the client against its baseUrl) with the
 * given headers, following the retry policy above. Resolves with the parsed
 * JSON body on a 2xx response.
 */
export async function getWithRetry(
  path: string,
  init: { headers: HeadersInitLike },
  cfg: HttpConfigResolved,
): Promise<unknown> {
  const requestTimeoutMs = cfg.requestTimeoutMs;
  const maxRetries = cfg.maxRetries;
  const retryBaseMs = cfg.retryBaseMs;
  const minIntervalMs = cfg.minIntervalMs;

  let lastKind: 'network' | 'timeout' = 'network';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'GET',
        headers: init.headers,
        redirect: 'error', // [DEC-05] redirects fail closed
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (e) {
      lastKind = isAbortLike(e) ? 'timeout' : 'network';
      const retryable = attempt < maxRetries;
      if (retryable) {
        await sleep(Math.max(backoffMs(retryBaseMs, attempt), minIntervalMs));
        continue;
      }
      const what = lastKind === 'timeout' ? 'timed out' : 'failed';
      throw asCanonError(
        lastKind,
        `Langfuse request ${what} after ${maxRetries} retries: ${path}`,
      );
    }

    if (res.ok) {
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch (e) {
        throw new CanonError(`Langfuse returned a non-JSON response for ${path}`, {
          code: 'source-down',
          cause: e,
        });
      }
    }

    const status = res.status;
    if (status === 401 || status === 403) {
      throw new CanonError(
        `Langfuse rejected the credentials (HTTP ${status})`,
        {
          code: 'auth-failed',
          hint: 'check the public/secret keys and re-run canon connect',
        },
      );
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      if (attempt < maxRetries) {
        const backoff = backoffMs(retryBaseMs, attempt);
        await sleep(Math.max(retryAfterMs ?? 0, backoff, minIntervalMs));
        continue;
      }
      throw new CanonError(
        'Langfuse rate limit not resolved after all retries',
        {
          code: 'rate-limited',
          hint: 'retry later, lower the traffic window, or use --small-pages',
        },
      );
    }
    if (status >= 500 && status < 600) {
      if (attempt < maxRetries) {
        await sleep(Math.max(backoffMs(retryBaseMs, attempt), minIntervalMs));
        continue;
      }
      throw new CanonError(
        `Langfuse server error (HTTP ${status}) after ${maxRetries} retries`,
        { code: 'source-down' },
      );
    }
    // any other status (404 etc.) — fail fast, do not retry
    throw new CanonError(`unexpected Langfuse response (HTTP ${status})`, {
      code: 'source-down',
    });
  }
  // unreachable: loop always returns or throws
  throw new CanonError(`unreachable retry path for ${path}`, { code: 'internal' });
}

/** Resolve an HttpConfig against the [PROPOSED] defaults (single home). */
export function resolveHttpConfig(
  cfg?: HttpConfig,
  clock?: Clock,
): HttpConfigResolved {
  return {
    requestTimeoutMs: cfg?.requestTimeoutMs ?? DEFAULT_HTTP_CONFIG.requestTimeoutMs,
    maxRetries: cfg?.maxRetries ?? DEFAULT_HTTP_CONFIG.maxRetries,
    retryBaseMs: cfg?.retryBaseMs ?? DEFAULT_HTTP_CONFIG.retryBaseMs,
    minIntervalMs: cfg?.minIntervalMs ?? DEFAULT_HTTP_CONFIG.minIntervalMs,
    clock: clock ?? (() => new Date().toISOString()),
  };
}
