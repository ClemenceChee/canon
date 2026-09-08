/**
 * CanonApp — the library entry the CLI wraps (03 app.ts contract). Wires a
 * store (file-based .canon/) + an optional injected TraceSource + clock/
 * redactor, and exposes app-level operations. Slices implemented: connect
 * (probe + merge on reconnect), ingest (real sync engine, slice 3), analyze
 * (real trees/decisions/profiles/divergence + index outcome backfill, slice 4),
 * proposals/governance (slice 5), and export/audit export/metrics + status
 * (slice 6: guard-rules pack with --verify-links, compliance audit report,
 * TTRP + precision14 reading points).
 */

import { resolve } from 'node:path';
import { CanonError, fail } from './core/errors.js';
import { CANON_VERSION, DEFAULT_HTTP_CONFIG, WINDOW_CHUNK_DAYS_DEFAULT } from './core/constants.js';
import { newId } from './core/id.js';
import { parseIso, nowIso } from './core/time.js';
import type { Clock, IsoTime } from './core/time.js';
import { createRedactor } from './core/redact.js';
import type { Redactor } from './core/redact.js';
import type { TraceSource } from './trace/traceSource.js';
import { createLangfuseSource } from './trace/langfuse/client.js';
import { CONFIG_SCHEMA, createCanonStore, defaultSettings } from './store/index.js';
import type { CanonConfig, CanonConfigSettings, CanonStore, StoreStatus } from './store/index.js';
import type { Proposal, ProposalStatus, RuleKind } from './store/proposals.js';
import { RULE_KINDS } from './store/proposals.js';
import { runSync } from './ingest/sync.js';
import type { SyncMode } from './ingest/sync.js';
import { rebuildTrees } from './analyze/tree.js';
import type { TreeReport } from './analyze/tree.js';
import { extractDecisions } from './analyze/decisions.js';
import { buildProfiles } from './analyze/profiles.js';
import { divergenceGroups } from './analyze/divergence.js';
import { buildCandidates } from './propose/candidates.js';
import { DEFAULT_SCORING_CONSTANTS } from './propose/scoring.constants.js';
import { decaySweep, effectiveActor, promote as gatePromote, reject as gateReject } from './governance/gate.js';
import type { PromoteOptions, PromoteResult, RejectOptions } from './governance/gate.js';
import { effectivePolicies } from './store/policies.js';
import type { Policy } from './store/policies.js';
import { buildGuardRulesPack, verifyEvidenceLinks } from './export/guardRules.js';
import { findDanglingEvidenceTraceIds } from './export/evidence.js';
import type { GuardRulesPack } from './export/guardRules.js';
import { buildAuditDigest, auditReportMarkdown } from './export/auditReport.js';
import type { AuditDigest } from './export/auditReport.js';
import { buildGovernanceExport, divergenceByModelTask } from './export/dashboard.js';
import type { GovernanceExport } from './export/dashboard.js';
import { computeMetrics } from './metrics/metrics.js';
import type { MetricsResult } from './metrics/metrics.js';
import { atomicWriteFile } from './store/atomics.js';

export interface CanonOptions {
  dir?: string;
  source?: TraceSource;
  clock?: Clock;
  redactor?: Redactor;
  configOverrides?: Partial<CanonConfigSettings>;
}

export interface ConnectOptions {
  host: string;
  projectId: string;
  publicKey: string;
  secretKey: string;
  environment?: string[];
  redactIngest?: boolean;
  force?: boolean;
  /** DEC-22: switching to a DIFFERENT project requires --wipe (clears the previous project's archive/index/sync-state plus its pending proposals and ratified canon policies — ADR-0004 DEC-22 supersedes ADR-0003 DEC-15's kept-wording). */
  wipe?: boolean;
  /** DEC-11 escape hatch: allow plain http to a non-loopback origin (02 transport prose). */
  insecureHttp?: boolean;
}

export interface AnalyzeOptions {
  since?: IsoTime;
  environments?: string[];
}

export type { PromoteOptions, PromoteResult, RejectOptions };
export type { Policy };

export interface ListProposalsOptions {
  status?: ProposalStatus | 'all';
  kind?: RuleKind[];
}

