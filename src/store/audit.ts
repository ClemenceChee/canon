/**
 * Audit log [DEC-10/DEC-11]: append-only mutation log, monotonic `seq`, read
 * fold. Lines carry ids/counts/times ONLY — never io content, never keys.
 * Append happens after the state file it records is durable (atomic rename).
 */

import type { IsoTime } from '../core/time.js';
import { appendJsonObject, readJsonLines } from './jsonl.js';

export type AuditType =
  | 'connect'
  | 'ingest.page'
  | 'ingest.complete'
  | 'analysis.run'
  | 'proposal.created'
  | 'proposal.decayed'
  | 'governance.promote'
  | 'governance.reject'
  | 'governance.promote-override'
  | 'policy.created'
  | 'export.run'
  | 'config.changed';

export interface AuditEvent {
  seq: number;
  at: IsoTime;
  actor: string; // 'system' | reviewer handle
  type: AuditType;
  projectId: string;
  payload: Record<string, unknown>; // ids/counts/times ONLY [DEC-11]
}

/**
 * Draft as callers construct it; the store assigns `seq` (last + 1) under lock.
 * (03 declares appendAudit(e: AuditEvent) but its own rule — "seq = last + 1,
 * under lock" — means callers never supply seq; this draft type encodes that.)
 */
export type AuditEventDraft = Omit<AuditEvent, 'seq'>;

export function nextSeq(events: AuditEvent[]): number {
  let max = 0;
  for (const e of events) {
    if (typeof e.seq === 'number' && e.seq > max) max = e.seq;
  }
  return max + 1;
}

export interface AuditReadResult {
  events: AuditEvent[];
  /** number of corrupted lines skipped while reading (never silently dropped). */
  skipped: number;
}

/**
 * Tolerant read. Returns parsed events plus the count of corrupted lines that
 * were skipped. Flagging choice (QA F5): 03 locks `readAudit` to
 * `Promise<AuditEvent[]>` and the store's read path is the compliance
 * surface, so the PUBLIC read reports corruption via a console warning on the
 * store facade; the append-side seq computation below intentionally stays
 * silent — a torn tail is crash-normal and warning per append would spam.
 */
export async function readAuditLog(path: string): Promise<AuditReadResult> {
  const { rows, skipped } = await readJsonLines<AuditEvent>(path);
  // tolerate missing seq/sorted by file order = seq order
  return { events: rows.sort((a, b) => a.seq - b.seq), skipped };
}

/** Append (caller holds the store lock). Returns the stored event with seq. */
export async function appendAuditEvent(
  path: string,
  draft: AuditEventDraft,
): Promise<AuditEvent> {
  const { events } = await readAuditLog(path);
  const event: AuditEvent = { ...draft, seq: nextSeq(events) };
  await appendJsonObject(path, event);
  return event;
}
