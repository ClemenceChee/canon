/**
 * TraceSource — source-agnostic page-scrolling reader of observations/scores.
 * The Langfuse-v4 adapter (trace/langfuse) is the only Langfuse-shaped code;
 * a second source can be added behind this interface without touching analysis.
 */

import type { IsoTime } from '../core/time.js';
import type { FieldGroup, LfObservationRow, LfPage, LfScoreRow, ProjectInfo } from './types.js';

export interface TimeWindow {
  from: IsoTime; // inclusive
  to: IsoTime; // exclusive [DEC-08]
}

export interface ObsQuery {
  projectId: string;
  window: TimeWindow;
  fields?: FieldGroup[];
  limit?: number;
  environment?: string[];
}

export interface ScoreQuery {
  projectId: string;
  window: TimeWindow;
  limit?: number;
  environment?: string[];
}

export interface TraceSource {
  readonly kind: string; // 'langfuse-v4' | test double name
  listProjects(): Promise<ProjectInfo[]>;
  queryObservations(q: ObsQuery, cursor?: string): Promise<LfPage<LfObservationRow>>;
  queryScores(q: ScoreQuery, cursor?: string): Promise<LfPage<LfScoreRow>>;
  close?(): Promise<void>;
}
