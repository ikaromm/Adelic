import { readFile } from 'node:fs/promises';
import { filesExactly } from '../grade-helpers.mjs';
const load = async (path) => import(`data:text/javascript;base64,${(await readFile(path)).toString('base64')}`);
export async function grade(workspace) {
  try {
    const mod = await load(`${workspace}/src/text.js`);
    const samples = [
      [' Hello, World! ', 'hello-world'],
      ['Déjà vu', 'd-j-vu'],
      ['a___b', 'a-b'],
      ['---', ''],
    ];
    const behavior = samples.every(([input, expected]) => mod.slugify(input) === expected);
    const readme = await readFile(`${workspace}/README.md`, 'utf8');
    const docs = /slugify\s*\(/i.test(readme) && readme.includes('hello-world');
    const scope = await filesExactly(workspace, ['README.md', 'src/text.js']);
    return {
      accepted: behavior && docs && scope,
      outcome: behavior && docs && scope ? 'passed' : 'failed',
      checks: { behavior, usageExample: docs, scopedFilesOnly: scope },
    };
  } catch (error) {
    return { accepted: false, outcome: 'failed', detail: error.message };
  }
}
