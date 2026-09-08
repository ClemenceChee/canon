/**
 * Langfuse v4 read client (trace/langfuse/client.ts): projects / observations
 * v2 / scores v3 call builders over the http wrapper. Only reads; deprecated
 * /traces endpoints are never called (DEC-2).
 *
 * The exported URL builders produce URL objects over a placeholder origin
 * (`http://canon.invalid`) — they carry the *relative* path + query so tests
 * can assert them standalone; createLangfuseSource resolves them against the
 * configured baseUrl (origin + /api/public) before fetching.
 */

import { CanonError } from '../../core/errors.js';
import { OBSERVATION_FIELDS, OBSERVATIONS_LIMIT_MAX, SCORES_LIMIT_MAX } from '../../core/constants.js';
import type { Clock } from '../../core/time.js';
import { asObject, asOptionalString, asString } from '../../core/validators.js';
import type { TraceSource } from '../traceSource.js';
import type { ObsQuery, ScoreQuery } from '../traceSource.js';
import type { LfObservationRow, LfPage, LfScoreRow, ProjectInfo } from '../types.js';
import {
  basicAuthHeader,
  getWithRetry,
  resolveHttpConfig,
} from './http.js';
import type { HttpConfig } from './http.js';
import { parsePage } from './normalize.js';

const PLACEHOLDER_ORIGIN = 'http://canon.invalid';

export interface LangfuseSourceOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  http?: HttpConfig;
  clock?: Clock;
}

/** Observations v2 read path (relative to {base}/api/public). */
const OBSERVATIONS_PATH = '/v2/observations';
/** Scores v3 read path (relative to {base}/api/public). */
const SCORES_PATH = '/v3/scores';
/** Projects read path (relative to {base}/api/public). */
const PROJECTS_PATH = '/projects';

function obsParams(q: ObsQuery, cursor?: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set('projectId', q.projectId);
  p.set('fromStartTime', q.window.from);
  p.set('toStartTime', q.window.to);
  p.set('fields', (q.fields ?? OBSERVATION_FIELDS).join(','));
  p.set('limit', String(q.limit ?? OBSERVATIONS_LIMIT_MAX));
  for (const env of q.environment ?? []) p.append('environment', env);
  if (cursor !== undefined && cursor !== '') p.set('cursor', cursor);
  return p;
}

function scoreParams(q: ScoreQuery, cursor?: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set('projectId', q.projectId);
  p.set('fromTimestamp', q.window.from);
  p.set('toTimestamp', q.window.to);
  p.set('limit', String(q.limit ?? SCORES_LIMIT_MAX));
  for (const env of q.environment ?? []) p.append('environment', env);
  if (cursor !== undefined && cursor !== '') p.set('cursor', cursor);
  return p;
}

/** Observations v2 URL (path + query over a placeholder origin). */
export function observationsUrl(q: ObsQuery, cursor?: string): URL {
  return new URL(`${OBSERVATIONS_PATH}?${obsParams(q, cursor).toString()}`, PLACEHOLDER_ORIGIN);
}

/** Scores v3 URL (path + query over a placeholder origin). */
export function scoresUrl(q: ScoreQuery, cursor?: string): URL {
  return new URL(`${SCORES_PATH}?${scoreParams(q, cursor).toString()}`, PLACEHOLDER_ORIGIN);
}

export function createLangfuseSource(opts: LangfuseSourceOptions): TraceSource {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new CanonError(`baseUrl must be an http(s) origin (got ${JSON.stringify(baseUrl)})`, {
      code: 'validation',
    });
  }
  const cfg = resolveHttpConfig(opts.http, opts.clock);

  /** Absolute href = baseUrl + relative path/query carried by the builder URL. */
  function href(rel: URL): string {
    return `${baseUrl}${rel.pathname}${rel.search}`;
  }

  async function getJson(path: string, _label: string): Promise<unknown> {
    return getWithRetry(path, {
      headers: { Authorization: basicAuthHeader(opts.publicKey, opts.secretKey) },
    }, cfg);
  }

  async function listProjectsImpl(): Promise<ProjectInfo[]> {
    const raw = await getJson(href(new URL(PROJECTS_PATH, PLACEHOLDER_ORIGIN)), 'projects');
    // /projects may answer a bare array or a {data:[...]} envelope — accept both
    let list: unknown[];
    if (Array.isArray(raw)) {
      list = raw;
    } else {
      const obj = asObject(raw, 'projects');
      list = Array.isArray(obj.data) ? (obj.data as unknown[]) : [];
    }
    const out: ProjectInfo[] = [];
    for (const item of list) {
      const obj = asObject(item, 'projects row');
      const id = asString(obj.id, 'projects row id');
      const name = asOptionalString(obj.name) ?? '';
      out.push({ id, name });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  async function queryObservationsImpl(
    q: ObsQuery,
    cursor?: string,
  ): Promise<LfPage<LfObservationRow>> {
    const raw = await getJson(href(observationsUrl(q, cursor)), 'observations');
    return parsePage<LfObservationRow>(raw, 'observations page');
  }

  async function queryScoresImpl(q: ScoreQuery, cursor?: string): Promise<LfPage<LfScoreRow>> {
    const raw = await getJson(href(scoresUrl(q, cursor)), 'scores');
    return parsePage<LfScoreRow>(raw, 'scores page');
  }

  return {
    kind: 'langfuse-v4',
    listProjects: listProjectsImpl,
    queryObservations: queryObservationsImpl,
    queryScores: queryScoresImpl,
  };
}
