import { readFile } from 'node:fs/promises';
const load = async (path) => import(`data:text/javascript;base64,${(await readFile(path)).toString('base64')}`);
export async function grade(workspace) {
  try {
    const mod = await load(`${workspace}/src/stats.js`);
    const values = [9, 1, 4, 2];
    const original = [...values];
    const versionPreserved = mod.version === 1;
    const summary = mod.summarize(values);
    const summaryOk =
      JSON.stringify(summary) === JSON.stringify({ count: 4, sum: 16, mean: 4 }) &&
      JSON.stringify(mod.summarize([])) === JSON.stringify({ count: 0, sum: 0, mean: null });
    const medianOk =
      mod.median(values) === 3 &&
      JSON.stringify(values) === JSON.stringify(original) &&
      mod.median([]) === null &&
      mod.median([1, 7, 2]) === 2;
    const accepted = versionPreserved && summaryOk && medianOk;
    return {
      accepted,
      outcome: accepted ? 'passed' : 'failed',
      checks: { versionPreserved, summary: summaryOk, medianAndNoMutation: medianOk },
    };
  } catch (error) {
    return { accepted: false, outcome: 'failed', detail: error.message };
  }
}
