import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { schemaVersion } from '../server/migrations.js';
import type { ProviderRegistry } from '../shared/contracts.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  delete process.env.ADELIC_MEMORY_URL;
  delete process.env.ADELIC_MEMORY_TOKEN;
});

describe('GET /api/diagnostics', () => {
  it('reports versions, schema, counts and service status without secrets or content', async () => {
    // Inside the home directory, so the report must show it as "~".
    const dir = mkdtempSync(join(homedir(), '.adelic-diagnostics-test-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Store(dir);
    store.putSession({
      id: 's',
      projectId: null,
      title: 'Conversa secreta',
      providerId: 'codex',
      mode: 'auto',
      createdAt: 'now',
      updatedAt: 'now',
    });
    store.addMessage({
      id: 'm',
      sessionId: 's',
      role: 'user',
      content: 'conteúdo-privado-xyz',
      createdAt: 'now',
    } as never);
    process.env.ADELIC_MEMORY_URL = 'http://127.0.0.1:9';
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'Codex',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'ok',
            models: [{ id: 'm1', name: 'm1' }],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run() {
        return { text: '', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const server: Server = createServer(createBackend(store, providers).app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => {
      server.closeAllConnections();
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const report = JSON.parse(text);
    expect(report.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.data.schema).toEqual({ current: schemaVersion, supported: schemaVersion });
    expect(report.data.counts).toMatchObject({ sessions: 1, messages: 1 });
    expect(report.data.dir.startsWith('~/')).toBe(true);
    expect(report.providers).toEqual([expect.objectContaining({ id: 'codex', status: 'ready', models: 1 })]);
    expect(report.memory).toMatchObject({ url: 'http://127.0.0.1:9', reachable: false });
    for (const forbidden of ['conteúdo-privado-xyz', 'Conversa secreta', homedir()])
      expect(text).not.toContain(forbidden);
  });
});
