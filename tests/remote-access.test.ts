import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteAccessFromEnv } from '../server/http/auth.js';
import { startServer, type RunningServer, type StartServerOptions } from '../server/runtime.js';

// Remote access is exercised on 127.0.0.2: a loopback address the guard does NOT treat as
// local, so these tests cover the remote path without exposing anything on the network.
const TOKEN = 'a'.repeat(20) + 'b'.repeat(20);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Raw HTTP so the client can bind 127.0.0.2 as its source address. */
function call(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>(
    (resolve, reject) => {
      const u = new URL(url);
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: init.method ?? 'GET',
          localAddress: u.hostname === '127.0.0.2' ? '127.0.0.2' : undefined,
          headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...init.headers },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    },
  );
}

async function start(remote: StartServerOptions['remote']) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-remote-'));
  const server: RunningServer = await startServer({ port: 0, dataDir: dir, remote });
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => server.close(),
  );
  return server;
}

describe('remote access configuration', () => {
  it('is off unless explicitly configured, and refuses weak or wildcard settings', () => {
    expect(remoteAccessFromEnv({})).toBeUndefined();
    expect(() => remoteAccessFromEnv({ ADELIC_REMOTE_BIND: '100.64.0.1' })).toThrow(/ADELIC_REMOTE_TOKEN/);
    expect(() => remoteAccessFromEnv({ ADELIC_REMOTE_BIND: '100.64.0.1', ADELIC_REMOTE_TOKEN: 'short' })).toThrow(
      /32 caracteres/,
    );
    for (const bind of ['0.0.0.0', '::', 'meu-host'])
      expect(() => remoteAccessFromEnv({ ADELIC_REMOTE_BIND: bind, ADELIC_REMOTE_TOKEN: TOKEN })).toThrow(
        /endereço IP/,
      );
    expect(remoteAccessFromEnv({ ADELIC_REMOTE_BIND: '100.64.0.1', ADELIC_REMOTE_TOKEN: TOKEN })).toEqual({
      bind: '100.64.0.1',
      port: 4318,
      token: TOKEN,
    });
  });
});

describe('remote access server', () => {
  it('does not listen remotely by default', async () => {
    const server = await start(null);
    expect(server.remoteUrl).toBeUndefined();
    expect((await call(`${server.url}/api/health`)).status).toBe(200);
  });

  it('requires the token remotely while loopback keeps working without it', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    // Port 0 is never valid from the environment; here it lets the test pick a free port.
    expect(server.remoteUrl).toMatch(/^http:\/\/127\.0\.0\.2:\d+$/);
    const remote = server.remoteUrl!;
    expect((await call(`${server.url}/api/health`)).status).toBe(200);
    expect((await call(`${remote}/api/health`)).status).toBe(401);
    expect((await call(`${remote}/api/bootstrap`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await call(`${remote}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    // The UI shell loads so the login screen can render; data stays protected.
    expect((await call(`${remote}/api/auth/status`)).body).toBe('{"remote":true,"authenticated":false}');
  });

  it('logs in with an HttpOnly SameSite=Strict cookie and blocks cross-site cookie mutations', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    const remote = server.remoteUrl!;
    expect((await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: 'wrong' } })).status).toBe(401);
    const login = await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: TOKEN } });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const session = cookie.split(';')[0];
    expect((await call(`${remote}/api/bootstrap`, { headers: { cookie: session } })).status).toBe(200);
    const host = new URL(remote).host;
    const mutate = (origin?: string) =>
      call(`${remote}/api/settings`, {
        method: 'PATCH',
        headers: { cookie: session, host, ...(origin ? { origin } : {}) },
        body: { memoryEnabled: false },
      });
    expect((await mutate('http://evil.example')).status).toBe(403);
    expect((await mutate()).status).toBe(403);
    expect((await mutate(`http://${host}`)).status).toBe(200);
    const logout = await call(`${remote}/api/auth/logout`, { method: 'POST', headers: { cookie: session }, body: {} });
    expect(String(logout.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });

  it('limits failed logins and protects the event stream and export', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    const remote = server.remoteUrl!;
    for (let i = 0; i < 5; i++)
      expect((await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: `x${i}` } })).status).toBe(401);
    expect((await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: TOKEN } })).status).toBe(429);
    expect((await call(`${remote}/api/export`)).status).toBe(401);
    expect((await call(`${remote}/api/events`)).status).toBe(401);
  });

  it('keeps refusing foreign Host headers on loopback', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    expect((await call(`${server.url}/api/health`, { headers: { host: 'evil.example' } })).status).toBe(403);
  });
});
