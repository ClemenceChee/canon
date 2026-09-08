/**
 * Atomic file helpers: tmp-file + fsync + rename (never in-place writes), plus
 * mkdir/chmod. State files (config, sync-state, index, proposal, policy) must
 * go through atomic writes so they can never tear. [03: Async + ordering]
 */

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CanonError } from '../core/errors.js';

/** Recursive mkdir, then enforce the requested mode (dirs 0700 per 02). */
export async function mkdirp(dir: string, mode = 0o700): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await chmod(dir, mode);
  } catch (e) {
    throw new CanonError(`cannot create directory ${dir}: ${String(e)}`, {
      code: 'io',
      cause: e,
    });
  }
}

/**
 * Atomic write: unique tmp file in the same directory → write → fsync →
 * chmod (so mode is exact regardless of umask) → rename → best-effort dir
 * fsync. On any failure the tmp file is removed and nothing at `path` changes.
 */
export async function atomicWriteFile(
  path: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let handle;
  try {
    handle = await open(tmp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.chmod(mode);
    await handle.close();
    handle = undefined;
    await rename(tmp, path);
  } catch (e) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    if (e instanceof CanonError) throw e;
    throw new CanonError(`atomic write failed for ${path}: ${String(e)}`, {
      code: 'io',
      cause: e,
    });
  }
  // Best-effort directory fsync for rename durability (not fatal on error).
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // directory fsync unsupported (e.g. some platforms) — ignore
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Enforce a mode on an existing path (perm audit at open/write). */
export async function chmodPath(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (e) {
    throw new CanonError(`cannot set permissions on ${path}: ${String(e)}`, {
      code: 'io',
      cause: e,
    });
  }
}
