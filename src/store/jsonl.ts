/**
 * Streaming JSONL append + tolerant line reader. The append-only archive and
 * audit log use these; readers degrade to skip-and-report (torn tail after a
 * crash/ENOSPC is tolerated and counted, never fatal).
 */

import { open, readFile } from 'node:fs/promises';
import { CanonError } from '../core/errors.js';
import { PERMS } from '../core/constants.js';

export interface JsonLinesResult<T> {
  rows: T[];
  /** number of lines skipped (empty lines excluded, malformed/torn counted). */
  skipped: number;
}

/** Append one JSON object as a line (delegates to the batched writer). */
export async function appendJsonObject(path: string, value: unknown): Promise<void> {
  await appendJsonObjects(path, [value]);
}

/**
 * Append several JSON objects as lines in ONE open/fsync — the ingest engine
 * appends a whole page (≤1000 rows) per call, so per-row fsyncs would be
 * wasteful. Same self-healing tail + 0600-mode rules as the single writer
 * (review N2: audit.jsonl and archive JSONLs hold sensitive content).
 */
export async function appendJsonObjects(path: string, values: unknown[]): Promise<void> {
  if (values.length === 0) return;
  let handle;
  try {
    handle = await open(path, 'a+', PERMS.dataFile); // read+append: we inspect the previous tail byte
    const stat = await handle.stat();
    // enforce the exact mode when the file pre-existed with looser perms
    if ((stat.mode & 0o777) !== PERMS.dataFile) await handle.chmod(PERMS.dataFile);
    if (stat.size > 0) {
      const tail = Buffer.alloc(1);
      const { bytesRead } = await handle.read(tail, 0, 1, stat.size - 1);
      if (bytesRead === 1 && tail[0] !== 0x0a) {
        await handle.write('\n');
      }
    }
    let text = '';
    for (const value of values) text += `${JSON.stringify(value)}\n`;
    await handle.write(text);
    await handle.sync();
    await handle.close();
  } catch (e) {
    if (handle !== undefined) await handle.close().catch(() => {});
    throw new CanonError(`jsonl append failed for ${path}: ${String(e)}`, {
      code: 'io',
      cause: e,
    });
  }
}

/** Tolerant reader: parse every non-empty line; malformed lines are skipped+counted. */
export async function readJsonLines<T = unknown>(
  path: string,
): Promise<JsonLinesResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { rows: [], skipped: 0 };
    throw new CanonError(`cannot read ${path}: ${String(e)}`, {
      code: 'io',
      cause: e,
    });
  }
  const rows: T[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}
