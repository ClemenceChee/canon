/**
 * CanonStore facade — the sole public face of the file store (02 component
 * table: "store | .canon/ file store | .canon/**"). Methods implemented so far
 * cover slices 1-3 (config, lock, audit, proposals, archive envelopes, index,
 * sync-state, status); policies land with slice 5 — the interface grows per
 * slice toward the full 03 contract.
 *
 * Conventions honoured here: config.json 0600 / dirs 0700; state files via
 * atomic tmp+rename; mutating methods run under withLock; audit appends after
 * the state file they record is durable; archive appends happen before the
 * checkpoint that acknowledges them.
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CanonError } from '../core/errors.js';
import { DEFAULT_SETTINGS, PERMS, STORE_FILES } from '../core/constants.js';
import type { IsoTime } from '../core/time.js';
import { nowIso } from '../core/time.js';
import type { Clock } from '../core/time.js';
import { asOptionalString } from '../core/validators.js';
import type { LfObservationRow, LfScoreRow } from '../trace/types.js';
import type { AuditEvent, AuditEventDraft } from './audit.js';
import { appendAuditEvent, readAuditLog } from './audit.js';
import { atomicWriteJson, chmodPath, mkdirp } from './atomics.js';
import { acquireLock, cleanupStaleLock, pidAlive, readLockContent } from './lock.js';
import type { LockHandle } from './lock.js';
import {
  listProposalIds,
  loadProposal,
  proposalsDir,
  saveProposal,
} from './proposals.js';
import type { Proposal, ProposalStatus } from './proposals.js';
import { listPolicies, writePolicyFile } from './policies.js';
import type { Policy } from './policies.js';
import type { SyncState } from '../ingest/sync.js';
import {
  INDEX_SCHEMA,
  appendUniqueRows,
  archiveObsPath,
  archiveScoresPath,
  archivedRowIds,
  buildIndexData,
  indexPath,
  readArchiveFile,
} from './archive.js';
import type { Envelope, IndexData, Outcome } from './archive.js';

export const CONFIG_SCHEMA = 'canon/config/v1';

export interface CanonConfigConnection {
  host: string;
  baseUrl: string;
  projectId: string;
  publicKey: string;
  secretKey: string;
  connectedAt: IsoTime;
}

export interface CanonConfigSettings {
  environment: string[];
  redact: { ingest: boolean; views: boolean };
  operator: { name?: string };
  sync: {
    incrementalOverlapHours: number;
    backfillWindowDays: number;
    politeDelayMs: number;
  };
  http: { requestTimeoutMs: number; maxRetries: number; retryBaseMs: number };
  decay: { proposalTtlDays: number };
  analysis: { minTraces: number; maxProposalsPerRun: number };
}

export interface CanonConfig {
  schema: 'canon/config/v1';
  connection: CanonConfigConnection;
  settings: CanonConfigSettings;
}

/** [PROPOSED] default settings — veto in core/constants.ts (single home). */
export function defaultSettings(): CanonConfigSettings {
  const d = DEFAULT_SETTINGS;
  return {
    environment: [...d.environment],
    redact: { ingest: d.redact.ingest, views: d.redact.views },
    operator: { name: d.operator.name },
    sync: { ...d.sync },
    http: { ...d.http },
    decay: { ...d.decay },
    analysis: { ...d.analysis },
  };
}

/** Strict readers for OUR OWN config file (written atomically; malformed = corrupt). */
function corrupt(msg: string): CanonError {
  return new CanonError(msg, { code: 'store-corrupt' });
}
function cfgObject(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw corrupt(`${label}: expected an object`);
  }
  return v as Record<string, unknown>;
}
function cfgString(v: unknown, label: string): string {
  if (typeof v !== 'string') throw corrupt(`${label}: expected a string`);
  return v;
}
function cfgNumber(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw corrupt(`${label}: expected a finite number`);
  }
  return v;
}
function cfgBoolean(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') throw corrupt(`${label}: expected a boolean`);
  return v;
}
function cfgStringArray(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw corrupt(`${label}: expected an array of strings`);
  }
  return [...v];
}
/** Group that may be absent entirely in older configs → defaults apply. */
function cfgGroup(v: unknown, label: string): Record<string, unknown> {
  if (v === undefined) return {};
  return cfgObject(v, label);
}
function cfgIso(v: unknown, label: string): IsoTime {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) {
    throw corrupt(`${label}: missing or malformed ISO timestamp`);
  }
  return v;
}

