/**
 * Archive store (02 store layout): append-only envelope JSONL under
 * archive/observations.jsonl + archive/scores.jsonl, plus the derived
 * index.json (trace summaries + observation-id → line map, rebuildable).
 *
 * Envelope v1 wraps each Langfuse row VERBATIM (incl. unknown keys — DEC-2
 * tolerance); the archive is the raw-evidence tier and never decays
 * (ADR-0001 DEC-3). Dedupe is by row id, done inside the append (the store
 * is the single owner of "what is archived"); the scan is O(rows) per append
 * — fine at the v0.1 [ASSUMPTION] scale (≤ ~500k rows); a persistent id
 * index is the growth path when that assumption is revisited.
 *
 * Readers are tolerant like store/jsonl.ts: a torn/unparseable line is
 * skipped, counted and surfaced (never silently dropped); line numbers are
 * 1-based and refer to physical lines in the file.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonError } from '../core/errors.js';
import { STORE_FILES } from '../core/constants.js';
import type { IsoTime } from '../core/time.js';
import type { LfObservationRow, LfScoreRow } from '../trace/types.js';
import { appendJsonObjects } from './jsonl.js';

export type ArchiveKind = 'observation' | 'score';

/** Archive envelope v1 (03 store facade). `row` is the Langfuse row verbatim. */
export interface Envelope<T> {
  v: 1;
  kind: ArchiveKind;
  fetchedAt: IsoTime;
  projectId: string;
  source: string;
  page: number;
  row: T;
}

export type EnvelopeRow = Envelope<LfObservationRow> | Envelope<LfScoreRow>;

/**
 * Outcome triple. 03 declares Outcome under its Analyze section, but the
 * store's IndexData references it (03 store facade), so the type lives here —
 * the store is the lower layer and slice-4's analyze modules import it from
 * here (same co-location precedent as store/proposals.ts).
 */
export type Outcome = 'success' | 'failure' | 'unknown';

export interface TraceSummary {
  rootObservationId?: string;
  agentId?: string;
  taskKey: string;
  environment?: string;
  startTime?: IsoTime;
  endTime?: IsoTime;
  /** Always 'unknown' from ingest's index rebuild — outcome classification is analyze-owned (slice 4 inferOutcome). */
  outcome: Outcome;
  lineFrom: number;
  lineTo: number;
}

export interface IndexData {
  schema: 'canon/index/v1';
  builtAt: IsoTime;
  projectId: string;
  traceCount: number;
  observationCount: number;
  traces: Record<string, TraceSummary>;
  observations: Record<string, { line: number }>;
}

export const INDEX_SCHEMA = 'canon/index/v1';

export function archiveObsPath(dir: string): string {
  return join(dir, STORE_FILES.archiveDir, STORE_FILES.observations);
}
export function archiveScoresPath(dir: string): string {
  return join(dir, STORE_FILES.archiveDir, STORE_FILES.scores);
}
export function indexPath(dir: string): string {
  return join(dir, STORE_FILES.index);
}

export interface ArchiveLine<T> {
  line: number; // 1-based physical line in the file
  envelope: Envelope<T>;
}

export interface ArchiveRead<T> {
  rows: ArchiveLine<T>[];
  /** 1-based line numbers that did not parse as an envelope of this kind. */
  corrupted: number[];
}

function kindOfKind(k: ArchiveKind): 'observation' | 'score' {
  return k === 'observation' ? 'observation' : 'score';
}

/**
 * Tolerant line reader for one archive file. A line counts as corrupted when
 * it is not valid JSON or does not parse to a matching envelope (v===1, kind
 * matches, row is an object) — empty lines are skipped silently (append-side
 * artifacts). Rows come back in file order (line asc).
 */
export async function readArchiveFile<T>(
  path: string,
  kind: ArchiveKind,
): Promise<ArchiveRead<T>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { rows: [], corrupted: [] };
    throw new CanonError(`cannot read archive file ${path}: ${String(e)}`, {
      code: 'io',
      cause: e,
    });
  }
  const rows: ArchiveLine<T>[] = [];
  const corrupted: number[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length === 0) continue;
    const line = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      corrupted.push(line);
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const row = obj.row;
    if (
      obj.v !== 1 ||
      obj.kind !== kindOfKind(kind) ||
      typeof row !== 'object' ||
      row === null ||
      Array.isArray(row)
    ) {
      corrupted.push(line);
      continue;
    }
    rows.push({ line, envelope: parsed as Envelope<T> });
  }
  return { rows, corrupted };
}

