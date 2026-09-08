import type { Command } from '../main.js';

/**
 * canon status — real since slice 3: store integrity report; --rebuild-index
 * regenerates the derived index.json first (02/04 Slice 3). `--json` prints
 * the StoreStatus record.
 */
const statusCmd: Command = async (ctx) => {
  const a = ctx.args;
  const st = await ctx.app.status({ rebuildIndex: a.rebuildIndex === true });
  if (a.json === true) {
    console.log(JSON.stringify(st, null, 2));
    return 0;
  }
  console.log(`status for ${st.dir}`);
  if (!st.connected) {
    console.log('connected no (run canon connect first)');
    return 0;
  }
  console.log('connected yes');
  console.log(`config permissions ${st.configPermOk ? 'ok' : 'WARN: expected 0600'}`);
  console.log(`archive observations ${st.archive.observations}`);
  console.log(`archive scores ${st.archive.scores}`);
  console.log(`index fresh ${st.indexFresh ? 'yes' : 'no (run canon status --rebuild-index)'}`);
  if (st.lastRun !== undefined) {
    const aborted = st.lastRun.aborted === true ? ' (aborted)' : '';
    console.log(
      `last run ${st.lastRun.at} pages ${st.lastRun.pages} new rows ${st.lastRun.newRows} dupes ${st.lastRun.dupes}${aborted}`,
    );
  }
  console.log(`lock held ${st.lockHeld ? 'yes' : 'no'}`);
  const ps = st.proposalsByStatus;
  console.log(
    `proposals pending ${ps.pending} ratified ${ps.ratified} rejected ${ps.rejected} decayed ${ps.decayed}`,
  );
  console.log(`policies ${st.policies}`);
  return 0;
};

export default statusCmd;
