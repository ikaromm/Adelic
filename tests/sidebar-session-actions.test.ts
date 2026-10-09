import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store';
import { createBackend } from '../server/index';
import type { ProviderRegistry, Session } from '../shared/contracts';

const servers: Server[] = [];
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(extra: Partial<Session> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-sidebar-actions-'));
  dirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  const providers: ProviderRegistry = {
    list: async () => [
      {
        id: 'codex',
        name: 'Test',
        installed: true,
        available: true,
        status: 'ready',
        detail: '',
        models: [],
        capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: false, images: false },
      },
    ],
    run: async () => ({ text: '', stopReason: 'completed' }),
    approve: async () => {},
    shutdown: async () => {},
  };
  const { app } = createBackend(store, providers);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const now = new Date().toISOString();
  store.putSession({
    id: 'conversation',
    projectId: null,
    title: 'Original',
    providerId: 'codex',
    mode: 'fast',
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  const patch = (body: unknown) =>
    fetch(`${base}/api/sessions/conversation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    });
  return { dir, store, patch };
}
describe('sidebar conversation metadata', () => {
  it('persists pin and rename, preserves first pin time, and unpins without losing history', async () => {
    const { store, dir, patch } = await setup();
    store.addMessage({
      id: 'message',
      sessionId: 'conversation',
      role: 'user',
      content: 'Keep this history',
      status: 'completed',
      createdAt: new Date().toISOString(),
    });
    const response = await patch({ pinned: true, title: 'Renamed' });
    expect(response.status).toBe(200);
    const pinned = await response.json();
    expect(pinned.pinnedAt).toEqual(expect.any(String));
    expect((await (await patch({ pinned: true })).json()).pinnedAt).toBe(pinned.pinnedAt);
    const reopened = new Store(dir);
    stores.push(reopened);
    expect(reopened.getSession('conversation')).toMatchObject({
      pinnedAt: pinned.pinnedAt,
      title: 'Renamed',
      projectId: null,
    });
    expect(reopened.listMessages('conversation')).toHaveLength(1);
    expect((await patch({ pinned: false })).status).toBe(200);
    expect(reopened.getSession('conversation')?.pinnedAt).toBeUndefined();
    expect(reopened.listMessages('conversation')[0].content).toBe('Keep this history');
  });
  it('rejects malformed pin values rather than interpreting strings as true', async () => {
    const { patch, store } = await setup();
    expect((await patch({ pinned: 'yes' })).status).toBe(400);
    expect(store.getSession('conversation')?.pinnedAt).toBeUndefined();
  });
  it('blocks sidebar mutations during an active run', async () => {
    const { patch, store } = await setup({ activeRunId: 'running' });
    for (const change of [{ pinned: true }, { title: 'Changed' }, { archived: true }])
      expect((await patch(change)).status).toBe(409);
    expect(store.getSession('conversation')).toMatchObject({ title: 'Original', activeRunId: 'running' });
    expect(store.getSession('conversation')?.pinnedAt).toBeUndefined();
  });
});
