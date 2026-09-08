/**
 * Public library entry (03): createCanon + every exported type. All runtime
 * imports are `node:` builtins or sibling modules — see npm run check:runtime-deps.
 */

// core
export { CanonError, isCanonError, fail, exitCodeFor } from './core/errors.js';
export type { CanonErrorCode } from './core/errors.js';
export { nowIso, parseIso, toIso, compare, addDays, addHours, clampFrom } from './core/time.js';
export type { IsoTime, Clock } from './core/time.js';
export { newId, ruleKeyFrom } from './core/id.js';
export type { IdKind } from './core/id.js';
export {
  asObject,
  asString,
  asOptionalString,
  asStringArray,
  asOptionalIso,
} from './core/validators.js';
export { createRedactor } from './core/redact.js';
export type { Redactor, RedactorOptions, ContentKind } from './core/redact.js';

// constants ([PROPOSED] single home)
export {
  DEFAULT_HTTP_CONFIG,
  DEFAULT_SETTINGS,
  OBSERVATIONS_LIMIT_MAX,
  SCORES_LIMIT_MAX,
  OBSERVATION_FIELDS,
  CANON_VERSION,
} from './core/constants.js';

// trace source contract
export type {
  ObservationType,
  Level,
  FieldGroup,
  LfObservationRow,
  LfScoreRow,
  ScoreDataType,
  ScoreSource,
  LfPage,
  ProjectInfo,
} from './trace/types.js';
export type { TraceSource, ObsQuery, ScoreQuery, TimeWindow } from './trace/traceSource.js';

// langfuse-v4 adapter (public factory + option types; internal helpers are
// exported for tests from their own modules per 03)
export { createLangfuseSource } from './trace/langfuse/client.js';
export type { LangfuseSourceOptions } from './trace/langfuse/client.js';
export type { HttpConfig } from './trace/langfuse/http.js';

// store
export { CONFIG_SCHEMA, createCanonStore, defaultSettings, parseCanonConfig } from './store/index.js';
export type {
  CanonConfig,
  CanonConfigConnection,
  CanonConfigSettings,
  CanonStore,
  StoreStatus,
} from './store/index.js';
export type {
  Envelope,
  EnvelopeRow,
  IndexData,
  TraceSummary,
  ArchiveKind,
  Outcome,
} from './store/archive.js';

// ingest sync types (03 store facade SyncState lives with the engine)
export { SYNC_SCHEMA } from './ingest/sync.js';
export type { SyncMode, SyncState, SyncCompletedWindow } from './ingest/sync.js';
export {
  RULE_KINDS,
  saveProposal,
  loadProposal,
} from './store/proposals.js';
export type {
  RuleKind,
  Severity,
  ProposalStatus,
  GuardConstraints,
  Coverage,
  EvidenceLink,
  Proposal,
} from './store/proposals.js';
export type {
  AuditType,
  AuditEvent,
  AuditEventDraft,
} from './store/audit.js';

// app (library entry)
export { createCanon, assertBaseUrlAllowed } from './app.js';
export type {
  CanonApp,
  CanonOptions,
  ConnectOptions,
  AnalyzeOptions,
  ListProposalsOptions,
  AnalysisReport,
  IngestOptions,
  IngestReport,
  StatusOptions,
  PromoteOptions,
  PromoteResult,
  RejectOptions,
  ExportGuardRulesOptions,
  ExportAuditOptions,
  AuditExportResult,
} from './app.js';

// export + metrics (slice 6)
export { buildGuardRulesPack, verifyEvidenceLinks } from './export/guardRules.js';
export type {
  GuardRule,
  GuardRulePackMeta,
  GuardRuleProvenance,
  GuardRuleScope,
} from './export/guardRules.js';
export {
  GUARD_RULES_SCHEMA_V1,
  validateGuardRulesPack,
  validateValue,
} from './export/schema-guard-rules-v1.js';
export type { JsonSchema } from './export/schema-guard-rules-v1.js';
export { AUDIT_DIGEST_SCHEMA, buildAuditDigest, auditReportMarkdown } from './export/auditReport.js';
export type { AuditDigest, AuditDigestContext } from './export/auditReport.js';
export { computeMetrics, PRECISION14_WINDOW_MS } from './metrics/metrics.js';
export type { MetricsResult } from './metrics/metrics.js';
export type { Policy } from './app.js';

// propose (slice 5)
export { DEFAULT_SCORING_CONSTANTS } from './propose/scoring.constants.js';
export type { ScoringConstants } from './propose/scoring.constants.js';
export { buildCandidates, ruleKeyFor } from './propose/candidates.js';
export { fillRuleText } from './propose/templates.js';
export type { RuleText, TemplateOpts } from './propose/templates.js';
export { CANDIDATE_KINDS_V01, kindMeta } from './propose/kinds.js';
export type { KindMeta } from './propose/kinds.js';
export { decaySweep, promote, reject, policyFileName } from './governance/gate.js';
export type { PromoteEdit, DecayConstants } from './governance/gate.js';

// analyze domain (slice 4)
export {
  rebuildTrees,
  inferOutcome,
} from './analyze/tree.js';
export type {
  ObservationNode,
  TraceTree,
  TreeReport,
  SkipReason,
} from './analyze/tree.js';
export { extractDecisions } from './analyze/decisions.js';
export type { DecisionFact, FactKind, RetryCause } from './analyze/decisions.js';
export { buildProfiles } from './analyze/profiles.js';
export type { AgentProfile } from './analyze/profiles.js';
export { divergenceGroups } from './analyze/divergence.js';
export type { DivergenceGroup } from './analyze/divergence.js';
