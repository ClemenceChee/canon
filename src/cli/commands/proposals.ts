import type { Command } from '../main.js';
import type { CanonApp } from '../../app.js';
import type { ProposalStatus, RuleKind } from '../../store/proposals.js';

/**
 * canon proposals list|show — real since slice 1 (list) / slice 5 (show).
 * list: pending-first, confidence-desc, --json machine output; the store
 * decay sweep runs at the start of every list under lock (03 [DEC-15]).
 * show: full detail of one proposal (rule text, coverage, evidence links);
 * proposals carry structural tokens only (DEC-07) so no content redaction is
 * needed — there is no io content to redact.
 */
export const proposalsList: Command = async (ctx) => {
  const app: CanonApp = ctx.app;
  const a = ctx.args;
  const status = (typeof a.status === 'string' ? a.status : 'pending') as
    | ProposalStatus
    | 'all';
  const kind =
    Array.isArray(a.kind) && a.kind.every((x) => typeof x === 'string')
      ? (a.kind as RuleKind[])
      : undefined;
  const rows = await app.proposals({ status, kind });

  if (a.json === true) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log(`proposals (${rows.length} ${status === 'all' ? 'all' : status})`);
  for (const p of rows) {
    console.log(
      `${p.id}\t${p.kind}\t${p.ruleKey}\t${p.severity}\t${p.status}\t${p.confidence.toFixed(2)}\t${p.createdAt}\t${p.title}`,
    );
  }
  return 0;
};

export const proposalsShow: Command = async (ctx) => {
  const a = ctx.args;
  const id = typeof a.id === 'string' ? a.id : '';
  const p = await ctx.app.showProposal(id);
  if (a.json === true) {
    console.log(JSON.stringify(p, null, 2));
    return 0;
  }
  console.log(`proposal ${p.id} (${p.status})`);
  console.log(`rule ${p.ruleKey} v(pending) kind ${p.kind} severity ${p.severity}`);
  console.log(`confidence ${p.confidence.toFixed(2)} coverage ${p.coverage.traces} traces / ${p.coverage.observations} observations / consistency ${p.coverage.consistency.toFixed(2)}`);
  console.log(`title ${p.title}`);
  console.log(`rule text ${p.ruleText}`);
  console.log(`assertion ${p.assertion}`);
  if (p.conflictsWith.length > 0) {
    for (const c of p.conflictsWith) console.log(`conflict [${c.kind}] ${c.id}: ${c.reason}`);
  }
  console.log(`evidence ${p.evidence.length} link(s)`);
  for (const e of p.evidence) {
    console.log(`  ${e.role} ${e.traceId} (${e.observationIds.join(', ')})`);
  }
  return 0;
};
