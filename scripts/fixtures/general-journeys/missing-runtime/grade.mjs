import { readFile } from 'node:fs/promises';
import { filesExactly, starterFilesUnchanged } from '../grade-helpers.mjs';
export async function grade(workspace) {
  try {
    const diagnosis = JSON.parse(await readFile(`${workspace}/diagnosis.json`, 'utf8'));
    const originalReadme = await readFile(new URL('./starter/README.md', import.meta.url), 'utf8');
    const scope =
      (await filesExactly(workspace, ['README.md', 'check.sh', 'diagnosis.json'])) &&
      (await starterFilesUnchanged(workspace, 'missing-runtime', ['README.md', 'check.sh']));
    const expected =
      diagnosis.cause === 'missing-runtime' &&
      diagnosis.executable === 'journey-missing-compiler' &&
      diagnosis.probeFoundOnPath === false &&
      diagnosis.checkPassed === false &&
      typeof diagnosis.recovery?.requiresInstallation === 'boolean' &&
      diagnosis.recovery?.checkPassed === false &&
      typeof diagnosis.recovery?.nextStep === 'string' &&
      diagnosis.recovery.nextStep.trim().length >= 8 &&
      /journey-missing-compiler/.test(originalReadme) &&
      scope;
    return {
      accepted: expected,
      outcome: expected ? 'passed' : 'failed',
      checks: {
        identifiedFixtureExecutableAndBoundedRecovery: expected,
        probeExecution: 'unknown; the grader does not independently observe tool use',
      },
    };
  } catch (error) {
    return { accepted: false, outcome: 'failed', detail: error.message };
  }
}
