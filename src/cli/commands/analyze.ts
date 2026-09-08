import type { Command } from '../main.js';
import type { CanonApp } from '../../app.js';
import type { AnalyzeOptions } from '../../app.js';

/**
 * canon analyze — real since slice 4: rebuilds trace trees from the archive,
 * infers outcomes (back-filled into the index), extracts decision facts,
 * builds agent profiles and divergence groups, then prints the summary
 * report. Proposals are created by the slice-5 candidate stage.
 */
const analyze: Command = async (ctx) => {
  const app: CanonApp = ctx.app;
  const a = ctx.args;
  const opts: AnalyzeOptions = {
    since: typeof a.since === 'string' ? a.since : undefined,
    environments:
      Array.isArray(a.env) && a.env.every((x) => typeof x === 'string')
        ? (a.env as string[])
        : undefined,
  };
  const report = await app.analyze(opts);
  console.log(`analysis run ${report.runId}`);
  console.log(`project ${report.projectId}`);
  console.log(`trees ${report.trees}`);
  console.log(`skipped ${report.skipped}`);
  console.log(`facts ${report.facts}`);
  console.log(`agents ${report.agents}`);
  console.log(`divergence groups ${report.divergenceGroups}`);
  console.log(`proposals created ${report.proposed}`);
  console.log(`decayed ${report.decayed}`);
  return 0;
};

export default analyze;
