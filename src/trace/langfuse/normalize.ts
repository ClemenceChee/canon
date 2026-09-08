/**
 * Lenient page parser (03: parsePage<T>(raw, label)) — [DEC-03] cursor
 * contract. Only `data` (an array) and `meta.cursor` (nullable/absent string)
 * are required; unknown keys pass through verbatim. End of stream ⇔ cursor
 * null | undefined | ''. Rows must be objects (a page row that is not an
 * object is a source anomaly and aborts that page fetch loudly).
 */

import { CanonError } from '../../core/errors.js';
import { asObject } from '../../core/validators.js';
import type { LfPage } from '../types.js';

export function parsePage<T>(raw: unknown, label: string): LfPage<T> {
  const obj = asObject(raw, label);
  const dataRaw = obj.data;
  if (!Array.isArray(dataRaw)) {
    throw new CanonError(`${label}: expected a "data" array`, {
      code: 'validation',
      hint: 'is this really a Langfuse v2/v3 public API response?',
    });
  }
  const data = dataRaw.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new CanonError(`${label}: row ${i} is not an object`, {
        code: 'validation',
      });
    }
    return item as T;
  });

  const metaRaw = obj.meta;
  if (metaRaw === undefined) {
    return { data, meta: { cursor: undefined } };
  }
  const metaObj = asObject(metaRaw, `${label} meta`);
  // extra meta keys preserved verbatim; cursor normalized leniently
  const cursor = typeof metaObj.cursor === 'string' ? metaObj.cursor : null;
  return { data, meta: { ...metaObj, cursor } };
}
