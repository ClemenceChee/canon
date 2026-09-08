import type { Command } from '../main.js';
import { CanonError } from '../../core/errors.js';
import type { IngestOptions } from '../../app.js';

/**
 * canon ingest — real since slice 3: windowed backfill / incremental poll via
 * the sync engine against the configured Langfuse source (DEC-11 origin rule
 * enforced when the source is built from config).
 *
 * SIGINT (02 failure table / 04 Slice 7): while the run is in flight the CLI
 * marks the shared interrupt state as syncing; Ctrl-C then requests a
 * graceful abort instead of killing the process. The engine finishes the page
 * in flight, writes an aborted checkpoint and returns IngestReport.aborted —
 * this command reports the partial counts and exits 130; a rerun resumes.
 */
function numArg(v: unknown, label: string): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new CanonError(`--${label} must be a positive number`, { code: 'usage' });
  }
  return n;
}

const ingest: Command = async (ctx) => {
  const a = ctx.args;
  const mode: 'backfill' | 'incremental' | undefined =
    a.backfill === true ? 'backfill' : a.incremental === true ? 'incremental' : undefined;
  const opts: IngestOptions = {
    ...(mode !== undefined ? { mode } : {}),
    from: typeof a.from === 'string' ? a.from : undefined,
    to: typeof a.to === 'string' ? a.to : undefined,
    windowDays: numArg(a.windowDays, 'window-days'),
    smallPages: a.smallPages === true,
    dryRun: a.dryRun === true,
    insecureHttp: a.insecureHttp === true,
    abort: () => ctx.interrupt.requested,
  };
  const interrupt = ctx.interrupt;
  interrupt.syncing = true;
  let report;
  try {
    report = await ctx.app.ingest(opts);
  } finally {
    interrupt.syncing = false;
  }
  if (report.aborted === true) {
    console.log('ingest aborted (interrupted) — checkpointed; rerun resumes');
    console.log(`project ${report.projectId}`);
    console.log(`windows ${report.windows}`);
    console.log(`pages ${report.pages}`);
    console.log(`new rows ${report.newRows}`);
    console.log(`dupes ${report.dupes}`);
    return 130; // 02 exit codes: 130 interrupted
  }
  console.log(`ingest complete (${report.mode})`);
  console.log(`project ${report.projectId}`);
  console.log(`windows ${report.windows}`);
  console.log(`pages ${report.pages}`);
  console.log(`new rows ${report.newRows}`);
  console.log(`dupes ${report.dupes}`);
  console.log(`duration ${report.durationMs}ms`);
  return 0;
};

export default ingest;
