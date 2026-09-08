import type { Command } from '../main.js';
import { CanonError } from '../../core/errors.js';

/**
 * canon export — two vendor surfaces from the effective canon:
 *
 *   - `--format guardrules-json` (slice 6): the vendor-neutral guard-rule pack
 *     (schema canon/guard-rules/v1) with an optional `--verify-links` evidence
 *     check.
 *   - `--format json` (canon ↔ dashboard integration): the versioned governance
 *     document (metrics + policies + divergence) the langfuse-cost-governance
 *     dashboard ingests via its canon-ingest sidecar.
 *
 * `--out` writes the file (0600); without it the document prints to stdout as
 * JSON. `--verify-links` only applies to guardrules-json.
 */
const exportCmd: Command = async (ctx) => {
  const a = ctx.args;
  const format = typeof a.format === 'string' ? a.format : 'guardrules-json';
  const out = typeof a.out === 'string' && a.out.length > 0 ? a.out : undefined;

  if (format === 'guardrules-json') {
    const result = await ctx.app.exportGuardRules({
      ...(out !== undefined ? { out } : {}),
      verifyLinks: a.verifyLinks === true,
    });
    if (out !== undefined) {
      console.log(
        `exported ${result.pack.rules.length} rule(s) to ${result.path} (${result.pack.schema})`,
      );
    } else {
      console.log(JSON.stringify(result.pack, null, 2));
    }
    if (a.verifyLinks === true) {
      console.log('evidence links verified (0 dangling)');
    }
    return 0;
  }

  if (format === 'json') {
    if (a.verifyLinks === true) {
      throw new CanonError('--verify-links only applies to --format guardrules-json', {
        code: 'usage',
      });
    }
    const result = await ctx.app.exportGovernance({
      ...(out !== undefined ? { out } : {}),
    });
    if (out !== undefined) {
      console.log(
        `exported ${result.document.policies.length} ratified policy(s) to ${result.path} ` +
          `(canon/dashboard-json v${result.document.version})`,
      );
    } else {
      console.log(JSON.stringify(result.document, null, 2));
    }
    return 0;
  }

  throw new CanonError(
    `--format must be guardrules-json | json (got ${JSON.stringify(format)})`,
    { code: 'usage' },
  );
};

export default exportCmd;
