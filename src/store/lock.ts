/**
 * O_EXCL advisory lock with PID stale detection (02 failure mode: two
 * concurrent processes; store is single-writer). Lock file content carries
 * {pid, at, nonce}; a lock whose pid is dead (or unparseable) is stale and can
 * be taken over.
 */

import { randomBytes } from 'node:crypto';
import { readFile, unlink, open } from 'node:fs/promises';
import { CanonError } from '../core/errors.js';
import { nowIso } from '../core/time.js';

export interface LockContent {
  pid: number;
  at: string;
  nonce: string;
}

/** True when the pid is not running (ESRCH) — i.e. the lock is stale. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === 'EPERM'; // exists but not ours — alive
  }
}

export async function readLockContent(lockPath: string): Promise<LockContent | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockContent>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.at !== 'string' ||
      typeof parsed.nonce !== 'string'
    ) {
      return undefined;
    }
    return parsed as LockContent;
  } catch {
    return undefined; // unreadable/unparseable → treat as stale
  }
}

export interface LockHandle {
  release(): Promise<void>;
}

/**
 * Acquire the advisory lock. Throws CanonError('locked') when another live
 * process holds it. Stale locks (dead pid, or unparseable content) are removed
 * and retried once.
 */
export async function acquireLock(lockPath: string): Promise<LockHandle> {
  const content: LockContent = {
    pid: process.pid,
    at: nowIso(),
    nonce: randomBytes(6).toString('hex'),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(content));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        async release(): Promise<void> {
          const current = await readLockContent(lockPath);
          if (current !== undefined && current.nonce === content.nonce) {
            await unlink(lockPath).catch(() => {});
          }
        },
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw new CanonError(`cannot acquire store lock ${lockPath}: ${String(e)}`, {
          code: 'io',
          cause: e,
        });
      }
      const current = await readLockContent(lockPath);
      if (current !== undefined && pidAlive(current.pid)) {
        throw new CanonError(
          `store is locked by another process (pid ${current.pid}); retry when it exits`,
          { code: 'locked' },
        );
      }
      // stale: pid dead or content unparseable — remove and retry once
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new CanonError(`store lock ${lockPath} could not be acquired`, {
    code: 'locked',
  });
}

/** Remove a stale lock (dead pid) if present — called on store open. Never throws. */
export async function cleanupStaleLock(lockPath: string): Promise<void> {
  const current = await readLockContent(lockPath);
  if (current !== undefined && !pidAlive(current.pid)) {
    await unlink(lockPath).catch(() => {});
  }
}
