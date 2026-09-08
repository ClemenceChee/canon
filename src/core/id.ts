/**
 * Entity id helpers [DEC-01/03 naming]: canon-owned entities are
 * `${kind}_` + 8 hex chars (crypto.randomUUID). Langfuse trace/observation ids
 * are never rewritten. Deterministic rule keys come from ruleKeyFrom (03
 * core/id.ts contract; ADR-0004 DEC-21 restores it — see below).
 */

import { randomUUID } from 'node:crypto';

export type IdKind = 'prop' | 'pol' | 'run' | 'evt' | 'trace' | 'obs';

/** `${kind}_` + 8 hex chars. */
export function newId(kind: IdKind): string {
  const hex = randomUUID().replaceAll('-', '').slice(0, 8);
  return `${kind}_${hex}`;
}

/**
 * Normalised, stable rule key from semantic parts (03 core/id.ts contract:
 * "kebab, stable lowercase, deduped"; ADR-0004 DEC-21):
 *
 *  - parts that are undefined/empty are dropped;
 *  - each part is lower-cased and any run of non-alphanumeric characters
 *    (space, underscore, slash, dash, …) becomes a single '-', so raw
 *    tool/task tokens — which may carry capitals, spaces or '/' — can never
 *    reach a policy filename unnormalised (review S2);
 *  - duplicate PARTS (parts whose normalised form is identical to an earlier
 *    part) are kept once — a caller passing the same token twice (e.g. a task
 *    label equal to the kind) must not double it;
 *  - distinct parts are never merged or shortened, so the tool/task identity
 *    encoded in the key is never lossy.
 *
 * Proposal rule keys route through this helper; tool-bound kinds (tool-choice,
 * side-effect-retry) pass [kind, taskKey, tool] and model-usage passes
 * [kind, taskKey] — including the taskKey means the same tool used in two
 * taskKeys yields two distinct ruleKeys (DEC-21: no cross-task collision at
 * dedupe/pending-suppression). Deterministic: identical inputs ⇒ identical
 * output; output matches /^[a-z0-9]+(-[a-z0-9]+)*$/ and is path-safe.
 */
export function ruleKeyFrom(parts: Array<string | undefined>): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    if (part === undefined) continue;
    const normalized = part
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    kept.push(normalized);
  }
  return kept.join('-');
}
