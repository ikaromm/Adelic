import { readFile } from 'node:fs/promises';
import { filesExactly, starterFilesUnchanged } from '../grade-helpers.mjs';
export async function grade(workspace) {
  try {
    const result = JSON.parse(await readFile(`${workspace}/findings.json`, 'utf8'));
    const expectedKeys = ['maximumDiscountPercent', 'negativeSubtotalReturnsZero', 'percentageAfterSubtotal'];
    const exactFacts =
      Object.keys(result).sort().join(',') === expectedKeys.join(',') &&
      result.percentageAfterSubtotal === true &&
      result.maximumDiscountPercent === 25 &&
      result.negativeSubtotalReturnsZero === true;
    const scope =
      (await filesExactly(workspace, ['findings.json', 'src/discount.js'])) &&
      (await starterFilesUnchanged(workspace, 'inspection', ['src/discount.js']));
    const accepted = exactFacts && scope;
    return {
      accepted,
      outcome: accepted ? 'passed' : 'failed',
      checks: { exactIndependentFacts: exactFacts, noSourceEditsOrExtraFiles: scope },
    };
  } catch (error) {
    return { accepted: false, outcome: 'failed', detail: error.message };
  }
}
