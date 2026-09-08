import type { Command } from '../main.js';
import type { CanonApp } from '../../app.js';
import type { Severity } from '../../store/proposals.js';
import { CanonError } from '../../core/errors.js';

/**
 * canon governance promote|reject — real since slice 5: the human gate.
 * Attribution resolves in ONE place (app.promote/reject via
 * governance/gate.effectiveActor): --as > CANON_OPERATOR env >
 * settings.operator.name; all empty → usage exit 2 (never anonymous, see the
 * app-level error). Edits arrive via repeatable --set <field>=<value> limited
 * to severity|ruleText|assertion (03 [DEC-16]; note rides --note). Invalid
 * field/value → usage exit 2. reject records the decision in the audit trail
 * (reason kept on the proposal; audit payloads are ids/counts only).
 */

function argAs(args: Record<string, unknown>): string | undefined {
  const v = typeof args.as === 'string' ? args.as : '';
  return v.trim().length > 0 ? v.trim() : undefined;
}

function parseSetValues(args: Record<string, unknown>): Array<{ field: string; value: string }> {
  const raw = Array.isArray(args.set) ? (args.set as string[]) : [];
  return raw.map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new CanonError(`--set expects <field>=<value> (got ${JSON.stringify(pair)})`, {
        code: 'usage',
      });
    }
    return { field: pair.slice(0, eq), value: pair.slice(eq + 1) };
  });
}

function buildEdit(args: Record<string, unknown>): {
  severity?: Severity;
  ruleText?: string;
  assertion?: string;
} {
  const edit: { severity?: Severity; ruleText?: string; assertion?: string } = {};
  for (const { field, value } of parseSetValues(args)) {
    if (field === 'severity') {
      if (value !== 'advisory' && value !== 'mandatory') {
        throw new CanonError(`--set severity must be advisory | mandatory (got ${JSON.stringify(value)})`, {
          code: 'usage',
        });
      }
      edit.severity = value;
      continue;
    }
    if (field === 'ruleText' || field === 'assertion') {
      if (value.trim().length === 0) {
        throw new CanonError(`--set ${field} must not be empty`, { code: 'usage' });
      }
      edit[field] = value;
      continue;
    }
    throw new CanonError(
      `--set field must be severity|ruleText|assertion (got ${JSON.stringify(field)})`,
      { code: 'usage' },
    );
  }
  return edit;
}

export const governancePromote: Command = async (ctx) => {
  const app: CanonApp = ctx.app;
  const a = ctx.args;
  const id = typeof a.id === 'string' ? a.id : '';
  const actor = argAs(a);
  const edit = buildEdit(a);
  const note = typeof a.note === 'string' && a.note.length > 0 ? a.note : undefined;
  // CAN-103: --force ratifies even when evidence links no longer resolve in
  // the archive (the app audits a governance.promote-override event).
  const force = a.force === true;
  // attribution resolution (--as > CANON_OPERATOR > settings.operator.name)
  // lives in app.promote; an empty handle surfaces as a usage exit 2 there.
  const result = await app.promote(id, {
    ...(actor !== undefined ? { actor } : { actor: '' }),
    ...(note !== undefined ? { note } : {}),
    ...(Object.keys(edit).length > 0 ? { edit } : {}),
    ...(force ? { force } : {}),
  });
  console.log(`promoted ${result.proposalId} -> ${result.policyPath} (severity ${result.severity})`);
  if (result.editedFields.length > 0) {
    console.log(`edited fields: ${result.editedFields.join(', ')}`);
  }
  return 0;
};

export const governanceReject: Command = async (ctx) => {
  const app: CanonApp = ctx.app;
  const a = ctx.args;
  const id = typeof a.id === 'string' ? a.id : '';
  const actor = argAs(a);
  const reason = typeof a.reason === 'string' && a.reason.length > 0 ? a.reason : undefined;
  const updated = await app.reject(id, {
    ...(actor !== undefined ? { actor } : { actor: '' }),
    ...(reason !== undefined ? { reason } : {}),
  });
  console.log(`rejected ${updated.id} (${updated.status})`);
  return 0;
};
