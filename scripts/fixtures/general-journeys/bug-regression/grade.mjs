import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { filesExactly } from '../grade-helpers.mjs';
const load = async (path) => import(`data:text/javascript;base64,${(await readFile(path)).toString('base64')}`);
export async function grade(workspace) {
  try {
    const mod = await load(`${workspace}/src/tags.js`);
    const cases = [
      { input: [' Bug ', 'bug', 'Feature', ' FEATURE  '], expected: { bug: 2, feature: 2 } },
      { input: [], expected: {} },
      { input: ['a', 'A', ' b '], expected: { a: 2, b: 1 } },
    ];
    const behavior = cases.every(({ input, expected }) => isDeepStrictEqual(mod.countTags(input), expected));
    const regressionTests = await load(`${workspace}/src/tags.test.js`);
    const testResult = regressionTests.runRegressionTests(mod.countTags);
    const starter = await load(new URL('./starter/src/tags.js', import.meta.url));
    let starterTestRejected = false;
    try {
      starterTestRejected = regressionTests.runRegressionTests(starter.countTags) !== true;
    } catch {
      starterTestRejected = true;
    }
    const regressionTestPassed = testResult === true && starterTestRejected;
    const scope = await filesExactly(workspace, ['src/tags.js', 'src/tags.test.js']);
    return {
      accepted: behavior && regressionTestPassed && scope,
      outcome: behavior && regressionTestPassed && scope ? 'passed' : 'failed',
      checks: { externalBehaviorMatrix: behavior, regressionTestPassed, scopedFilesOnly: scope },
    };
  } catch (error) {
    return { accepted: false, outcome: 'failed', detail: error.message };
  }
}
