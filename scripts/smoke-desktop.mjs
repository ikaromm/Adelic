import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
const artifact = resolve(
  process.argv[2] || join(projectRoot, 'release', `Adelic-${pkg.version}-linux-x86_64.AppImage`),
);
const temporary = await mkdtemp(join(tmpdir(), 'adelic-desktop-test-'));
const env = {
  ...process.env,
  PATH: '/usr/bin:/bin',
  APPIMAGE_EXTRACT_AND_RUN: '1',
  ADELIC_DATA_DIR: join(temporary, 'data'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ADELIC_DESKTOP_SMOKE;
// Este teste de instalação deve funcionar também sem contas/provedores instalados.
for (const id of ['CODEX', 'CLAUDE', 'KIRO', 'OPENCODE']) env[`ADELIC_${id}_BIN`] = join(temporary, 'missing-cli');
const processes = [];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function bounded(promise, timeout = 120_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Tempo de validação desktop excedido.')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function launch(name, smoke = false) {
  const reportPath = join(temporary, `${name}.json`);
  const child = spawn(artifact, [], {
    cwd: temporary,
    env: { ...env, ADELIC_DESKTOP_REPORT: reportPath, ...(smoke ? { ADELIC_DESKTOP_SMOKE: '1' } : {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const result = { child, reportPath, diagnostics: '', mainPid: undefined, backendPid: undefined };
  result.exited = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  });
  void result.exited.catch(() => {});
  child.stderr.on('data', (chunk) => {
    result.diagnostics = (result.diagnostics + chunk).slice(-4000);
  });
  processes.push(result);
  return result;
}
async function ready(run) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(await readFile(run.reportPath, 'utf8'));
      run.mainPid = report.mainPid;
      run.backendPid = report.backendPid;
      if (report.url) return report;
    } catch {}
    if (run.child.exitCode !== null || run.child.signalCode)
      throw new Error(`O desktop encerrou antes de iniciar. ${run.diagnostics}`);
    await pause(50);
  }
  throw new Error(`O desktop não informou uma URL local. ${run.diagnostics}`);
}

try {
  const first = launch('first');
  const report = await ready(first);
  assert.equal(new URL(report.url).hostname, '127.0.0.1');
  const response = await fetch(`${report.url}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'codex', title: 'Validação do pacote Linux' }),
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  assert.equal(session.projectId, null);
  const second = launch('second', true);
  assert.equal((await bounded(second.exited)).code, 0);
  const forwarded = JSON.parse(await readFile(second.reportPath, 'utf8'));
  assert.equal(forwarded.smoke.forwarded, true);
  assert.equal(forwarded.backendPid, null);
  process.kill(report.mainPid, 'SIGTERM');
  assert.equal((await bounded(first.exited)).code, 0);
  assert.equal(alive(report.backendPid), false, 'O backend continuou em execução após fechar o aplicativo.');
  await assert.rejects(fetch(`${report.url}/api/sessions/${session.id}`, { signal: AbortSignal.timeout(1500) }));
  const reopened = launch('reopened', true);
  assert.equal((await bounded(reopened.exited)).code, 0);
  const reopenedReport = JSON.parse(await readFile(reopened.reportPath, 'utf8'));
  assert.equal(reopenedReport.smoke.ok, true);
  assert.equal(alive(reopenedReport.backendPid), false);
  const database = new DatabaseSync(join(env.ADELIC_DATA_DIR, 'adelic.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)?.id, session.id);
  } finally {
    database.close();
  }
  const summary = {
    ok: true,
    artifact,
    nodeVersion: report.nodeVersion,
    singleInstance: true,
    shutdown: true,
    historyPreserved: true,
    domReady: reopenedReport.smoke.domReady,
    outsideRepository: true,
    initialPath: env.PATH,
  };
  const output = join(projectRoot, '.desktop/validation');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'smoke.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally {
  for (const run of processes) {
    try {
      const report = JSON.parse(await readFile(run.reportPath, 'utf8'));
      run.mainPid ??= report.mainPid;
      run.backendPid ??= report.backendPid;
    } catch {}
    for (const pid of [run.mainPid, run.backendPid, run.child.pid])
      if (pid && alive(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    try {
      await bounded(run.exited, 20_000);
    } catch {
      for (const pid of [run.mainPid, run.backendPid, run.child.pid])
        if (pid && alive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
        }
      try {
        await bounded(run.exited, 3000);
      } catch {}
    }
  }
  // A pasta contém somente dados temporários criados por este teste.
  await rm(temporary, { recursive: true, force: true });
}
