/**
 * export/evidence.ts — shared evidence-link verification (CAN-103).
 *
 * One definition of "dangling": an evidence traceId that no longer resolves in
 * the archive. Used by `canon export --verify-links`
 * (export/guardRules.verifyEvidenceLinks) and by `canon governance promote`
 * (pre-ratification gate, app.promoteImpl) so the export path and the
 * governance path agree on what counts as broken provenance.
 *
 * Read cost note: this scans the archive (readArchiveRows). At v0.1 scale that
 * is fine and matches the export path; a future index-backed resolver can live
 * behind this function.
 */
import type { EvidenceLink } from '../store/proposals.js';
import type { CanonStore } from '../store/index.js';

/** Unique evidence traceIds that do not resolve in the archive ([] = clean). */
export async function findDanglingEvidenceTraceIds(
  evidence: EvidenceLink[],
  store: CanonStore,
): Promise<string[]> {
  const archive = await store.readArchiveRows();
  const archived = new Set<string>();
  for (const { envelope } of archive.observations) {
    const traceId = envelope.row.traceId;
    if (typeof traceId === 'string' && traceId.length > 0) archived.add(traceId);
  }
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const e of evidence) {
    if (archived.has(e.traceId) || seen.has(e.traceId)) continue;
    seen.add(e.traceId);
    missing.push(e.traceId);
  }
  return missing;
}
