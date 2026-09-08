import type { Command } from '../main.js';
import { CanonError } from '../../core/errors.js';

/**
 * canon audit export — real since slice 6: the compliance/provenance report.
 * `--format json` prints/ writes the canon/audit/v1 digest; `--format md`
 * prints/writes the human-readable report with policy → proposal → evidence
 * chain lines. Report content is ids/counts/times/structural text only — io
 * content never enters the surface (02; DEC-4 redaction default-on has
 * nothing to scrub, mirroring the proposals-view convention).
 */
const auditExport: Command = async (ctx) => {
  const a = ctx.args;
  const format = typeof a.format === 'string' ? a.format : 'md';
  if (format !== 'json' && format !== 'md') {
    throw new CanonError(`--format must be json | md (got ${JSON.stringify(format)})`, {
      code: 'usage',
    });
  }
  const out = typeof a.out === 'string' && a.out.length > 0 ? a.out : undefined;
  const result = await ctx.app.exportAudit({
    format,
    ...(out !== undefined ? { out } : {}),
  });
  if (out !== undefined) {
    console.log(`audit export written to ${result.path}`);
    return 0;
  }
  if (format === 'json') {
    console.log(JSON.stringify(result.digest, null, 2));
  } else {
    console.log(result.markdown);
  }
  return 0;
};

export default auditExport;