/** 03 Reports — app-level return value. */
export interface AnalysisReport {
  projectId: string;
  runId: string;
  trees: number;
  skipped: number;
  facts: number;
  agents: number;
  divergenceGroups: number;
  proposed: number;
  decayed: number;
}

/** 03 ingest options (mode optional: app resolves a fresh-store default). */
export interface IngestOptions {
  mode?: 'backfill' | 'incremental';
  from?: IsoTime;
  to?: IsoTime;
  windowDays?: number;
  smallPages?: boolean;
  dryRun?: boolean;
  /** DEC-11: allow plain http to a non-loopback host stored in config. */
  insecureHttp?: boolean;
  /**
   * SIGINT/graceful-stop seam (02 failure table; 04 Slice 7): when this
   * callback returns true the sync engine finishes the page in flight, writes
   * an aborted checkpoint and returns IngestReport.aborted instead of
   * throwing. The CLI wires this to its SIGINT handler and exits 130.
   */
  abort?: () => boolean;
}

/** 03 IngestReport; `aborted` is true for graceful SIGINT stops (02), never a throw. */
export interface IngestReport {
  projectId: string;
  mode: SyncMode;
  windows: number;
  pages: number;
  newRows: number;
  dupes: number;
  from?: IsoTime;
  to?: IsoTime;
  durationMs: number;
  aborted?: boolean;
}

export interface StatusOptions {
  rebuildIndex?: boolean;
}

export interface ExportGuardRulesOptions {
  /** write the pack to this path (otherwise it is returned only). */
  out?: string;
  /** verify every rule's evidence traceIds resolve in the archive (exit 1 on dangling). */
  verifyLinks?: boolean;
}

export interface ExportAuditOptions {
  format: 'json' | 'md';
  out?: string;
}

export interface ExportGovernanceOptions {
  /** write the document to this path (otherwise it is returned only). */
  out?: string;
}

export interface AuditExportResult {
  path?: string;
  digest: AuditDigest;
  /** markdown body (format 'md' without --out prints it to stdout). */
  markdown?: string;
}

export interface CanonApp {
  connect(opts: ConnectOptions): Promise<CanonConfig>;
  ingest(opts?: IngestOptions): Promise<IngestReport>;
  analyze(opts?: AnalyzeOptions): Promise<AnalysisReport>;
  proposals(opts?: ListProposalsOptions): Promise<Proposal[]>;
  showProposal(id: string): Promise<Proposal>;
  promote(id: string, opts: PromoteOptions): Promise<PromoteResult>;
  reject(id: string, opts: RejectOptions): Promise<Proposal>;
  showCanon(): Promise<Policy[]>;
  exportGuardRules(opts?: ExportGuardRulesOptions): Promise<{ pack: GuardRulesPack; path?: string }>;
  exportAudit(opts: ExportAuditOptions): Promise<AuditExportResult>;
  /** canon → dashboard governance export (`canon export --format json`). */
  exportGovernance(opts?: ExportGovernanceOptions): Promise<{ document: GovernanceExport; path?: string }>;
  metrics(): Promise<MetricsResult>;
  status(opts?: StatusOptions): Promise<StoreStatus>;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/**
 * Origin rule (02 transport / ADR DEC-11): plain http is only allowed for
 * loopback hosts unless the operator explicitly opts into --insecure-http.
 * Applied at connect time (CLI usage error → exit 2) and — via
 * assertBaseUrlAllowed — whenever a source is rebuilt FROM CONFIG (validation
 * → exit 1), so hand-edited config cannot send keys over plain http to a
 * non-loopback host. Redirects fail closed inside the http layer itself.
 */
export function assertBaseUrlAllowed(
  baseUrl: string,
  opts?: { insecureHttp?: boolean },
): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CanonError(`stored baseUrl is not a valid URL: ${JSON.stringify(baseUrl)}`, {
      code: 'validation',
      hint: 're-run canon connect',
    });
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname) && opts?.insecureHttp !== true) {
    throw new CanonError('plain http is refused for non-loopback hosts (secrets in clear)', {
      code: 'validation',
      hint: 're-run canon connect with --insecure-http, or use an https baseUrl',
    });
  }
}

/**
 * Host must be an origin; plain http refused unless the target is loopback
 * or --insecure-http is passed (02 transport prose / ADR DEC-11).
 */