/**
 * Tolerant config reader: absent optional groups fall back to the [PROPOSED]
 * defaults so older config files keep loading; a config whose schema or
 * connection block is wrong is store-corrupt (state files are atomic-renamed,
 * so they can never tear by themselves).
 */
export function parseCanonConfig(raw: unknown): CanonConfig {
  const obj = cfgObject(raw, 'config.json');
  if (obj.schema !== CONFIG_SCHEMA) {
    throw corrupt(
      `config.json has schema ${JSON.stringify(obj.schema)}; expected ${CONFIG_SCHEMA}`,
    );
  }
  const conn = cfgObject(obj.connection, 'config.json connection');
  const connection: CanonConfigConnection = {
    host: cfgString(conn.host, 'config.json connection.host'),
    baseUrl: cfgString(conn.baseUrl, 'config.json connection.baseUrl'),
    projectId: cfgString(conn.projectId, 'config.json connection.projectId'),
    publicKey: cfgString(conn.publicKey, 'config.json connection.publicKey'),
    secretKey: cfgString(conn.secretKey, 'config.json connection.secretKey'),
    connectedAt: cfgIso(conn.connectedAt, 'config.json connection.connectedAt'),
  };

  const s = cfgGroup(obj.settings, 'config.json settings');
  const d = DEFAULT_SETTINGS;
  const redact = cfgGroup(s.redact, 'config.json settings.redact');
  const operator = cfgGroup(s.operator, 'config.json settings.operator');
  const sync = cfgGroup(s.sync, 'config.json settings.sync');
  const http = cfgGroup(s.http, 'config.json settings.http');
  const decay = cfgGroup(s.decay, 'config.json settings.decay');
  const analysis = cfgGroup(s.analysis, 'config.json settings.analysis');

  const settings: CanonConfigSettings = {
    environment:
      s.environment === undefined ? [...d.environment] : cfgStringArray(s.environment, 'settings.environment'),
    redact: {
      ingest: redact.ingest === undefined ? d.redact.ingest : cfgBoolean(redact.ingest, 'settings.redact.ingest'),
      views: redact.views === undefined ? d.redact.views : cfgBoolean(redact.views, 'settings.redact.views'),
    },
    operator: { name: asOptionalString(operator.name) },
    sync: {
      incrementalOverlapHours:
        sync.incrementalOverlapHours === undefined
          ? d.sync.incrementalOverlapHours
          : cfgNumber(sync.incrementalOverlapHours, 'settings.sync.incrementalOverlapHours'),
      backfillWindowDays:
        sync.backfillWindowDays === undefined
          ? d.sync.backfillWindowDays
          : cfgNumber(sync.backfillWindowDays, 'settings.sync.backfillWindowDays'),
      politeDelayMs:
        sync.politeDelayMs === undefined
          ? d.sync.politeDelayMs
          : cfgNumber(sync.politeDelayMs, 'settings.sync.politeDelayMs'),
    },
    http: {
      requestTimeoutMs:
        http.requestTimeoutMs === undefined
          ? d.http.requestTimeoutMs
          : cfgNumber(http.requestTimeoutMs, 'settings.http.requestTimeoutMs'),
      maxRetries:
        http.maxRetries === undefined
          ? d.http.maxRetries
          : cfgNumber(http.maxRetries, 'settings.http.maxRetries'),
      retryBaseMs:
        http.retryBaseMs === undefined
          ? d.http.retryBaseMs
          : cfgNumber(http.retryBaseMs, 'settings.http.retryBaseMs'),
    },
    decay: {
      proposalTtlDays:
        decay.proposalTtlDays === undefined
          ? d.decay.proposalTtlDays
          : cfgNumber(decay.proposalTtlDays, 'settings.decay.proposalTtlDays'),
    },
    analysis: {
      minTraces:
        analysis.minTraces === undefined
          ? d.analysis.minTraces
          : cfgNumber(analysis.minTraces, 'settings.analysis.minTraces'),
      maxProposalsPerRun:
        analysis.maxProposalsPerRun === undefined
          ? d.analysis.maxProposalsPerRun
          : cfgNumber(analysis.maxProposalsPerRun, 'settings.analysis.maxProposalsPerRun'),
    },
  };
  return { schema: CONFIG_SCHEMA, connection, settings };
}

