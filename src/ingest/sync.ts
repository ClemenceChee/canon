/**
 * ingest/sync.ts — the sync engine (04 Slice 3 / 03 ingest/sync.ts):
 *
 *  - backfill: windowed walk of [from, to) in `windowDays` chunks, newest →
 *    oldest (Langfuse pages are newest-first), observations v2 and scores v3
 *    on their own cursor walks inside every chunk;
 *  - incremental: forward polls from the stored observation/score watermarks,
 *    each window ending at `to`, with the configured overlap re-polled behind
 *    the watermark (late rows absorbed by id-dedupe);
 *  - idempotency: dedupe by row id inside the store append; resume after a
 *    partial run re-walks uncompleted kind-windows and dedupes;
 *  - checkpoints: sync-state is written after every completed kind-window
 *    (atomic rename), archive appends happen BEFORE the checkpoint that
 *    acknowledges them, audit appends happen after the state is durable;
 *  - --small-pages: a retryable page fetch failure halves the page limit and
 *    retries the same page (02 oversized-page failure mode);
 *  - --dry-run: fetches and counts but writes nothing.
 *
 * Persistence granularity is the completed kind-window: the 03 SyncState
 * schema has no per-page fields, and page-level re-fetch is always safe
 * because appends dedupe by id (see SyncCompletedWindow.kind note).
 */

import { CanonError, fail } from '../core/errors.js';
import {
  OBSERVATIONS_LIMIT_MAX,
  SCORES_LIMIT_MAX,
  SMALL_PAGE_LIMIT_FLOOR,
} from '../core/constants.js';
import type { Clock, IsoTime } from '../core/time.js';
import { clampFrom, compare } from '../core/time.js';
import type { Redactor } from '../core/redact.js';
import type { ContentKind } from '../core/redact.js';
import type { LfObservationRow, LfScoreRow } from '../trace/types.js';
import type { ObsQuery, ScoreQuery, TraceSource } from '../trace/traceSource.js';
import type { CanonStore } from '../store/index.js';
import type { Envelope } from '../store/archive.js';
import {
  advanceWatermark,
  backfillWindowFrom,
  chunkWindows,
  incrementalWindowFrom,
} from './watermark.js';

export const SYNC_SCHEMA = 'canon/sync/v1';

export type SyncMode = 'backfill' | 'incremental';

export interface SyncCompletedWindow {
  from: IsoTime;
  to: IsoTime;
  rows: number;
  /**
   * Additive schema field: resume skips are kind-scoped so a crash between
   * the observations walk and the scores walk of the same time chunk cannot
   * skip the unfinished kind. (03's SyncState shows no kind — additive, kept
   * optional for forward-compatibility with pre-slice-3 state files.)
   */
  kind?: 'observation' | 'score';
}

export interface SyncState {
  schema: 'canon/sync/v1';
  projectId: string;
  mode: SyncMode;
  completedWindows: SyncCompletedWindow[];
  observationWatermark: IsoTime | null; // next incremental fromStartTime
  scoreWatermark: IsoTime | null; // next incremental fromTimestamp (score time)
  lastRun?: { at: IsoTime; pages: number; newRows: number; dupes: number; aborted?: boolean };
}

export interface SyncSettings {
  backfillWindowDays: number;
  incrementalOverlapHours: number;
  politeDelayMs: number;
}

export interface SyncRunOptions {
  store: CanonStore;
  source: TraceSource;
  clock: Clock;
  projectId: string;
  environment: string[];
  settings: SyncSettings;
  mode: SyncMode;
  /** --window-days chunk size for backfill windows. */
  windowDays: number;
  from?: IsoTime; // explicit window start (backfill) / override (incremental)
  to?: IsoTime; // explicit window end; defaults to clock()
  smallPages?: boolean;
  dryRun?: boolean;
  /**
   * Graceful-stop seam (02 failure table: SIGINT / Ctrl-C — "finish current
   * page, checkpoint, exit 130"). Called between page fetches; when it
   * returns true the run stops after the page in flight, writes an aborted
   * checkpoint (lastRun.aborted, watermarks NOT advanced) and returns a
   * report with `aborted: true` — never a throw. A rerun resumes from the
   * checkpoint exactly like a failed run.
   */
  abort?: () => boolean;
  /**
   * Enabled redactor (ADR-0001 DEC-4 / MUST-1): when present, content-bearing
   * fields of every row are scrubbed at envelope construction (see
   * scrubObservationRow / scrubScoreRow for the exact field list). Absent ⇒
   * rows are archived verbatim — the default. The store never scrubs; the
   * sync engine owns "what leaves the source" so dedupe (row ids) and all
   * structural analysis keep working on a scrubbed archive.
   */
  redact?: Redactor;
}

