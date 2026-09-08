import type { Command } from '../main.js';

/**
 * canon canon show — real since slice 5: the versioned canon store (effective
 * canon = the latest policy version per ruleKey; policy files are immutable
 * per version). --json prints the full Policy records.
 */
const canonShow: Command = async (ctx) => {
  const a = ctx.args;
  const policies = await ctx.app.showCanon();
  if (a.json === true) {
    console.log(JSON.stringify(policies, null, 2));
    return 0;
  }
  console.log(`canon (${policies.length} active rule(s))`);
  for (const p of policies) {
    console.log(
      `${p.ruleKey}.v${p.version}\t${p.severity}\t${p.ratifiedBy}\t${p.ratifiedAt}\t${p.originProposalId}\t${p.ruleText}`,
    );
  }
  return 0;
};

export default canonShow;