function normalizeOriginHost(host: string, insecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new CanonError(`--host must be an origin URL (got ${JSON.stringify(host)})`, {
      code: 'usage',
      hint: 'example: https://cloud.langfuse.com',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CanonError(`--host protocol must be http(s) (got ${url.protocol})`, {
      code: 'usage',
    });
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname) && !insecureHttp) {
    throw new CanonError('plain http is refused for non-loopback hosts (secrets in clear)', {
      code: 'usage',
      hint: 'use https, --insecure-http for trusted local networks, or a loopback host',
    });
  }
  return host.replace(/\/+$/, '');
}

function nonEmpty(v: string | undefined, label: string): string {
  if (v === undefined || v.trim().length === 0) {
    throw new CanonError(`missing required ${label}`, { code: 'usage' });
  }
  return v.trim();
}

export function createCanon(opts?: CanonOptions): CanonApp {
  const dir = resolve(opts?.dir ?? '.canon');
  const clock: Clock = opts?.clock ?? nowIso;
  const source: TraceSource | undefined = opts?.source;
  // opts.redactor (03 CanonOptions): caller-supplied redactor used for the
  // ingest-time scrub when settings.redact.ingest is on (ADR-0001 DEC-4 —
  // see ingestImpl). View/export surfaces carry structure/ids only, so they
  // have no content to scrub; --redact.views stays the default-on contract.
  const injectedRedactor: Redactor | undefined = opts?.redactor;
  const configOverrides: Partial<CanonConfigSettings> | undefined = opts?.configOverrides;

  const store: CanonStore = createCanonStore(dir);

  function applyOverrides(base: CanonConfigSettings): CanonConfigSettings {
    if (configOverrides === undefined) return base;
    return {
      ...base,
      environment:
        configOverrides.environment !== undefined
          ? [...configOverrides.environment]
          : base.environment,
      redact: {
        ingest: configOverrides.redact?.ingest ?? base.redact.ingest,
        views: configOverrides.redact?.views ?? base.redact.views,
      },
      operator: { name: configOverrides.operator?.name ?? base.operator.name },
      sync: { ...base.sync, ...configOverrides.sync },
      http: { ...base.http, ...configOverrides.http },
      decay: { ...base.decay, ...configOverrides.decay },
      analysis: { ...base.analysis, ...configOverrides.analysis },
    };
  }

  async function probeProject(opts: ConnectOptions): Promise<void> {
    // slice 1: probe only with an injected source; slice 2 wires the default
    // Langfuse-v4 source so CLI connect validates over real HTTP (GET projects).
    const active: TraceSource | undefined =
      source ?? createLangfuseSource({
        baseUrl: `${opts.host}/api/public`,
        publicKey: opts.publicKey,
        secretKey: opts.secretKey,
        http: DEFAULT_HTTP_CONFIG,
        clock,
      });
    let projects;
    try {
      projects = await active.listProjects();
    } catch (e) {
      fail(e); // rethrows; non-CanonError becomes CanonError('internal')
    }
    if (!projects.some((p) => p.id === opts.projectId)) {
      throw new CanonError(
        `project ${JSON.stringify(opts.projectId)} not found on ${opts.host}`,
        {
          code: 'not-found',
          hint: 'check --project; it must be visible to these keys',
        },
      );
    }
  }

  async function connectImpl(opts: ConnectOptions): Promise<CanonConfig> {
    const host = normalizeOriginHost(nonEmpty(opts.host, 'host'), opts.insecureHttp === true);
    const projectId = nonEmpty(opts.projectId, 'project id');
    const publicKey = nonEmpty(opts.publicKey, 'public key (--public-key or CANON_LANGFUSE_PUBLIC_KEY)');
    const secretKey = nonEmpty(opts.secretKey, 'secret key (--secret-key or CANON_LANGFUSE_SECRET_KEY)');
    const baseUrl = `${host}/api/public`;

    await store.open();
    const existing = await store.readConfig();
    const switchingProject =
      existing !== undefined && existing.connection.projectId !== projectId;
    if (switchingProject && !opts.force) {
      throw new CanonError(
        `store at ${dir} is already connected to project ${existing.connection.projectId}`,
        {
          code: 'invalid-state',
          hint: 'pass --force --wipe to switch the store to another project (clears archive/index/sync-state, proposals and canon)',
        },
      );
    }
    // ADR-0003 DEC-15: a project switch is destructive by nature (archive,
    // index and sync-state describe the previous project) — it must be
    // explicit. --force alone is refused; --force --wipe clears the previous
    // project's local derived data before connecting. Without this, archive
    // reads would silently mix two projects' rows (review S2).
    if (switchingProject && opts.force && opts.wipe !== true) {
      throw new CanonError(
        `switching from project ${existing.connection.projectId} to ${projectId} requires --wipe`,
        {
          code: 'validation',
          hint: 'pass --wipe to clear the previous project\'s archive, index, sync-state, pending proposals and ratified canon before connecting',
        },
      );
    }

    await probeProject({ ...opts, host, publicKey, secretKey });

    const connectedAt = clock();
    // DEC-10: re-running connect on an already-connected store MERGES. A
    // same-project reconnect (the documented key-rotation path) keeps every
    // hand-tuned setting group (environment/sync/http/decay/analysis/operator/
    // redact) as the base and only applies the options given on this
    // invocation. A --force switch to a *different* project deliberately
    // starts from [PROPOSED] defaults: the tuned settings described the
    // previous project.
    const sameProject = existing !== undefined && existing.connection.projectId === projectId;
    const base = applyOverrides(sameProject ? existing!.settings : defaultSettings());
    const settings: CanonConfigSettings = {
      ...base,
      environment:
        opts.environment !== undefined && opts.environment.length > 0
          ? [...opts.environment]
          : base.environment,
      redact: {
        ingest: opts.redactIngest ?? base.redact.ingest,
        views: base.redact.views,
      },
    };
    const cfg: CanonConfig = {
      schema: CONFIG_SCHEMA,
      connection: {
        host,
        baseUrl,
        projectId,
        publicKey,
        secretKey,
        connectedAt,
      },
      settings,
    };

    await store.withLock(async () => {
      if (switchingProject && opts.wipe === true) {
        // clear the previous project's local derived data BEFORE the config
        // that re-points the store at the new project is written
        await store.wipeProjectData();
      }
      await store.writeConfig(cfg); // state durable first
      await store.appendAudit({
        at: connectedAt,
        actor: 'system',
        type: 'connect',
        projectId,
        payload: {},
      }); // audit after the state it records
    });
    return cfg;
  }

  /**
   * Build the Langfuse source FROM STORED CONFIG (review seam 3: connect-probe
   * and ingest share identical URL/auth resolution). ADR DEC-11: the origin
   * rule is enforced here too — plain http only for loopback hosts unless
   * --insecure-http — so a hand-edited config cannot send keys over plain http
   * to a non-loopback host. Redirects fail closed inside the http layer.
   */
  function sourceFromConfig(
    cfg: CanonConfig,
    sourceOpts?: { insecureHttp?: boolean; clock?: Clock },
  ): TraceSource {
    assertBaseUrlAllowed(cfg.connection.baseUrl, sourceOpts);
    return createLangfuseSource({
      baseUrl: cfg.connection.baseUrl,
      publicKey: cfg.connection.publicKey,
      secretKey: cfg.connection.secretKey,
      http: cfg.settings.http,
      clock: sourceOpts?.clock ?? clock,
    });
  }

  async function ingestImpl(opts: IngestOptions = {}): Promise<IngestReport> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    // injected source wins (tests/future sources); otherwise build the default
    // Langfuse adapter FROM CONFIG under the DEC-11 origin rule
    const sourceActive: TraceSource =
      source ??
      sourceFromConfig(cfg, { insecureHttp: opts.insecureHttp === true });
    const startedAt = clock();
    let mode = opts.mode;
    if (mode === undefined) {
      // a store with no sync history backfills; otherwise plain `canon ingest`
      // is an incremental poll
      const st = await store.readSyncState();
      const fresh =
        st === undefined ||
        (st.completedWindows.length === 0 &&
          st.observationWatermark === null &&
          st.scoreWatermark === null &&
          st.lastRun === undefined);
      mode = fresh ? 'backfill' : 'incremental';
    }
    // ADR-0001 DEC-4 ingest-time redaction: settings.redact.ingest gates the
    // scrub at archive write (default false — rows stay verbatim). A caller-
    // supplied redactor (03 CanonOptions.redactor) supplies the redactor when
    // present; otherwise an enabled default-prefix redactor is created. The
    // gate is the SETTING: redact.ingest off never scrubs, even with an
    // injected redactor.
    const redactor: Redactor | undefined =
      cfg.settings.redact.ingest === true
        ? injectedRedactor ?? createRedactor({ enabled: true })
        : undefined;
    const report = await store.withLock(async () =>
      runSync({
        store,
        source: sourceActive,
        clock,
        projectId: cfg.connection.projectId,
        environment: cfg.settings.environment,
        settings: cfg.settings.sync,
        mode,
        windowDays: opts.windowDays ?? WINDOW_CHUNK_DAYS_DEFAULT,
        from: opts.from,
        to: opts.to,
        smallPages: opts.smallPages === true,
        dryRun: opts.dryRun === true,
        ...(redactor !== undefined ? { redact: redactor } : {}),
        ...(opts.abort !== undefined ? { abort: opts.abort } : {}),
      }),
    );
    const finishedAt = clock();
    return {
      projectId: cfg.connection.projectId,
      mode,
      windows: report.windows,
      pages: report.pages,
      newRows: report.newRows,
      dupes: report.dupes,
      ...(report.from !== undefined ? { from: report.from } : {}),
      to: report.to,
      durationMs: parseIso(finishedAt) - parseIso(startedAt),
      ...(report.aborted === true ? { aborted: true } : {}),
    };
  }

  async function statusImpl(opts?: StatusOptions): Promise<StoreStatus> {
    await store.open();
    if (opts?.rebuildIndex === true) {
      await store.rebuildIndex(); // self-heal derived index (02)
    }
    return store.status();
  }

  async function analyzeImpl(opts?: AnalyzeOptions): Promise<AnalysisReport> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    const runId = newId('run');
    const at = clock();

    // ---- slice 4: trees / decisions / profiles / divergence over the archive ----
    // archive rows are read through the store facade (DEC-15 project guard
    // applies); corrupted envelope lines fold into the tree skipped list as
    // 'unparseable' (review seam 5).
    const archive = await store.readArchiveRows();
    const rows = archive.observations.map((l) => l.envelope.row);
    const scores = archive.scores.map((l) => l.envelope.row);
    const report: TreeReport = rebuildTrees(rows, scores);
    for (const _line of archive.corrupted) {
      // corrupted envelope lines never surface as rows — folded into the
      // tree skipped list as 'unparseable' (review seam 5)
      report.skipped.push({ reason: 'unparseable' });
    }

    let trees = report.trees;
    if (opts?.since !== undefined) {
      trees = trees.filter((t) => t.startTime !== undefined && t.startTime >= opts.since!);
    }
    if (opts?.environments !== undefined && opts.environments.length > 0) {
      const wanted = new Set(opts.environments);
      trees = trees.filter((t) => t.environment !== undefined && wanted.has(t.environment));
    }

    const facts = trees.flatMap((t) => extractDecisions(t));
    const agents = buildProfiles(trees);
    const groups = divergenceGroups(trees);
    // app-level filter (03): groups below settings.analysis.minTraces never
    // reach the propose stage (kept in the report; emission uses the filtered
    // view)
    const minTraces = cfg.settings.analysis.minTraces;
    const proposalGroups = groups.filter((g) => g.trees.length >= minTraces);

    let proposed = 0;
    let decayed = 0;
    let dropped = 0;
    await store.withLock(async () => {
      // 03 [DEC-15]: the decay sweep runs at the start of analyze under lock
      decayed = (
        await decaySweep(store, at, { proposalTtlDays: cfg.settings.decay.proposalTtlDays })
      ).length;
      const existing = await store.listProposals('pending');
      const policies = await store.listPolicies();
      const { proposals, dropped: droppedCount } = buildCandidates(
        facts,
        proposalGroups,
        existing,
        policies,
        DEFAULT_SCORING_CONSTANTS,
        { runId, analyzerVersion: CANON_VERSION, at },
        // DEC-20: the per-run circuit breaker cap is the live config knob —
        // lowering settings.analysis.maxProposalsPerRun truncates this run's
        // output below the corpus total (03: dropped candidates counted into
        // the audit payload)
        cfg.settings.analysis.maxProposalsPerRun,
      );
      dropped = droppedCount;
      for (const p of proposals) {
        await store.saveProposal(p); // state durable first
        proposed += 1;
        await store.appendAudit({
          at,
          actor: 'system',
          type: 'proposal.created',
          projectId: cfg.connection.projectId,
          payload: { proposalId: p.id, ruleKey: p.ruleKey, kind: p.kind, runId },
        });
      }
      // DEC-16: infer outcomes and back-fill them into the index (patched in
      // place — never via rebuildIndex, which would clobber them)
      const outcomes = new Map<string, 'success' | 'failure' | 'unknown'>(
        trees.map((t) => [t.traceId, t.outcome]),
      );
      await store.backfillTraceOutcomes(outcomes);
      await store.appendAudit({
        at,
        actor: 'system',
        type: 'analysis.run',
        projectId: cfg.connection.projectId,
        payload: {
          runId,
          trees: trees.length,
          skipped: report.skipped.length,
          facts: facts.length,
          agents: agents.length,
          divergenceGroups: groups.length,
          proposed,
          decayed,
          ...(dropped > 0 ? { dropped } : {}),
        },
      });
    });
    return {
      projectId: cfg.connection.projectId,
      runId,
      trees: trees.length,
      skipped: report.skipped.length,
      facts: facts.length,
      agents: agents.length,
      divergenceGroups: groups.length,
      proposed,
      decayed,
    };
  }

  async function proposalsImpl(opts?: ListProposalsOptions): Promise<Proposal[]> {
    const status = opts?.status ?? 'pending';
    if (status !== 'all' && !['pending', 'ratified', 'rejected', 'decayed'].includes(status)) {
      throw new CanonError(`unknown proposal status ${JSON.stringify(status)}`, {
        code: 'usage',
        hint: 'valid statuses: pending | ratified | rejected | decayed | all',
      });
    }
    if (opts?.kind !== undefined) {
      for (const k of opts.kind) {
        if (!(RULE_KINDS as readonly string[]).includes(k)) {
          throw new CanonError(`unknown rule kind ${JSON.stringify(k)}`, {
            code: 'usage',
            hint: `valid kinds: ${RULE_KINDS.join(' | ')}`,
          });
        }
      }
    }
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    // 03 [DEC-15]: the decay sweep runs at the start of proposals list
    await store.withLock(async () => {
      await decaySweep(store, clock(), { proposalTtlDays: cfg.settings.decay.proposalTtlDays });
    });
    const all = await store.listProposals(status);
    if (opts?.kind === undefined || opts.kind.length === 0) return all;
    const kinds = new Set(opts.kind);
    return all.filter((p) => kinds.has(p.kind));
  }

  async function showProposalImpl(id: string): Promise<Proposal> {
    await store.open();
    const p = await store.loadProposal(id);
    if (p === undefined) {
      throw new CanonError(`no proposal ${id}`, {
        code: 'not-found',
        hint: 'list proposals with: canon proposals list --status all',
      });
    }
    return p;
  }

  async function promoteImpl(id: string, opts: PromoteOptions): Promise<PromoteResult> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    // SHOULD-2: the effective reviewer resolves --as (opts.actor) >
    // CANON_OPERATOR env > settings.operator.name (config default reviewer
    // handle); all empty → usage error (never anonymous, exit 2). Resolving
    // here (not in the CLI) keeps one source of truth and lets the config
    // handle actually attribute.
    const actor = effectiveActor(opts.actor, cfg.settings.operator.name);
    // DEC-23 (review S4): the proposal SNAPSHOT LOAD and status validation
    // happen inside withLock. Loading before the lock opened a cross-process
    // TOCTOU: two processes could both load 'pending', then — after the
    // first ratified and released — the second would ratify the same id into
    // a second policy version. Loading under the lock means the second
    // process reads the ratified status and fails cleanly.
    return store.withLock(async () => {
      const fresh = await store.loadProposal(id);
      if (fresh === undefined) {
        throw new CanonError(`no proposal ${id}`, {
          code: 'not-found',
          hint: 'list proposals with: canon proposals list --status all',
        });
      }
      // CAN-103: before ratifying, every evidence traceId must still resolve in
      // the archive (same shared check as `canon export --verify-links`). A
      // purged/restored store must not produce a canon rule with dangling
      // provenance; the override (`--force`) is deliberate and audited.
      const dangling = await findDanglingEvidenceTraceIds(fresh.evidence, store);
      if (dangling.length > 0 && opts.force !== true) {
        throw new CanonError(
          `proposal ${id} has ${dangling.length} dangling evidence link(s): ${dangling.join(', ')}`,
          {
            code: 'validation',
            hint: 're-ingest the traces, or ratify anyway with --force (the override is written to the audit trail)',
          },
        );
      }
      if (dangling.length > 0) {
        await store.appendAudit({
          at: clock(),
          actor,
          type: 'governance.promote-override',
          projectId: cfg.connection.projectId,
          payload: { proposalId: id, dangling: dangling.length },
        });
      }
      return gatePromote(fresh, { ...opts, actor }, store, { at: clock(), allowEditedRuleText: true });
    });
  }

  async function rejectImpl(id: string, opts: RejectOptions): Promise<Proposal> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    const actor = effectiveActor(opts.actor, cfg.settings.operator.name);
    // DEC-23 (review S4): same lock discipline as promote — the snapshot
    // load + status validation run under withLock so two processes cannot
    // both reject/ratify one id from a stale 'pending' read.
    const result = await store.withLock(async () => {
      const fresh = await store.loadProposal(id);
      if (fresh === undefined) {
        throw new CanonError(`no proposal ${id}`, {
          code: 'not-found',
          hint: 'list proposals with: canon proposals list --status all',
        });
      }
      return gateReject(fresh, { actor, reason: opts.reason }, store, { at: clock() });
    });
    return (await store.loadProposal(result.proposalId))!;
  }

  async function showCanonImpl(): Promise<Policy[]> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    const policies = await store.listPolicies();
    return effectivePolicies(policies); // the effective canon = latest version
  }

  // ---- slice 6: export / audit export / metrics (03 app surface) ----

  async function exportGuardRulesImpl(opts?: ExportGuardRulesOptions): Promise<{
    pack: GuardRulesPack;
    path?: string;
  }> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    // effective canon (latest version per ruleKey) + the index-derived agent
    // lookup for scope.agents (evidence trace summaries — review slice-6 note)
    const policies = await store.listPolicies();
    const effective = effectivePolicies(policies);
    const index = await store.readIndex();
    const traceAgents = new Map<string, string | undefined>();
    for (const [traceId, summary] of Object.entries(index.traces)) {
      traceAgents.set(traceId, summary.agentId);
    }
    const pack = buildGuardRulesPack(
      effective,
      {
        projectId: cfg.connection.projectId,
        exportedAt: clock(),
        canonVersion: 1, // canon policy-store generation (v1)
        source: { tool: 'canon', version: CANON_VERSION },
      },
      { traceAgents },
    );
    if (opts?.verifyLinks === true) {
      const dangling = await verifyEvidenceLinks(pack, store);
      if (dangling.length > 0) {
        throw new CanonError(
          `guard-rule export failed evidence-link verification: ` +
            dangling.map((d) => `${d.ruleId} (${d.dangling} dangling)`).join(', '),
          {
            code: 'validation',
            hint: 'evidence traces no longer resolve in the archive — re-ingest or remove the policy',
          },
        );
      }
    }
    let path: string | undefined;
    if (opts?.out !== undefined) {
      await atomicWriteFile(opts.out, `${JSON.stringify(pack, null, 2)}\n`, 0o600);
      path = opts.out;
    }
    // export.run audit line (ids/counts only, DEC-11) after a successful export
    await store.appendAudit({
      at: clock(),
      actor: 'system',
      type: 'export.run',
      projectId: cfg.connection.projectId,
      payload: { format: 'guardrules-json', rules: pack.rules.length },
    });
    return { pack, ...(path !== undefined ? { path } : {}) };
  }

  async function exportAuditImpl(opts: ExportAuditOptions): Promise<AuditExportResult> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    // the audit export is a compliance read: only the CURRENT project's
    // events (the append-only log retains pre-wipe history; 03 folds ids/
    // counts/times only — notes never appear)
    const events = (await store.readAudit()).filter(
      (e) => e.projectId === cfg.connection.projectId,
    );
    const policies = await store.listPolicies();
    const digest = buildAuditDigest(events, policies, {
      projectId: cfg.connection.projectId,
      generatedAt: clock(),
    });
    const markdown = auditReportMarkdown(digest, events, policies);
    let path: string | undefined;
    if (opts.out !== undefined) {
      const body = opts.format === 'json' ? `${JSON.stringify(digest, null, 2)}\n` : markdown;
      await atomicWriteFile(opts.out, body, 0o600);
      path = opts.out;
    }
    return { ...(path !== undefined ? { path } : {}), digest, markdown };
  }

  async function metricsImpl(): Promise<MetricsResult> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    // CAN-102: run the decay sweep first (mirroring the proposals-list and
    // analyze boundaries) so queue counts in metrics are consistent with a
    // swept store — a proposal past its TTL must not be reported as pending
    // merely because the operator asked for metrics instead of the queue.
    await store.withLock(async () => {
      await decaySweep(store, clock(), { proposalTtlDays: cfg.settings.decay.proposalTtlDays });
    });
    // 02 reading points: connect + governance events from the audit, proposal
    // state for the queue counts. Wipe keeps pre-switch events as history, so
    // metrics read only the CURRENT project's events.
    const events = (await store.readAudit()).filter(
      (e) => e.projectId === cfg.connection.projectId,
    );
    const proposals = await store.listProposals('all');
    return computeMetrics(events, proposals, clock());
  }

  async function exportGovernanceImpl(opts?: ExportGovernanceOptions): Promise<{
    document: GovernanceExport;
    path?: string;
  }> {
    await store.open();
    const cfg = await store.readConfig();
    if (cfg === undefined) {
      throw new CanonError('not connected — run canon connect first', {
        code: 'not-connected',
      });
    }
    // CAN-102: decay sweep first (mirroring metrics) so queue counts are
    // consistent with a swept store.
    await store.withLock(async () => {
      await decaySweep(store, clock(), { proposalTtlDays: cfg.settings.decay.proposalTtlDays });
    });
    const events = (await store.readAudit()).filter(
      (e) => e.projectId === cfg.connection.projectId,
    );
    const proposals = await store.listProposals('all');
    const metrics = computeMetrics(events, proposals, clock());
    const policies = effectivePolicies(await store.listPolicies());
    // divergence is rebuilt from the archive (read-only; deterministic) — same
    // geometry analyze derives trees from.
    const archive = await store.readArchiveRows();
    const report = rebuildTrees(
      archive.observations.map((l) => l.envelope.row),
      archive.scores.map((l) => l.envelope.row),
    );
    const divergence = divergenceByModelTask(report.trees);

    const exportedAt = clock();
    const document = buildGovernanceExport({
      projectId: cfg.connection.projectId,
      exportedAt,
      metrics,
      policies,
      divergence,
    });
    let path: string | undefined;
    if (opts?.out !== undefined) {
      await atomicWriteFile(opts.out, `${JSON.stringify(document, null, 2)}\n`, 0o600);
      path = opts.out;
    }
    // export.run audit line (ids/counts only, DEC-11) after a successful export
    await store.appendAudit({
      at: clock(),
      actor: 'system',
      type: 'export.run',
      projectId: cfg.connection.projectId,
      payload: { format: 'dashboard-json', policies: document.policies.length },
    });
    return { document, ...(path !== undefined ? { path } : {}) };
  }

  return {
    connect: connectImpl,
    ingest: ingestImpl,
    analyze: analyzeImpl,
    proposals: proposalsImpl,
    showProposal: showProposalImpl,
    promote: promoteImpl,
    reject: rejectImpl,
    showCanon: showCanonImpl,
    exportGuardRules: exportGuardRulesImpl,
    exportAudit: exportAuditImpl,
    exportGovernance: exportGovernanceImpl,
    metrics: metricsImpl,
    status: statusImpl,
  };
}
