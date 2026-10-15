import { pathToFileURL } from 'node:url';
import { filesExactly } from '../grade-helpers.mjs';
const load = (path) => import(pathToFileURL(path).href);
export async function grade(workspace) {
  try {
    const query = await load(`${workspace}/src/query.js`);
    const handler = await load(`${workspace}/src/handler.js`);
    const cases = [
      [{ pageSize: -2 }, 1],
      [{ pageSize: 9 }, 9],
      [{ pageSize: 500 }, 50],
      [{}, 20],
    ];
    const behavior = cases.every(
      ([input, expected]) =>
        query.normalizeQuery(input).pageSize === expected && handler.handle(input).pageSize === expected,
    );
    const scope = await filesExactly(workspace, ['package.json', 'src/handler.js', 'src/query.js']);
    return {
      accepted: behavior && scope,
      outcome: behavior && scope ? 'passed' : 'failed',
      checks: { lowerBoundUpperBoundDefaultAndCrossModuleFlow: behavior, scopedFilesOnly: scope },
    };
  } catch (error) {
    return { accepted: false, outcome: 'failed', detail: error.message };
  }
}