export interface SyncRunReport {
  windows: number;
  pages: number;
  newRows: number;
  dupes: number;
  from?: IsoTime;
  to: IsoTime;
  /** true when the run stopped early via the abort seam (SIGINT); a rerun resumes. */
  aborted?: boolean;
}

type Window = { from: IsoTime; to: IsoTime };

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowKey(kind: 'observation' | 'score', w: Window): string {
  return `${kind}|${w.from}|${w.to}`;
}

/**
 * ADR-0001 DEC-4 ingest-time redaction (acceptance MUST-1): scrub the
 * CONTENT-BEARING fields of a Langfuse row before it is archived. Field
 * choice follows what analysis actually consumes (03/02 + src/analyze + src/
 * propose): analyze reads observation structure only — id/traceId/type/name/
 * level/start|endTime/environment/model/input|outputPrice/costDetails/
 * traceName/sessionId/userId/parentObservationId/isRootObservation and the
 * PRESENCE (never content) of statusMessage; scoring reads score name/value/
 * dataType/subject/timestamp. So the scrubbed set is exactly the free-text /
 * opaque fields and nothing structural:
 *   observation rows: input, output, metadata (deep-scrub), statusMessage;
 *   score rows:       comment.
 * usage/costs/prices/timestamps/ids/keys/names/levels are NEVER scrubbed —
 * analysis, evidence links, index and exports depend on them. The redactor's
 * digest for statusMessage is non-empty, so failure/outcome presence signals
 * survive; a timeout witness whose NAME carries the token still classifies.
 */
function scrubText(r: Redactor, v: unknown, kind: ContentKind): unknown {
  if (typeof v === 'string') {
    // empty/whitespace-only content has nothing to scrub — digesting '' would
    // turn AGENT/TOOL/CHAIN rows with statusMessage '' into non-blank (a
    // failure signal), so empties pass through byte-identical.
    return v.trim().length === 0 ? v : r(v, kind);
  }
  // tolerant io/metadata may arrive as JSON values, not strings — deep-scrub
  return r.scrubJson(v, kind);
}

function scrubObservationRow(row: LfObservationRow, r: Redactor): LfObservationRow {
  const out: LfObservationRow = { ...row };
  if (row.input !== undefined) out.input = scrubText(r, row.input, 'input') as string;
  if (row.output !== undefined) out.output = scrubText(r, row.output, 'output') as string;
  if (row.metadata !== undefined) out.metadata = r.scrubJson(row.metadata, 'metadata');
  if (row.statusMessage !== undefined) {
    out.statusMessage = scrubText(r, row.statusMessage, 'statusMessage') as string;
  }
  return out;
}

function scrubScoreRow(row: LfScoreRow, r: Redactor): LfScoreRow {
  const out: LfScoreRow = { ...row };
  if (row.comment !== undefined) out.comment = scrubText(r, row.comment, 'comment') as string;
  return out;
}

/** A page fetch with the --small-pages limit-halving fallback (02 oversized page). */
async function fetchPage(
  source: TraceSource,
  kind: 'observation' | 'score',
  q: ObsQuery | ScoreQuery,
  cursor: string | undefined,
  smallPages: boolean,
): Promise<{ data: Array<LfObservationRow | LfScoreRow>; cursor: string | undefined }> {
  let limit = kind === 'observation' ? OBSERVATIONS_LIMIT_MAX : SCORES_LIMIT_MAX;
  for (;;) {
    const attempt = { ...q, limit }; // each retry carries the current (halved) limit
    try {
      const page =
        kind === 'observation'
          ? await source.queryObservations(attempt as ObsQuery, cursor)
          : await source.queryScores(attempt as ScoreQuery, cursor);
      const next = page.meta?.cursor;
      return {
        data: page.data as Array<LfObservationRow | LfScoreRow>,
        cursor: next === null || next === undefined || next === '' ? undefined : next,
      };
    } catch (e) {
      const canHalve =
        e instanceof CanonError &&
        (e.code === 'source-down' || e.code === 'timeout') &&
        limit > SMALL_PAGE_LIMIT_FLOOR;
      if (!smallPages || !canHalve) throw e;
      limit = Math.floor(limit / 2); // oversized page → halve and retry the same page
    }
  }
}

interface RunCounters {
  pages: number;
  newRows: number;
  dupes: number;
}

