// Integration with a REAL ai-memory server, isolated in a temporary data dir with a
// bearer token (the Docker-style setup). Skipped unless an ai-memory binary is found:
// AI_MEMORY_BIN, or `ai-memory` on PATH. CI downloads a pinned, checksum-verified release.
// Notes with metadata no writer can reproduce are covered by tests/memory-mcp.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function findBinary() {
  if (process.env.AI_MEMORY_BIN) return process.env.AI_MEMORY_BIN;
  const found = spawnSync('sh', ['-c', 'command -v ai-memory'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : undefined;
}
const binary = findBinary();
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe.skipIf(!binary)('ai-memory service integration (real server)', () => {
  const scope = { workspace: 'qa', project: 'notas' };
  const token = 'adelic-integration-token-0123456789abcdef';
  let dir: string, url: string, child: ChildProcess;
  let memory: typeof import('../server/memory.js');
  let service: typeof import('../server/memory-service.js');
  const admin = async (body: Record<string, unknown>) => {
    const response = await fetch(`${url}/admin/write-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspace: 'qa', project: 'notas', tier: 'semantic', tags: [], pinned: false, ...body }),
    });
    if (!response.ok) throw new Error(`seed failed: ${response.status} ${await response.text()}`);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adelic-aimemory-'));
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    const env = { ...process.env, AI_MEMORY_DATA_DIR: dir, AI_MEMORY_AUTH_TOKEN: token, AI_MEMORY_SERVER_URL: url };
    writeFileSync(join(dir, 'config.toml'), `[server]\nbind = "127.0.0.1:${port}"\n`);
    spawnSync(binary!, ['--data-dir', dir, 'init'], { env, stdio: 'ignore' });
    child = spawn(
      binary!,
      ['--data-dir', dir, 'serve', '--transport', 'http', '--bind', `127.0.0.1:${port}`, '--enable-web'],
      { env, stdio: ['ignore', 'ignore', process.env.AI_MEMORY_DEBUG ? 'inherit' : 'ignore'] },
    );
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${url}/admin/status`, { headers: { authorization: `Bearer ${token}` } })).ok) break;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    process.env.ADELIC_MEMORY_URL = url;
    process.env.ADELIC_MEMORY_TOKEN = token;
    memory = await import('../server/memory.js');
    service = await import('../server/memory-service.js');
    await admin({
      path: 'decisoes/fato.md',
      body: '# Fato\n\ncorpo original\n',
      kind: 'fact',
      tier: 'procedural',
      tags: ['qa', 'docker'],
      pinned: true,
      title: 'Fato QA',
    });
    await admin({ path: 'decisoes/simples.md', body: '# Simples\n\ncorpo\n' });
    await admin({ workspace: 'qa', project: 'outro', path: 'x.md', body: '# X\n' });
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    delete process.env.ADELIC_MEMORY_URL;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('lists scopes, counts and notes from the service', async () => {
    const catalog = await service.memoryCatalog();
    expect(catalog.scopes).toEqual(
      expect.arrayContaining([
        { workspace: 'qa', project: 'notas', pageCount: 2 },
        { workspace: 'qa', project: 'outro', pageCount: 1 },
      ]),
    );
    const list = await service.memoryList(scope, 0, 50);
    expect(list.pages.map((p) => p.path)).toEqual(['decisoes/fato.md', 'decisoes/simples.md']);
    expect((await memory.sharedMemorySearch(scope, 'original')).map((h) => h.path)).toContain('decisoes/fato.md');
  });

  it('edits through the service preserving every metadata field', async () => {
    const before = await memory.sharedMemoryRead(scope, 'decisoes/fato.md');
    const saved = await memory.sharedMemoryWrite(scope, 'decisoes/fato.md', '# Fato\n\neditado\n', before.version);
    expect(saved.body).toBe('# Fato\n\neditado\n');
    const strip = (fm: Record<string, unknown> = {}) => ({ ...fm, generated: undefined });
    expect(strip(saved.frontmatter)).toEqual(strip(before.frontmatter));
    expect(saved.frontmatter).toMatchObject({ kind: 'fact', tier: 'procedural', pinned: true, tags: ['qa', 'docker'] });
  });

  it('conflicts on an external change and keeps it', async () => {
    const version = (await memory.sharedMemoryRead(scope, 'decisoes/simples.md')).version;
    await admin({ path: 'decisoes/simples.md', body: '# Simples\n\nexterno\n' });
    await expect(memory.sharedMemoryWrite(scope, 'decisoes/simples.md', 'rascunho', version)).rejects.toMatchObject({
      status: 409,
    });
    expect((await memory.sharedMemoryRead(scope, 'decisoes/simples.md')).body).toContain('externo');
  });

  it('creates new notes and refuses to create over an existing path', async () => {
    expect((await memory.sharedMemoryWrite(scope, 'notes/nova.md', '# Nova\n', null)).body).toBe('# Nova\n');
    await expect(memory.sharedMemoryWrite(scope, 'decisoes/fato.md', 'x', null)).rejects.toMatchObject({ status: 409 });
  });
});