function rowId(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Append a page's envelopes, deduplicating by row id against the file AND the
 * batch. Returns appended/dupe counts; ordering of the input batch is
 * preserved. Caller holds the store lock (single writer).
 */
export async function appendUniqueRows<T extends EnvelopeRow>(
  path: string,
  kind: ArchiveKind,
  rows: T[],
): Promise<{ appended: number; dupes: number }> {
  if (rows.length === 0) return { appended: 0, dupes: 0 };
  const existing = await readArchiveFile(path, kind);
  const seen = new Set<string>();
  for (const { envelope } of existing.rows) {
    const id = rowId(envelope.row);
    if (id !== null) seen.add(id);
  }
  const toAppend: T[] = [];
  let dupes = 0;
  for (const env of rows) {
    const id = rowId(env.row);
    if (id === null || seen.has(id)) {
      dupes += 1;
      continue;
    }
    seen.add(id);
    toAppend.push(env);
  }
  if (toAppend.length > 0) {
    await appendJsonObjects(path, toAppend);
  }
  return { appended: toAppend.length, dupes };
}

/** Distinct archived row ids per kind (used by --dry-run dupe accounting). */
export async function archivedRowIds(
  obsPath: string,
  scoresPath: string,
): Promise<{ observations: Set<string>; scores: Set<string> }> {
  const obs = new Set<string>();
  const { rows: obsRows } = await readArchiveFile<LfObservationRow>(obsPath, 'observation');
  for (const { envelope } of obsRows) {
    const id = rowId(envelope.row);
    if (id !== null) obs.add(id);
  }
  const scores = new Set<string>();
  const { rows: scoreRows } = await readArchiveFile<LfScoreRow>(scoresPath, 'score');
  for (const { envelope } of scoreRows) {
    const id = rowId(envelope.row);
    if (id !== null) scores.add(id);
  }
  return { observations: obs, scores };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Rebuild the index from the observation archive (O(rows) scan — 02: index is
 * derived and self-healing; corruption of index.json ⇒ rebuild). Rows without
 * a traceId still appear in `observations` (evidence by id resolves) but not
 * in `traces`. Trace summaries: line span, time bounds, and root-ish fields.
 * `outcome` is always 'unknown' in slice 3 — see TraceSummary doc.
 */
export async function buildIndexData(opts: {
  obsPath: string;
  projectId: string;
  builtAt: IsoTime;
}): Promise<IndexData> {
  const { rows, corrupted } = await readArchiveFile<LfObservationRow>(
    opts.obsPath,
    'observation',
  );
  if (corrupted.length > 0) {
    // ingest-time self-heal/report: a torn tail after a crash is expected —
    // flag it once per rebuild instead of failing the whole ingest
    console.warn(
      `canon: warning: ${opts.obsPath} contains ${corrupted.length} corrupted line(s) ` +
        `(${corrupted.join(',')}) — excluded from the index`,
    );
  }

  const groups = new Map<string, Array<{ line: number; row: LfObservationRow }>>();
  const observations: Record<string, { line: number }> = {};
  for (const { line, envelope } of rows) {
    const r = envelope.row;
    observations[r.id] = { line };
    const traceId = r.traceId;
    if (typeof traceId !== 'string' || traceId.length === 0) continue;
    const list = groups.get(traceId) ?? [];
    list.push({ line, row: r });
    groups.set(traceId, list);
  }

  const traces: Record<string, TraceSummary> = {};
  for (const [traceId, list] of groups) {
    // line-ascending (file order)
    const rootish = list.filter(
      (e) => e.row.isRootObservation === true || e.row.parentObservationId == null,
    );
    const head = rootish[0] ?? list[0]!;
    let startTime: IsoTime | undefined;
    let endTime: IsoTime | undefined;
    for (const { row } of list) {
      if (row.startTime !== undefined && ISO_RE.test(row.startTime)) {
        if (startTime === undefined || row.startTime < startTime) startTime = row.startTime;
      }
      if (row.endTime !== undefined && ISO_RE.test(row.endTime)) {
        if (endTime === undefined || row.endTime > endTime) endTime = row.endTime;
      }
    }
    const taskKey =
      head.row.traceName !== undefined && head.row.traceName.length > 0
        ? head.row.traceName
        : list.find((e) => e.row.traceName !== undefined && e.row.traceName.length > 0)?.row
            .traceName ?? '';
    const agentRow = rootish.find((e) => e.row.type === 'AGENT');
    const isRoot = head.row.parentObservationId == null || head.row.isRootObservation === true;
    const rootId = isRoot ? head.row.id : rootish[0]?.row.id;
    const summary: TraceSummary = {
      ...(rootId !== undefined ? { rootObservationId: rootId } : {}),
      ...(agentRow !== undefined && agentRow.row.name !== undefined
        ? { agentId: agentRow.row.name }
        : {}),
      taskKey,
      ...(head.row.environment !== undefined ? { environment: head.row.environment } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      outcome: 'unknown', // slice-4 inferOutcome owns classification
      lineFrom: list[0]!.line,
      lineTo: list[list.length - 1]!.line,
    };
    traces[traceId] = summary;
  }

  return {
    schema: INDEX_SCHEMA,
    builtAt: opts.builtAt,
    projectId: opts.projectId,
    traceCount: Object.keys(traces).length,
    observationCount: Object.keys(observations).length,
    traces,
    observations,
  };
}
