import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../server/runtime.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(prefix = 'adelic-runtime-') {
  const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir);
  const webDir = join(dir, 'application', 'web'); mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Adelic fixture</title>');
  return { dir, dataDir: join(dir, 'user-data'), webDir };
}

describe('server runtime', () => {
  it('serves absolute web resources from another cwd and persists state across restart', async () => {
    const { dir, dataDir, webDir } = fixture();
    const originalCwd = process.cwd();
    const server = await startServer({ port: 0, webDir: resolve(webDir), dataDir: resolve(dataDir), development: false });
    try {
      process.chdir(dir);
      expect(server.port).toBeGreaterThan(0);
      expect(await (await fetch(server.url)).text()).toContain('Adelic fixture');
      const created = await fetch(`${server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(created.status).toBe(201);
      const session = await created.json() as { id: string };
      await server.close(); await server.close();

      const restarted = await startServer({ port: 0, webDir: resolve(webDir), dataDir: resolve(dataDir), development: false });
      try {
        const detail = await fetch(`${restarted.url}/api/sessions/${session.id}`);
        expect(detail.status).toBe(200);
        expect(await detail.json()).toMatchObject({ session: { id: session.id, projectId: null } });
        const exported = await (await fetch(`${restarted.url}/api/export`)).json() as { projects: unknown[] };
        expect(exported.projects).toEqual([]);
      } finally { await restarted.close(); }
    } finally { process.chdir(originalCwd); await server.close(); }
  });

  it('owns one lock per real data directory and releases it idempotently', async () => {
    const { dataDir, webDir } = fixture(); mkdirSync(dataDir, { recursive: true });
    const alias = join(dataDir, '..', 'user-data');
    const first = await startServer({ port: 0, webDir, dataDir });
    await expect(startServer({ port: 0, webDir, dataDir: alias })).rejects.toThrow(/já está sendo usada por outra instância/);
    await Promise.all([first.close(), first.close()]);
    const recovered = await startServer({ port: 0, webDir, dataDir: alias });
    await recovered.close();
  });

  it('releases the lock when the HTTP port cannot be bound', async () => {
    const firstFixture = fixture('adelic-runtime-port-a-');
    const secondFixture = fixture('adelic-runtime-port-b-');
    const owner = await startServer({ port: 0, webDir: firstFixture.webDir, dataDir: firstFixture.dataDir });
    await expect(startServer({ port: owner.port, webDir: secondFixture.webDir, dataDir: secondFixture.dataDir })).rejects.toThrow();
    const retry = await startServer({ port: 0, webDir: secondFixture.webDir, dataDir: secondFixture.dataDir });
    await Promise.all([owner.close(), retry.close()]);
  });

  it('recovers an abandoned abstract socket after its owning process dies', async () => {
    const { dir, dataDir, webDir } = fixture('adelic-runtime-owner-');
    mkdirSync(dataDir, { recursive: true });
    const runtimeUrl = new URL('../server/runtime.ts', import.meta.url).href;
    const scriptPath = join(dir, 'hold-lock.mjs');
    writeFileSync(scriptPath, `import { startServer } from ${JSON.stringify(runtimeUrl)};\nawait startServer({ port: 0, dataDir: ${JSON.stringify(dataDir)}, webDir: ${JSON.stringify(webDir)} });\nconsole.log('LOCKED');\nsetInterval(() => {}, 1000);\n`);
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    await new Promise<void>((resolveReady, rejectReady) => {
      let output = ''; const timer = setTimeout(() => rejectReady(new Error(`runtime child did not acquire lock: ${output}`)), 10000);
      child.stdout!.on('data', chunk => { output += String(chunk); if (output.includes('LOCKED')) { clearTimeout(timer); resolveReady(); } });
      child.once('error', error => { clearTimeout(timer); rejectReady(error); });
      child.once('exit', code => { if (!output.includes('LOCKED')) { clearTimeout(timer); rejectReady(new Error(`runtime child exited before lock readiness (${code}): ${output}`)); } });
    });
    child.kill('SIGKILL');
    await new Promise<void>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => rejectExit(new Error('runtime child did not exit after SIGKILL')), 10000);
      child.once('exit', () => { clearTimeout(timer); resolveExit(); });
    });
    const recovered = await startServer({ port: 0, dataDir, webDir }); await recovered.close();
  });
});