export interface StoreStatus {
  dir: string;
  connected: boolean;
  configPermOk: boolean;
  archive: { observations: number; scores: number };
  indexFresh: boolean;
  lastRun?: SyncState['lastRun'];
  lockHeld: boolean;
  proposalsByStatus: Record<ProposalStatus, number>;
  policies: number;
}

export interface CanonStore {
  readonly dir: string;
  open(): Promise<void>; // mkdir -p, perm audit, stale-lock cleanup
  close(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>; // CanonError('locked') on contention
  readConfig(): Promise<CanonConfig | undefined>; // undefined when not connected
  writeConfig(cfg: CanonConfig): Promise<void>; // atomic tmp+rename, chmod 0600
  appendAudit(e: AuditEventDraft): Promise<AuditEvent>; // seq = last + 1, under lock
  readAudit(): Promise<AuditEvent[]>;
  saveProposal(p: Proposal): Promise<void>; // atomic write
  loadProposal(id: string): Promise<Proposal | undefined>;
  listProposals(status?: ProposalStatus | 'all'): Promise<Proposal[]>;
  /** Versioned canon (03 store facade): canon/<ruleKey>.v<N>.json, immutable per version. */
  writePolicy(p: Policy): Promise<void>;
  listPolicies(): Promise<Policy[]>;
  // --- slice 3: archive / index / sync-state / status (03 store facade) ---
  appendObservationRows(rows: Array<Envelope<LfObservationRow>>): Promise<{ appended: number; dupes: number }>;
  appendScoreRows(rows: Array<Envelope<LfScoreRow>>): Promise<{ appended: number; dupes: number }>;
  rebuildIndex(): Promise<IndexData>; // O(rows) scan; atomic write
  readIndex(): Promise<IndexData>; // rebuild+write when missing/corrupt (03 [DEC-09])
  /**
   * DEC-16: back-fill inferred trace outcomes into the persisted index,
   * replacing the ingest-time 'unknown' placeholder. PATCHES the stored
   * index only — it must NOT be routed through rebuildIndex (a geometry
   * rebuild would clobber analyze-owned outcomes, review seam S5).
   */
  backfillTraceOutcomes(outcomes: Map<string, Outcome>): Promise<void>;
  traceLines(traceId: string): Promise<Array<{ line: number; row: LfObservationRow }>>;
  readSyncState(): Promise<SyncState | undefined>;
  writeSyncState(s: SyncState): Promise<void>; // atomic
  /** Distinct archived row ids per kind — dry-run dupe accounting (slice-3 additive read). */
  readStoredRowIds(): Promise<{ observations: Set<string>; scores: Set<string> }>;
  /**
   * All archived observation/score rows (+ corrupted line numbers) in file
   * order — the analyze slice rebuilds trees from these (additive read; the
   * archive JSONL is the raw-evidence tier, consumed via the store facade).
   */
  readArchiveRows(): Promise<ArchiveRows>;
  /** DEC-22 (supersedes DEC-15's kept-wording): clear the previous project's archive/index/sync-state AND its derived governance state (pending proposals, ratified canon) before a --force --wipe connect; audit retained. */
  wipeProjectData(): Promise<void>;
  status(): Promise<StoreStatus>;
}

export interface ArchiveRows {
  observations: Array<{ line: number; envelope: Envelope<LfObservationRow> }>;
  scores: Array<{ line: number; envelope: Envelope<LfScoreRow> }>;
  /** 1-based lines in the observation archive that did not parse as envelopes. */
  corrupted: number[];
  /** 1-based lines in the score archive that did not parse as envelopes. */
  corruptedScores: number[];
}

/**
 * Store clock — injectable for deterministic index builtAt timestamps in
 * tests; defaults to the real clock. 03's store facade has no clock, so this
 * is an additive construction option (test seam), not a signature change.
 */
export interface CanonStoreOptions {
  clock?: Clock;
}

export function createCanonStore(dir: string, opts?: CanonStoreOptions): CanonStore {
  const root = resolve(dir);
  const clock: Clock = opts?.clock ?? nowIso;
  const configPath = join(root, STORE_FILES.config);
  const auditPath = join(root, STORE_FILES.audit);
  const lockPath = join(root, STORE_FILES.lock);
  const obsPath = archiveObsPath(root);
  const scoresPath = archiveScoresPath(root);
  const indexPathFull = indexPath(root);
  const syncStatePath = join(root, STORE_FILES.syncState);
  const canonDirPath = join(root, STORE_FILES.canonDir);
  const archiveDirPath = join(root, STORE_FILES.archiveDir);

  let opened = false;
  let held: LockHandle | undefined;

  async function ensureOpen(): Promise<void> {
    if (!opened) {
      await mkdirp(root, PERMS.dir);
      await mkdirp(proposalsDir(root), PERMS.dir);
      await mkdirp(archiveDirPath, PERMS.dir);
      await cleanupStaleLock(lockPath);
      opened = true;
    }
  }

  async function readConfigInternal(): Promise<CanonConfig | undefined> {
    let raw: string;
    try {
      raw = await readFile(configPath, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw new CanonError(`cannot read ${configPath}: ${String(e)}`, {
        code: 'io',
        cause: e,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new CanonError('config.json is not valid JSON', {
        code: 'store-corrupt',
        hint: 'delete the store dir and re-run canon connect',
        cause: e,
      });
    }
    return parseCanonConfig(parsed);
  }

  /** current project id for state-file mismatch guards; undefined pre-connect. */
  async function currentProjectId(): Promise<string | undefined> {
    return (await readConfigInternal())?.connection.projectId;
  }

  /**
   * Read both archive JSONL files once (obs rows + score rows + corrupted obs
   * lines). Callers decide how to treat foreign rows (DEC-15).
   */
  async function readArchiveInternal(): Promise<ArchiveRows> {
    const { rows: observations, corrupted } = await readArchiveFile<LfObservationRow>(
      obsPath,
      'observation',
    );
    const { rows: scores, corrupted: corruptedScores } = await readArchiveFile<LfScoreRow>(
      scoresPath,
      'score',
    );
    return { observations, scores, corrupted, corruptedScores };
  }

  /** Distinct envelope projectIds archived that differ from `projectId`. */
  function foreignProjectIds(
    projectId: string,
    archive: ArchiveRows,
  ): string[] {
    const found = new Set<string>();
    for (const { envelope } of archive.observations) {
      if (envelope.projectId !== projectId) found.add(envelope.projectId);
    }
    for (const { envelope } of archive.scores) {
      if (envelope.projectId !== projectId) found.add(envelope.projectId);
    }
    return [...found].sort();
  }

  /**
   * DEC-15 project-mismatch guard for ARCHIVE READS: when the store is
   * connected, archived rows that belong to another project must never flow
   * into this project's analysis/evidence/dedupe accounting (review S2 — the
   * envelope already carries projectId). Callers throw invalid-state with a
   * --force --wipe hint instead of silently mixing projects. Pre-connect
   * (no config) the archive is unclaimed and reads act on it as-is.
   */
  async function guardArchiveProject(): Promise<void> {
    const projectId = await currentProjectId();
    if (projectId === undefined) return;
    const archive = await readArchiveInternal();
    const foreign = foreignProjectIds(projectId, archive);
    if (foreign.length > 0) {
      throw new CanonError(
        `archive contains rows for ${foreign.map((p) => JSON.stringify(p)).join(', ')}; ` +
          `the store is connected to ${projectId}`,
        {
          code: 'invalid-state',
          hint: 'switch projects with: canon connect --force --wipe (clears archive/index/sync-state, proposals and canon)',
        },
      );
    }
  }

  async function readSyncStateInternal(): Promise<SyncState | undefined> {
    let raw: string;
    try {
      raw = await readFile(syncStatePath, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw new CanonError(`cannot read ${syncStatePath}: ${String(e)}`, {
        code: 'io',
        cause: e,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // state files are atomic-renamed so they cannot tear by themselves;
      // a malformed file means operator/disk interference → treat as absent
      // (self-heal) but surface it
      console.warn(`canon: warning: ${syncStatePath} is corrupt and was ignored`);
      return undefined;
    }
    return parsed as SyncState;
  }

  async function readIndexFile(): Promise<IndexData | undefined> {
    let raw: string;
    try {
      raw = await readFile(indexPathFull, 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw new CanonError(`cannot read ${indexPathFull}: ${String(e)}`, {
        code: 'io',
        cause: e,
      });
    }
    try {
      return JSON.parse(raw) as IndexData;
    } catch {
      return undefined; // corrupt → caller rebuilds
    }
  }

  async function writeIndexData(data: IndexData): Promise<void> {
    await atomicWriteJson(indexPathFull, data, PERMS.dataFile);
  }

  async function rebuildIndexInternal(projectId: string): Promise<IndexData> {
    const data = await buildIndexData({
      obsPath,
      projectId,
      builtAt: clock(),
    });
    await writeIndexData(data);
    return data;
  }

  async function traceLinesInternal(
    traceId: string,
  ): Promise<Array<{ line: number; row: LfObservationRow }>> {
    const { rows } = await readArchiveFile<LfObservationRow>(obsPath, 'observation');
    const out: Array<{ line: number; row: LfObservationRow }> = [];
    for (const { line, envelope } of rows) {
      if (envelope.row.traceId === traceId) out.push({ line, row: envelope.row });
    }
    return out;
  }

  async function statusInternal(): Promise<StoreStatus> {
    const cfg = await readConfigInternal(); // corrupt config propagates store-corrupt (integrity report)
    const connected = cfg !== undefined;
    const archive = await readArchiveInternal();
    const foreign =
      cfg !== undefined ? foreignProjectIds(cfg.connection.projectId, archive) : [];
    // DEC-15: status() never mixes projects — a --force switch (or a hand-
    // edited config) that left another project's rows behind is surfaced by
    // excluding those rows from the counts and warning on stderr, so status
    // reflects the store the operator is actually connected to.
    const obsRows = archive.observations.filter(
      (l) => cfg === undefined || foreign.length === 0 || l.envelope.projectId === cfg.connection.projectId,
    );
    const scoreRows = archive.scores.filter(
      (l) => cfg === undefined || foreign.length === 0 || l.envelope.projectId === cfg.connection.projectId,
    );
    const corruptedTotal = archive.corrupted.length + archive.corruptedScores.length;
    if (corruptedTotal > 0) {
      // QA F5 convention extended to the archive: corrupted archive lines are
      // flagged (console warning) instead of silently vanishing from counts.
      const detail =
        archive.corrupted.length > 0
          ? `${archiveDirPath}/${STORE_FILES.observations} lines ${archive.corrupted.join(',')}`
          : '';
      const detail2 =
        archive.corruptedScores.length > 0
          ? `${archiveDirPath}/${STORE_FILES.scores} lines ${archive.corruptedScores.join(',')}`
          : '';
      console.warn(
        `canon: warning: archive contains ${corruptedTotal} corrupted line(s) [${[detail, detail2].filter(Boolean).join('; ')}] — excluded from counts`,
      );
    }
    if (foreign.length > 0) {
      console.warn(
        `canon: warning: archive contains rows for ${foreign.join(', ')}; ` +
          `counts exclude them (store is connected to ${cfg!.connection.projectId}) — ` +
          'switch projects with: canon connect --force --wipe',
      );
    }
    const index = await readIndexFile();
    const indexFresh =
      index !== undefined &&
      index.schema === INDEX_SCHEMA &&
      index.observationCount === obsRows.length;
    const sync = await readSyncStateInternal();
    const lockContent = await readLockContent(lockPath);
    const lockHeld = lockContent !== undefined && pidAlive(lockContent.pid);
    const proposalsByStatus: Record<ProposalStatus, number> = {
      pending: 0,
      ratified: 0,
      rejected: 0,
      decayed: 0,
    };
    for (const id of await listProposalIds(root)) {
      const p = await loadProposal(root, id);
      if (p !== undefined) proposalsByStatus[p.status] += 1;
    }
    let policies = 0;
    try {
      const names = await readdir(canonDirPath);
      policies = names.filter((n) => n.endsWith('.json')).length;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CanonError(`cannot list ${canonDirPath}: ${String(e)}`, {
          code: 'io',
          cause: e,
        });
      }
    }
    let configPermOk = false;
    if (connected) {
      try {
        const st = await stat(configPath);
        configPermOk = (st.mode & 0o777) === PERMS.configFile;
      } catch {
        configPermOk = false;
      }
    }
    return {
      dir: root,
      connected,
      configPermOk,
      archive: { observations: obsRows.length, scores: scoreRows.length },
      indexFresh,
      ...(sync?.lastRun !== undefined ? { lastRun: sync.lastRun } : {}),
      lockHeld,
      proposalsByStatus,
      policies,
    };
  }

  return {
    get dir(): string {
      return root;
    },

    async open(): Promise<void> {
      await ensureOpen();
    },

    async close(): Promise<void> {
      if (held !== undefined) {
        const h = held;
        held = undefined;
        await h.release();
      }
    },

    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      await ensureOpen();
      const outer = held === undefined;
      if (outer) {
        held = await acquireLock(lockPath);
      }
      try {
        return await fn();
      } finally {
        if (outer && held !== undefined) {
          const h = held;
          held = undefined;
          await h.release();
        }
      }
    },

    async readConfig(): Promise<CanonConfig | undefined> {
      await ensureOpen();
      return readConfigInternal();
    },

    async writeConfig(cfg: CanonConfig): Promise<void> {
      await ensureOpen();
      await this.withLock(async () => {
        await atomicWriteJson(configPath, cfg, PERMS.configFile);
        await chmodPath(configPath, PERMS.configFile);
      });
    },

    async appendAudit(e: AuditEventDraft): Promise<AuditEvent> {
      await ensureOpen();
      return this.withLock(() => appendAuditEvent(auditPath, e));
    },

    async readAudit(): Promise<AuditEvent[]> {
      await ensureOpen();
      const { events, skipped } = await readAuditLog(auditPath);
      if (skipped > 0) {
        // QA F5: the compliance read flags corrupted lines instead of silently
        // dropping them. 03's readAudit signature returns events only, so the
        // report channel is a console warning (mirroring asOptionalIso's
        // warn-once convention); append-side reads stay silent by design —
        // see store/audit.ts readAuditLog.
        console.warn(
          `canon: warning: ${auditPath} contains ${skipped} corrupted line(s); ` +
            'they were skipped on read (self-healing append keeps seq monotonic)',
        );
      }
      return events;
    },

    async saveProposal(p: Proposal): Promise<void> {
      await ensureOpen();
      await this.withLock(async () => {
        await mkdirp(proposalsDir(root), PERMS.dir);
        await saveProposal(root, p);
      });
    },

    async loadProposal(id: string): Promise<Proposal | undefined> {
      await ensureOpen();
      return loadProposal(root, id);
    },

    async listProposals(status: ProposalStatus | 'all' = 'all'): Promise<Proposal[]> {
      await ensureOpen();
      const ids = await listProposalIds(root);
      const out: Proposal[] = [];
      for (const id of ids) {
        const p = await loadProposal(root, id);
        if (p === undefined) continue; // file vanished between readdir and read
        if (status !== 'all' && p.status !== status) continue;
        out.push(p);
      }
      // deterministic: confidence desc, id asc
      out.sort(
        (a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      return out;
    },

    async writePolicy(p: Policy): Promise<void> {
      await ensureOpen();
      await this.withLock(async () => {
        await mkdirp(canonDirPath, PERMS.dir);
        await writePolicyFile(root, p);
      });
    },

    async listPolicies(): Promise<Policy[]> {
      await ensureOpen();
      return listPolicies(root);
    },

    // ---- slice 3: archive / index / sync-state / status (03 store facade) ----

    async appendObservationRows(
      rows: Array<Envelope<LfObservationRow>>,
    ): Promise<{ appended: number; dupes: number }> {
      await ensureOpen();
      return this.withLock(async () => {
        await mkdirp(archiveDirPath, PERMS.dir);
        return appendUniqueRows(obsPath, 'observation', rows);
      });
    },

    async appendScoreRows(
      rows: Array<Envelope<LfScoreRow>>,
    ): Promise<{ appended: number; dupes: number }> {
      await ensureOpen();
      return this.withLock(async () => {
        await mkdirp(archiveDirPath, PERMS.dir);
        return appendUniqueRows(scoresPath, 'score', rows);
      });
    },

    async rebuildIndex(): Promise<IndexData> {
      await ensureOpen();
      return this.withLock(async () => {
        const projectId = (await currentProjectId()) ?? '';
        return rebuildIndexInternal(projectId);
      });
    },

    async readIndex(): Promise<IndexData> {
      await ensureOpen();
      const found = await readIndexFile();
      if (found !== undefined && found.schema === INDEX_SCHEMA) {
        // project mismatch after a --force switch: index describes another
        // project → rebuild for the current one (review seam 7 guard)
        const projectId = await currentProjectId();
        if (projectId !== undefined && found.projectId !== projectId) {
          return this.withLock(() => rebuildIndexInternal(projectId));
        }
        return found;
      }
      // missing or corrupt → rebuild + write (self-healing, 03 [DEC-09])
      return this.withLock(async () => {
        const projectId = (await currentProjectId()) ?? found?.projectId ?? '';
        return rebuildIndexInternal(projectId);
      });
    },

    async backfillTraceOutcomes(outcomes: Map<string, Outcome>): Promise<void> {
      await ensureOpen();
      await this.withLock(async () => {
        const projectId = await currentProjectId();
        if (projectId === undefined) return; // not connected → no index to patch
        const found = await readIndexFile();
        if (found === undefined || found.schema !== INDEX_SCHEMA) return; // no index yet
        if (found.projectId !== projectId) return; // DEC-15: foreign index is not touched
        let changed = false;
        for (const [traceId, outcome] of outcomes) {
          const summary = found.traces[traceId];
          if (summary !== undefined && summary.outcome !== outcome) {
            summary.outcome = outcome;
            changed = true;
          }
        }
        if (changed) await writeIndexData(found);
      });
    },

    async traceLines(
      traceId: string,
    ): Promise<Array<{ line: number; row: LfObservationRow }>> {
      await ensureOpen();
      // DEC-15: archive reads never mix projects (foreign rows → invalid-state)
      await guardArchiveProject();
      // Full tolerant scan filtered by traceId: simple and always correct even
      // when index.json is stale (e.g. after --force); the index line-span
      // "targeted seek" (02) is an optimization for when scans get costly.
      return traceLinesInternal(traceId);
    },

    async readSyncState(): Promise<SyncState | undefined> {
      await ensureOpen();
      const state = await readSyncStateInternal();
      if (state === undefined) return undefined;
      // review seam 7: sync state belongs to a project; a mismatch after a
      // --force switch means "start fresh" rather than resuming the old
      // project's windows
      const projectId = await currentProjectId();
      if (projectId !== undefined && state.projectId !== projectId) return undefined;
      return state;
    },

    async writeSyncState(s: SyncState): Promise<void> {
      await ensureOpen();
      await this.withLock(async () => {
        await atomicWriteJson(syncStatePath, s, PERMS.dataFile);
      });
    },

    async readStoredRowIds(): Promise<{ observations: Set<string>; scores: Set<string> }> {
      await ensureOpen();
      // DEC-15: dedupe accounting must never mix projects (dry-run dupes)
      await guardArchiveProject();
      return archivedRowIds(obsPath, scoresPath);
    },

    async readArchiveRows(): Promise<ArchiveRows> {
      await ensureOpen();
      // DEC-15: analyze/evidence reads never mix projects (foreign → refuse)
      await guardArchiveProject();
      return readArchiveInternal();
    },

    async wipeProjectData(): Promise<void> {
      await ensureOpen();
      await this.withLock(async () => {
        // ADR-0004 DEC-22 (supersedes ADR-0003 DEC-15's "proposals/canon
        // kept" wording): --wipe clears the PREVIOUS project's archive, index,
        // sync state AND its derived governance state — pending proposals and
        // ratified canon policies are derived from that project's traces and
        // would otherwise carry dangling evidence after the switch (review
        // S3). The append-only audit log is retained as history — it outlives
        // a project switch.
        for (const p of [obsPath, scoresPath, indexPathFull, syncStatePath]) {
          await unlink(p).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') {
              throw new CanonError(`cannot clear ${p} during --wipe: ${String(e)}`, {
                code: 'io',
                cause: e,
              });
            }
          });
        }
        // purge derived governance files (keep the dirs; they are 0700 and
        // recreated on demand anyway)
        for (const dir of [proposalsDir(root), canonDirPath]) {
          let names: string[];
          try {
            names = await readdir(dir);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw new CanonError(`cannot list ${dir} during --wipe: ${String(e)}`, {
              code: 'io',
              cause: e,
            });
          }
          for (const name of names) {
            await unlink(join(dir, name)).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== 'ENOENT') {
                throw new CanonError(`cannot clear ${join(dir, name)} during --wipe: ${String(e)}`, {
                  code: 'io',
                  cause: e,
                });
              }
            });
          }
        }
      });
    },

    async status(): Promise<StoreStatus> {
      await ensureOpen();
      return statusInternal();
    },
  };
}
