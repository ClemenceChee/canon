/**
 * Langfuse-shaped row types (server v4 model, tolerant): only the fields canon
 * consumes are typed; extra keys pass through verbatim (upstream schema growth
 * must never break ingestion). Rows come from the v2 Observations and v3
 * Scores public APIs — never legacy /traces JSON.
 */

import type { IsoTime } from '../core/time.js';

export type ObservationType =
  | 'SPAN'
  | 'GENERATION'
  | 'EVENT'
  | 'AGENT'
  | 'TOOL'
  | 'CHAIN'
  | 'RETRIEVER'
  | 'EVALUATOR'
  | 'EMBEDDING'
  | 'GUARDRAIL'
  | (string & {});

export type Level =
  | 'DEBUG'
  | 'TRACE'
  | 'INFO'
  | 'WARN'
  | 'ERROR'
  | 'DEFAULT'
  | (string & {});

/** Field groups = what was requested via `fields=` on the observation read. */
export type FieldGroup =
  | 'core'
  | 'basic'
  | 'time'
  | 'io'
  | 'metadata'
  | 'model'
  | 'usage'
  | 'prompt'
  | 'metrics'
  | 'trace_context';

export interface LfObservationRow {
  // core (always present)
  id: string;
  traceId: string;
  projectId: string;
  type: ObservationType;
  parentObservationId?: string | null; // null = no physical parent
  isRootObservation?: boolean;
  startTime?: IsoTime;
  endTime?: IsoTime;
  // basic
  name?: string;
  level?: Level;
  statusMessage?: string;
  version?: string;
  environment?: string;
  bookmarked?: boolean;
  public?: boolean;
  userId?: string;
  sessionId?: string;
  // time
  completionStartTime?: IsoTime;
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  // io — RAW STRINGS (redaction gates decide what is stored/displayed)
  input?: string;
  output?: string;
  metadata?: unknown;
  // model
  model?: string;
  internalModelId?: string;
  modelParameters?: Record<string, unknown>;
  inputPrice?: string;
  outputPrice?: string;
  totalPrice?: string; // string decimals
  // usage
  usageDetails?: { input?: number; output?: number; total?: number };
  inputUsage?: number;
  outputUsage?: number;
  totalUsage?: number;
  costDetails?: { input?: number; output?: number; total?: number };
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;
  usagePricingTierName?: string;
  // metrics
  latency?: number;
  timeToFirstToken?: number;
  // trace_context
  tags?: string[];
  release?: string;
  traceName?: string;
  // unknown keys preserved verbatim
  [k: string]: unknown;
}

export type ScoreDataType =
  | 'NUMERIC'
  | 'BOOLEAN'
  | 'CATEGORICAL'
  | 'TEXT'
  | 'CORRECTION';
export type ScoreSource = 'API' | 'ANNOTATION' | 'EVAL';

export interface LfScoreRow {
  id: string;
  projectId?: string;
  traceId?: string; // mirrored at top level when TRACE subject
  name: string;
  dataType?: ScoreDataType;
  value?: unknown;
  comment?: string;
  source?: ScoreSource;
  configId?: string;
  authorUserId?: string;
  timestamp?: IsoTime;
  environment?: string;
  subject?: {
    kind: 'TRACE' | 'OBSERVATION' | 'SESSION' | 'EXPERIMENT';
    id: string;
    traceId?: string;
  };
  [k: string]: unknown;
}

/** Cursor contract [DEC-03]: end of stream ⇔ cursor null | undefined | ''. */
export interface LfPage<T> {
  data: T[];
  meta?: { cursor?: string | null; [k: string]: unknown };
}

export interface ProjectInfo {
  id: string;
  name: string;
}
