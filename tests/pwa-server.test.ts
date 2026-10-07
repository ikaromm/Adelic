import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/runtime.js';

// Installable-app headers (server/http/web.ts) on a fake web build, plus the remote guard:
// the shell stays public on the remote address while /api still needs the token. Remote
// requests come from 127.0.0.2, a loopback address the guard treats as remote.
const TOKEN = 'c'.repeat(40);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const u = new URL(url);
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          localAddress: u.hostname === '127.0.0.2' ? '127.0.0.2' : undefined,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-pwa-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'icons'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(web, 'offline.html'), '<!doctype html><title>offline</title>');
  writeFileSync(join(web, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(web, 'manifest.webmanifest'), '{"name":"Adelic"}');
  writeFileSync(join(web, 'icons/icon-192.png'), 'png');
  const server = await startServer({
    port: 0,
    dataDir: join(dir, 'data'),
    webDir: web,
    remote: { bind: '127.0.0.2', port: 0 as never, token: TOKEN },
  });
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => server.close(),
  );
  return server;
}

describe('installable app files', () => {
  it('serves the worker and manifest with revalidation, scope and MIME type', async () => {
    const server = await start();
    const sw = await get(`${server.url}/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers['content-type']).toMatch(/^text\/javascript/);
    expect(sw.headers['cache-control']).toBe('no-cache');
    expect(sw.headers['service-worker-allowed']).toBe('/');
    const manifest = await get(`${server.url}/manifest.webmanifest`);
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(manifest.headers['cache-control']).toBe('no-cache');
    for (const path of ['/offline.html', '/', '/conversa/123']) {
      const page = await get(`${server.url}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers['cache-control']).toBe('no-cache');
    }
    expect((await get(`${server.url}/icons/icon-192.png`)).headers['service-worker-allowed']).toBeUndefined();
  });

  it('keeps the shell public remotely and /api behind the token', async () => {
    const server = await start();
    const remote = server.remoteUrl!;
    for (const path of ['/', '/sw.js', '/manifest.webmanifest', '/offline.html', '/icons/icon-192.png'])
      expect((await get(`${remote}${path}`)).status, path).toBe(200);
    for (const path of ['/api/bootstrap', '/api/events', '/api/export', '/api/sw.js'])
      expect((await get(`${remote}${path}`)).status, path).toBe(401);
    expect((await get(`${remote}/api/bootstrap`, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    // An unknown API path does not fall through to the SPA shell.
    const unknown = await get(`${server.url}/api/nao-existe`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toContain('Endpoint não encontrado');
  });
});
