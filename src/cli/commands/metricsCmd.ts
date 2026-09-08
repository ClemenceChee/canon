import type { Command } from '../main.js';

/**
 * canon metrics — real since slice 6: the two 01-product.md success metrics
 * read from audit events + proposal state (02 reading points):
 *  - ttrp: earliest connect → earliest governance.promote (null until a
 *    ratified policy exists — with a hint);
 *  - precision14: ratified ≤ 14 d after createdAt over promoted+rejected
 *    within the measurement window (decayed excluded from the denominator).
 * `--json` prints the MetricsResult record; the human view is prose.
 */
const metricsCmd: Command = async (ctx) => {
  const m = await ctx.app.metrics();
  if (ctx.args.json === true) {
    console.log(JSON.stringify(m, null, 2));
    return 0;
  }
  console.log(`project ${m.projectId}`);
  console.log(`connected ${m.connectedAt ?? 'never'}`);
  console.log(`first promote ${m.firstPromoteAt ?? 'none'}`);
  if (m.ttrp !== null) {
    console.log(`ttrp ${m.ttrp.ms}ms (connect → first ratified policy)`);
  } else {
    console.log('ttrp null (no ratified policy yet — run canon analyze then governance promote)');
  }
  const ps = m.proposals;
  console.log(
    `proposals total ${ps.total} (pending ${ps.pending}, ratified ${ps.ratified}, rejected ${ps.rejected}, decayed ${ps.decayed})`,
  );
  if (m.precision14.ratio !== null) {
    console.log(
      `precision14 ${m.precision14.ratio} (${m.precision14.numerator}/${m.precision14.denominator} ratified within 14 days)`,
    );
  } else {
    console.log('precision14 n/a (no promote/reject decisions within the 14-day window yet)');
  }
  return 0;
};

export default metricsCmd;
