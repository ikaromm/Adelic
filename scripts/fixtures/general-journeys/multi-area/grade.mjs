import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const load = (path) => import(pathToFileURL(path).href);
export async function grade(workspace) {
  try {
    const query = await load(`${workspace}/src/query.js`);
    const handler = await load(`${workspace}/src/handler.js`);
    const cases = [
      [{ pageSize: -2, marker: 'kept' }, 1],
      [{ pageSize: 9, marker: 'kept' }, 9],
      [{ pageSize: 500, marker: 'kept' }, 50],
      [{ marker: 'kept' }, 20],
    ];
    const behavior = cases.every(([input, expected]) => {
      const normalized = query.normalizeQuery(input);
      return (
        normalized.pageSize === expected &&
        normalized.marker === input.marker &&
        handler.handle(input).pageSize === expected
      );
    });
    const packageJson = JSON.parse(await readFile(`${workspace}/package.json`, 'utf8'));
    const originalPackage = JSON.parse(await readFile(new URL('./starter/package.json', import.meta.url), 'utf8'));
    const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const dependenciesUnchanged = dependencyFields.every((field) =>
      isDeepStrictEqual(packageJson[field] ?? {}, originalPackage[field] ?? {}),
    );
    const accepted = behavior && dependenciesUnchanged;
    return {
      accepted,
      outcome: accepted ? 'passed' : 'failed',
      checks: {
        lowerBoundUpperBoundDefaultAndCrossModuleFlow: behavior,
        dependenciesUnchanged,
      },
    };
  } catch (error) {
    return { accepted: false, outcome: 'failed', detail: error.message };
  }
}
