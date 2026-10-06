import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startFakeMemory } from './e2e/fake-memory.js';
import type { ProviderRegistry } from '../shared/contracts.js';

// The memory HTTP routes against the simulated ai-memory service.
let base: string, fake: Server, app: Server, dir: string, projectId: string;
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => fetch(base + path);

beforeAll(async () => {
  fake = startFakeMemory(0);
  await new Promise((r) => fake.once('listening', r));
  process.env.ADELIC_MEMORY_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const { createBackend } = await import('../server/index.js');
  const { Store } = await import('../server/store.js');
  dir = mkdtempSync(join(tmpdir(), 'adelic-http-memory-'));
  mkdirSync(join(dir, 'proj'));
  const store = new Store(dir);
  const providers = {
    list: async () => [],
    run: async () => ({ text: '', stopReason: 'completed' }),
    approve: async () => {},
    shutdown: async () => {},
  } as unknown as ProviderRegistry;
  app = createServer(createBackend(store, providers).app);
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const project = await (
    await post('/api/projects', {
      name: 'P',
      path: join(dir, 'proj'),
      memoryWorkspace: 'pessoal',
      memoryProject: 'ambiente-ikaromm',
    })
  ).json();
  projectId = project.id;
});
afterAll(() => {
  app?.closeAllConnections();
  app?.close();
  fake?.close();
  delete process.env.ADELIC_MEMORY_URL;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('memory HTTP routes', () => {
  it('serves the catalog and paginated listings by explicit scope', async () => {
    const catalog = await (await get('/api/memory/catalog')).json();
    expect(catalog.scopes).toEqual(
      expect.arrayContaining([expect.objectContaining({ workspace: 'projetos', project: 'adelic', pageCount: 1 })]),
    );
    const page = await (
      await get('/api/memory/pages?workspace=pessoal&project=ambiente-ikaromm&limit=1&offset=1')
    ).json();
    expect(page).toMatchObject({
      total: 2,
      offset: 1,
      limit: 1,
      pages: [expect.objectContaining({ path: 'configuracoes/rede.md' })],
    });
    expect((await get(`/api/memory/pages?projectId=${projectId}`)).status).toBe(200);
  });
  it('maps service errors to clear statuses', async () => {
    expect((await get('/api/memory/pages?workspace=pessoal&project=nao-existe')).status).toBe(404);
    expect((await get('/api/memory/pages?workspace=pessoal&project=ambiente-ikaromm&limit=500')).status).toBe(400);
    expect((await get('/api/memory/pages?workspace=pessoal')).status).toBe(400);
    expect((await get('/api/memory/pages?projectId=nope')).status).toBe(400);
  });
  it('searches and reads by scope or by project', async () => {
    const hits = await (await get('/api/memory/search?workspace=pessoal&project=ambiente-ikaromm&q=Roteador')).json();
    expect(hits.hits.map((h: { path: string }) => h.path)).toEqual(['configuracoes/rede.md']);
    const byProject = await (await get(`/api/memory/search?projectId=${projectId}&q=Backup`)).json();
    expect(byProject.hits.map((h: { path: string }) => h.path)).toEqual(['configuracoes/backup.md']);
    const note = await (
      await get('/api/memory/page?workspace=pessoal&project=ambiente-ikaromm&path=configuracoes/rede.md')
    ).json();
    expect(note).toMatchObject({ title: 'Rede local', version: expect.any(String) });
    expect((await get(`/api/memory/page?projectId=${projectId}&path=configuracoes/rede.md`)).status).toBe(200);
    expect((await get('/api/memory/page?workspace=pessoal&project=ambiente-ikaromm&path=../x.md')).status).toBe(400);
    expect((await get('/api/memory/page?workspace=pessoal&project=ambiente-ikaromm&path=nao/existe.md')).status).toBe(
      503,
    );
  });
  it('creates, edits with version checks and refuses _global and stale versions', async () => {
    const created = await post('/api/memory/page', {
      workspace: 'pessoal',
      project: 'ambiente-ikaromm',
      path: 'notas/nova.md',
      body: '# Nova\n',
      expectedVersion: null,
    });
    expect(created.status).toBe(200);
    const { version } = await created.json();
    expect(
      (
        await post('/api/memory/page', {
          workspace: 'pessoal',
          project: 'ambiente-ikaromm',
          path: 'notas/nova.md',
          body: 'x',
          expectedVersion: null,
        })
      ).status,
    ).toBe(409);
    const edited = await post('/api/memory/page', {
      workspace: 'pessoal',
      project: 'ambiente-ikaromm',
      path: 'notas/nova.md',
      body: '# Nova\n\neditada\n',
      expectedVersion: version,
    });
    expect(edited.status).toBe(200);
    expect(
      (
        await post('/api/memory/page', {
          workspace: 'pessoal',
          project: 'ambiente-ikaromm',
          path: 'notas/nova.md',
          body: 'y',
          expectedVersion: version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post('/api/memory/page', {
          workspace: 'pessoal',
          project: '_global',
          path: 'a.md',
          body: 'x',
          expectedVersion: null,
        })
      ).status,
    ).toBe(403);
    const legacy = await post('/api/memory/page', { projectId, path: 'notas/legado.md', body: '# Legado\n' });
    expect(legacy.status).toBe(200);
    expect((await post('/api/memory/page', { projectId: 'nope', path: 'a.md', body: 'x' })).status).toBe(400);
  });
});