/**
 * Run one sync pass. Writes checkpoints + audits (unless dryRun) and THROWS
 * on failure after leaving a safe checkpoint (partial sync resumes). Expects
 * the caller to hold the store lock (single writer).
 */
export async function runSync(opts: SyncRunOptions): Promise<SyncRunReport> {
  const { store, clock, projectId, mode, dryRun } = opts;
  const now = opts.to ?? clock();
  const settings = opts.settings;
  const envFilter = opts.environment.length > 0 ? [...opts.environment] : undefined;
  const queryBase = {
    projectId,
    ...(envFilter !== undefined ? { environment: envFilter } : {}),
  };

  const prior = await store.readSyncState();
  const completed: SyncCompletedWindow[] = [...(prior?.completedWindows ?? [])];
  const done = new Set(completed.map((w) => windowKey(w.kind ?? 'observation', w)));
  let observationWatermark: IsoTime | null = prior?.observationWatermark ?? null;
  let scoreWatermark: IsoTime | null = prior?.scoreWatermark ?? null;

  const counters: RunCounters = { pages: 0, newRows: 0, dupes: 0 };
  let windowsWalked = 0;
  let runFrom: IsoTime | undefined;
  let abortRequested = false;

  // dry-run dedupe seeds: distinct archived row ids so a dry run reports the
  // same dupes a real run would (03's store contract has no id read, so this
  // additive read-only method exists for exactly this)
  const drySeen =
    dryRun === true
      ? await store.readStoredRowIds()
      : { observations: new Set<string>(), scores: new Set<string>() };

  async function writeCheckpoint(aborted?: boolean): Promise<void> {
    if (dryRun) return;
    await store.writeSyncState({
      schema: SYNC_SCHEMA,
      projectId,
      mode,
      completedWindows: completed,
      observationWatermark,
      scoreWatermark,
      lastRun: {
        at: clock(),
        pages: counters.pages,
        newRows: counters.newRows,
        dupes: counters.dupes,
        ...(aborted === true ? { aborted: true } : {}),
      },
    });
  }

  /** Walk one kind's pages for a window; appends (or dry-counts) page by page. */
  async function walkKindWindow(kind: 'observation' | 'score', window: Window): Promise<void> {
    const seen = kind === 'observation' ? drySeen.observations : drySeen.scores;
    let cursor: string | undefined;
    let pageOrdinal = 0;
    let windowNewRows = 0;
    for (;;) {
      const q = { ...queryBase, window };
      const page = await fetchPage(opts.source, kind, q, cursor, opts.smallPages === true);
      pageOrdinal += 1;
      counters.pages += 1;
      const fetchedAt = clock();

      let newRows = 0;
      let dupes = 0;
      if (dryRun === true) {
        for (const row of page.data) {
          const id = (row as { id?: unknown }).id;
          if (typeof id !== 'string' || id.length === 0 || seen.has(id)) dupes += 1;
          else {
            seen.add(id);
            newRows += 1;
          }
        }
      } else {
        // DEC-4 ingest-time redaction gate: scrub content-bearing fields at
        // envelope construction when an enabled redactor was supplied
        // (settings.redact.ingest). Redaction is deterministic, so a resume
        // refetch re-scrubs to byte-identical rows; dedupe keys (row ids)
        // are untouched.
        const redactor = opts.redact;
        const rowsOut =
          redactor === undefined
            ? page.data
            : kind === 'observation'
              ? page.data.map((row) =>
                  scrubObservationRow(row as LfObservationRow, redactor),
                )
              : page.data.map((row) => scrubScoreRow(row as LfScoreRow, redactor));
        const envelopes = rowsOut.map((row) => ({
          v: 1 as const,
          kind,
          fetchedAt,
          projectId,
          source: opts.source.kind,
          page: pageOrdinal,
          row,
        }));
        const res =
          kind === 'observation'
            ? await store.appendObservationRows(envelopes as Array<Envelope<LfObservationRow>>)
            : await store.appendScoreRows(envelopes as Array<Envelope<LfScoreRow>>);
        newRows = res.appended;
        dupes = res.dupes;
        // audit AFTER the archive append it records is durable (03 ordering)
        await store.appendAudit({
          at: fetchedAt,
          actor: 'system',
          type: 'ingest.page',
          projectId,
          payload: {
            kind,
            page: pageOrdinal,
            windowFrom: window.from,
            windowTo: window.to,
            newRows,
            dupes,
          },
        });
      }
      windowNewRows += newRows;
      counters.newRows += newRows;
      counters.dupes += dupes;

      if (settings.politeDelayMs > 0 && dryRun !== true) {
        await sleep(settings.politeDelayMs);
      }
      cursor = page.cursor;
      if (cursor === undefined) break;
      // 02 graceful stop: honour the abort request at the NEXT page boundary
      // (the current page is fully appended + checkpointed by then). Remaining
      // windows stay incomplete so a rerun re-walks them from the checkpoint.
      if (opts.abort?.() === true) {
        abortRequested = true;
        break;
      }
    }

    // completed kind-window → durable checkpoint BEFORE any audit that
    // references this progress; archive appends already happened above
    if (dryRun !== true && !abortRequested) {
      completed.push({ from: window.from, to: window.to, rows: windowNewRows, kind });
      done.add(windowKey(kind, window));
      await writeCheckpoint();
    }
  }

  try {
    if (mode === 'backfill') {
      const from = clampFrom(opts.from, backfillWindowFrom(now, settings.backfillWindowDays));
      runFrom = from;
      // newest → oldest (04), skipping kind-windows that are already complete
      const chunks = chunkWindows(from, now, opts.windowDays).reverse();
      for (const win of chunks) {
        if (abortRequested) break;
        if (!done.has(windowKey('observation', win))) {
          windowsWalked += 1;
          await walkKindWindow('observation', win);
        }
        if (abortRequested) break;
        if (!done.has(windowKey('score', win))) {
          await walkKindWindow('score', win);
        }
      }
    } else {
      // incremental: one observations window + one scores window (own watermark)
      const obsWin: Window = {
        from: clampFrom(
          opts.from,
          incrementalWindowFrom(observationWatermark, now, settings.incrementalOverlapHours),
        ),
        to: now,
      };
      const scoreWin: Window = {
        from: clampFrom(
          opts.from,
          incrementalWindowFrom(scoreWatermark, now, settings.incrementalOverlapHours),
        ),
        to: now,
      };
      runFrom = obsWin.from;
      if (compare(obsWin.from, now) < 0 && !done.has(windowKey('observation', obsWin))) {
        windowsWalked += 1;
        await walkKindWindow('observation', obsWin);
      }
      if (!abortRequested && compare(scoreWin.from, now) < 0 && !done.has(windowKey('score', scoreWin))) {
        await walkKindWindow('score', scoreWin);
      }
    }

    // ---- end-of-run finalisation (ADR-0003 DEC-14) ----
    // The derived index is rebuilt BEFORE the final checkpoint that
    // acknowledges the run (advanced watermarks + lastRun). A failure during
    // the rebuild must leave sync-state WITHOUT the final checkpoint, so the
    // next run — whose window moves past the un-advanced watermark — refetches
    // and rebuilds. Previously the final checkpoint landed first and a crash
    // mid-rebuild left a stale-but-present index that a no-new-rows resume
    // never refreshed (review S1 / QA F1).
    if (dryRun === true) {
      // --dry-run never writes state
    } else if (abortRequested) {
      // SIGINT graceful stop (02): finish the page in flight (already done),
      // write an ABORTED checkpoint (completed windows only — watermarks and
      // the final checkpoint are NOT advanced, so a rerun resumes and
      // finalises). The abort itself is not an error: no throw.
      await writeCheckpoint(true);
    } else {
      if (counters.pages > 0) {
        await store.rebuildIndex(); // 02 data flow: ingest → index rebuild at end of run
      }
      // backfill hands over to incremental polling at the backfill horizon;
      // incremental advances its own watermark — both advance only after the
      // index rebuild succeeded (audit appends after the state is durable).
      observationWatermark = advanceWatermark(now, settings.incrementalOverlapHours);
      scoreWatermark = advanceWatermark(now, settings.incrementalOverlapHours);
      await writeCheckpoint();
      if (counters.pages > 0) {
        await store.appendAudit({
          at: clock(),
          actor: 'system',
          type: 'ingest.complete',
          projectId,
          payload: {
            mode,
            windows: windowsWalked,
            pages: counters.pages,
            newRows: counters.newRows,
            dupes: counters.dupes,
            ...(runFrom !== undefined ? { from: runFrom } : {}),
            to: now,
          },
        });
      }
    }
    return {
      windows: windowsWalked,
      pages: counters.pages,
      newRows: counters.newRows,
      dupes: counters.dupes,
      ...(runFrom !== undefined ? { from: runFrom } : {}),
      to: now,
      ...(abortRequested ? { aborted: true } : {}),
    };
  } catch (e) {
    if (dryRun !== true) {
      try {
        await writeCheckpoint(true); // safe checkpoint: completed work only
      } catch {
        // the store may itself be failing; nothing safe left to do
      }
    }
    throw fail(e);
  }
}
