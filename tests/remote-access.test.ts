import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import {
  classifyRequest,
  funnelPortFromEnv,
  guardPath,
  remoteAccessFromEnv,
  type RequestFacts,
} from '../server/http/auth.js';
import { startServer, type RunningServer, type StartServerOptions } from '../server/runtime.js';
import {
  LoginLimiter,
  RemoteAccounts,
  SCRYPT_PARAMS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  boundedText,
  cleanIp,
  hashPassword,
  verifyPassword,
} from '../server/remote-auth.js';
import { migrate } from '../server/migrations.js';
import {
  FunnelService,
  explainTailscaleError,
  funnelOffArgs,
  funnelOnArgs,
  parseCapabilities,
  type TailscaleRunner,
} from '../server/funnel.js';
import { runRemoteUserCli } from '../server/remote-user-cli.js';
import { LOGIN_FAILED, passwordHints, passwordProblems, usernameProblem } from '../shared/remote-access.js';

// Remote access is exercised on 127.0.0.2 (tailnet listener: a loopback address the guard does
// NOT treat as local) and on the Funnel listener (127.0.0.1, ephemeral port, always internet),
// so nothing is exposed on the network. The real `tailscale` is never called.
const TOKEN = 'a'.repeat(20) + 'b'.repeat(20);
const PASSWORD = 'correct horse battery';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-remote-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

type Reply = { status: number; body: string; headers: Record<string, string | string[] | undefined> };
/** Raw HTTP so the client can bind 127.0.0.2 as its source address and send any header. */
function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        localAddress: u.hostname === '127.0.0.2' ? '127.0.0.2' : undefined,
        headers: {
          ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...init.headers,
        },
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
  });
}
const json = (reply: Reply) => JSON.parse(reply.body);
const sessionCookie = (reply: Reply) => String(reply.headers['set-cookie']).split(';')[0];

/** A fake `tailscale` CLI: records calls, answers from a mutable serve config. */
function fakeTailscale(options: { caps?: string[]; failOn?: string; dns?: string } = {}) {
  const calls: string[][] = [];
  const dns = options.dns ?? 'casa.exemplo.ts.net';
  let serve: Record<string, unknown> = {};
  const run: TailscaleRunner = async (args) => {
    calls.push(args);
    if (options.failOn && args.join(' ').includes(options.failOn))
      throw Object.assign(new Error('exit 1'), { stderr: 'Funnel not available; "funnel" node attribute not set.' });
    if (args[0] === 'version') return { stdout: '1.102.3\n', stderr: '' };
    if (args[0] === 'status')
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: {
            DNSName: `${dns}.`,
            CapMap: Object.fromEntries((options.caps ?? ['https', 'funnel']).map((c) => [c, null])),
          },
        }),
        stderr: '',
      };
    if (args.join(' ') === 'funnel status --json') return { stdout: JSON.stringify(serve), stderr: '' };
    if (args[0] === 'funnel' && args.at(-1) === 'off') {
      serve = {};
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'funnel') {
      const target = args.at(-1)!;
      serve = {
        Web: { [`${dns}:443`]: { Handlers: { '/': { Proxy: target } } } },
        AllowFunnel: { [`${dns}:443`]: true },
      };
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { run, calls, setServe: (value: Record<string, unknown>) => (serve = value) };
}

async function start(
  remote: StartServerOptions['remote'],
  extra: Partial<StartServerOptions> = {},
): Promise<RunningServer & { funnel: string }> {
  const dir = tempDir();
  const fake = fakeTailscale();
  const server = await startServer({
    port: 0,
    dataDir: dir,
    remote,
    // 0 = any free port; the listener starts on demand.
    funnelPort: 0,
    funnelService: new FunnelService(fake.run),
    ...extra,
  });
  cleanup.push(() => server.close());
  return Object.assign(server, { funnel: '' });
}
/** Creates the owner account from this computer. */
async function createAccount(server: RunningServer, username = 'dono', password = PASSWORD) {
  return call(`${server.url}/api/remote-access/account`, { method: 'PUT', body: { username, password } });
}
/** Starts the Funnel listener (via the local "Publicar" with the fake CLI) and returns its URL. */
async function funnelUrl(server: RunningServer) {
  const enabled = await call(`${server.url}/api/remote-access/funnel`, { method: 'PUT', body: { enabled: true } });
  expect(enabled.status).toBe(200);
  return server.funnelUrl!()!;
}
const origin = (url: string) => ({ origin: url, host: new URL(url).host });
async function login(url: string, username = 'dono', password = PASSWORD, headers: Record<string, string> = {}) {
  return call(`${url}/api/auth/login`, { method: 'POST', body: { username, password }, headers });
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

  it('reads the Funnel listener port, 4319 by default', () => {
    expect(funnelPortFromEnv({})).toBe(4319);
    expect(funnelPortFromEnv({ ADELIC_FUNNEL_PORT: '4555' })).toBe(4555);
    for (const bad of ['0', '70000', 'abc', '1.5'])
      expect(() => funnelPortFromEnv({ ADELIC_FUNNEL_PORT: bad })).toThrow();
  });
});

describe('request classification', () => {
  const facts = (over: Partial<RequestFacts>): RequestFacts => ({
    remoteAddress: '127.0.0.1',
    localPort: 4317,
    listener: 'local',
    headers: {},
    ...over,
  });
  const kind = (over: Partial<RequestFacts>) => classifyRequest(facts(over), { funnelPort: 4319 }).kind;

  it('trusts only a loopback socket without proxy headers', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      expect(kind({ remoteAddress: address })).toBe('local');
    expect(classifyRequest(facts({}))).toMatchObject({ kind: 'local', ip: '127.0.0.1', https: false });
    // Unrelated headers do not change anything.
    expect(kind({ headers: { 'user-agent': 'x', cookie: 'a=b' } })).toBe('local');
  });

  it('treats the Funnel listener (by role or by port) as internet whatever the headers say', () => {
    expect(kind({ listener: 'funnel', localPort: 5555 })).toBe('internet');
    expect(kind({ listener: undefined, localPort: 4319 })).toBe('internet');
    for (const headers of [{}, { 'tailscale-user-login': 'me@example.com' }, { 'x-forwarded-for': '127.0.0.1' }])
      expect(classifyRequest(facts({ listener: 'funnel', headers }))).toMatchObject({ kind: 'internet', https: true });
  });

  it('classifies Funnel and unknown proxies on loopback as internet (fail closed)', () => {
    const funnel = classifyRequest(
      facts({ headers: { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' } }),
    );
    expect(funnel).toMatchObject({ kind: 'internet', ip: '203.0.113.9', https: true, via: 'funnel' });
    // The Funnel marker wins over a (spoofed) identity header.
    expect(kind({ headers: { 'tailscale-funnel-request': '?1', 'tailscale-user-login': 'me@x' } })).toBe('internet');
    for (const name of ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'via'])
      expect(classifyRequest(facts({ headers: { [name]: '198.51.100.1' } }))).toMatchObject({
        kind: 'internet',
        via: 'proxy',
        // Without serve or Funnel the forwarded address is not believed.
        ip: '127.0.0.1',
      });
  });

  it('accepts tailscale serve identity on loopback as tailnet, with its forwarded client', () => {
    const serve = classifyRequest(
      facts({
        headers: {
          'tailscale-user-login': 'me@example.com',
          'x-forwarded-for': '100.64.0.7',
          'x-forwarded-proto': 'https',
        },
      }),
    );
    expect(serve).toMatchObject({ kind: 'tailnet', ip: '100.64.0.7', https: true, via: 'serve' });
    // The identity header from a non-loopback socket proves nothing.
    expect(kind({ remoteAddress: '192.168.0.5', listener: undefined, headers: { 'tailscale-user-login': 'x' } })).toBe(
      'internet',
    );
  });

  it('classifies the tailnet listener as tailnet, and a proxy in front of it as internet', () => {
    expect(classifyRequest(facts({ remoteAddress: '100.64.0.9', listener: 'tailnet' }))).toMatchObject({
      kind: 'tailnet',
      ip: '100.64.0.9',
      https: false,
    });
    expect(kind({ remoteAddress: '100.64.0.9', listener: 'tailnet', headers: { 'x-forwarded-for': '1.2.3.4' } })).toBe(
      'internet',
    );
    // Any other socket (no listener role) is internet.
    expect(kind({ remoteAddress: '10.0.0.3', listener: undefined })).toBe('internet');
  });

  it('normalizes paths the way the router matches them', () => {
    expect(guardPath('/API//Export/')).toBe('/api/export');
    expect(guardPath('/%61pi/x')).toBe('/api/x');
    expect(guardPath('/%E0%A4%A')).toBe('/%e0%a4%a');
    expect(guardPath('/')).toBe('/');
  });

  it('cleans forwarded addresses and request text', () => {
    expect(cleanIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(cleanIp('not-an-ip')).toBe('desconhecido');
    expect(
      classifyRequest(facts({ headers: { 'tailscale-funnel-request': '?1', 'x-forwarded-for': 'junk' } })).ip,
    ).toBe('127.0.0.1');
    expect(boundedText('a\nb\u0000c', 10)).toBe('a b c');
    expect(boundedText(42, 10)).toBe('');
  });
});

describe('passwords and policy', () => {
  it('hashes with scrypt (parameters stored with the hash) and verifies in constant time', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatchObject({ algo: 'scrypt', N: 2 ** 15, r: 8, p: 1, keylen: 64 });
    expect(SCRYPT_PARAMS.N).toBe(32768);
    expect(Buffer.from(hash.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(hash.hash, 'base64')).toHaveLength(64);
    expect(JSON.stringify(hash)).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, hash)).toBe(false);
    // Two hashes of the same password differ (random salt).
    expect((await hashPassword(PASSWORD)).hash).not.toBe(hash.hash);
    // Malformed or abusive stored parameters never match.
    expect(await verifyPassword(PASSWORD, { ...hash, algo: 'md5' as 'scrypt' })).toBe(false);
    expect(await verifyPassword(PASSWORD, { ...hash, N: 2 ** 24 })).toBe(false);
    expect(await verifyPassword('x'.repeat(300), hash)).toBe(false);
  });

  it('enforces the username and password policy and offers strength hints', () => {
    expect(usernameProblem('dono')).toBeUndefined();
    expect(usernameProblem('a.b_c-9')).toBeUndefined();
    for (const bad of ['ab', 'Dono', 'com espaço', 'x'.repeat(65), 'ação']) expect(usernameProblem(bad)).toBeTruthy();
    expect(passwordProblems('dono', PASSWORD)).toEqual([]);
    expect(passwordProblems('dono', 'curta')).toEqual(['A senha deve ter pelo menos 12 caracteres.']);
    expect(passwordProblems('donodonodono', 'DonoDonoDono')).toEqual(['A senha não pode ser igual ao usuário.']);
    expect(passwordProblems('dono', 'x'.repeat(300))[0]).toMatch(/no máximo/);
    expect(passwordHints('aaaaaaaaaaaa')).toMatchObject({ score: 1 });
    expect(passwordHints('aaaaaaaaaaaa').hints.join(' ')).toMatch(/repetir/);
    expect(passwordHints('Uma frase longa, com 5 palavras!')).toEqual({ score: 3, hints: [] });
    expect(passwordHints('123senha').score).toBe(0);
  });
});

describe('accounts and sessions', () => {
  function accounts(now: { t: number }) {
    const db = new DatabaseSync(':memory:');
    migrate(db, tempDir());
    cleanup.push(() => db.close());
    return { db, accounts: new RemoteAccounts(db, () => now.t) };
  }
  const ctx = { kind: 'internet' as const, ip: '203.0.113.5', userAgent: 'Firefox' };

  it('stores only the SHA-256 of the session cookie and enforces idle and absolute expiry', async () => {
    const now = { t: Date.parse('2026-01-01T00:00:00Z') };
    const { db, accounts: a } = accounts(now);
    await a.setAccount('dono', PASSWORD);
    const { token } = a.createSession('owner', 'password', ctx);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const rows = db.prepare('SELECT id, data FROM remote_sessions').all() as { id: string; data: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(a.validate(token, ctx)).toBeTruthy();
    expect(a.validate(`${token}x`, ctx)).toBeUndefined();
    expect(a.validate(undefined, ctx)).toBeUndefined();
    // Activity within the idle window keeps it alive, up to the absolute limit.
    for (let day = 1; day <= 29; day += 6) {
      now.t += 6 * 24 * 3600_000;
      expect(a.validate(token, ctx)).toBeTruthy();
    }
    now.t = Date.parse('2026-01-01T00:00:00Z') + SESSION_ABSOLUTE_MS + 1;
    expect(a.validate(token, ctx)).toBeUndefined();
    expect(a.listSessions()).toEqual([]);
    // Idle: 7 days without a request.
    const idle = a.createSession('owner', 'password', ctx).token;
    now.t += SESSION_IDLE_MS + 1;
    expect(a.validate(idle, ctx)).toBeUndefined();
  });

  it('lists, revokes one or all, and a new password ends every session', async () => {
    const now = { t: Date.now() };
    const { accounts: a } = accounts(now);
    await a.setAccount('dono', PASSWORD);
    const first = a.createSession('owner', 'password', ctx);
    const second = a.createSession('owner', 'password', { ...ctx, userAgent: 'Phone' });
    expect(
      a
        .listSessions()
        .map((s) => s.userAgent)
        .sort(),
    ).toEqual(['Firefox', 'Phone']);
    expect(a.revokeSession(first.publicId)).toBeTruthy();
    expect(a.validate(first.token, ctx)).toBeUndefined();
    expect(a.validate(second.token, ctx)).toBeTruthy();
    expect(a.revokeSession('nope')).toBeUndefined();
    await a.setAccount('dono', 'outra senha bem longa');
    expect(a.validate(second.token, ctx)).toBeUndefined();
    expect(await a.checkPassword('dono', PASSWORD)).toBe(false);
    expect(await a.checkPassword('dono', 'outra senha bem longa')).toBe(true);
    a.createSession('owner', 'password', ctx);
    expect(a.revokeAll()).toBe(1);
    // Deleting the account ends sessions and logins fail the same way.
    const kept = a.createSession('owner', 'password', ctx);
    a.deleteAccount();
    expect(a.validate(kept.token, ctx)).toBeUndefined();
    expect(await a.checkPassword('dono', 'outra senha bem longa')).toBe(false);
    await expect(a.setAccount('dono', 'curta')).rejects.toThrow(/12 caracteres/);
  });

  it('refuses legacy token sessions outside the tailnet', async () => {
    const { accounts: a } = accounts({ t: Date.now() });
    const { token } = a.createSession('legacy-token', 'token', { ...ctx, kind: 'tailnet' });
    expect(a.validate(token, { ...ctx, kind: 'tailnet' })).toBeTruthy();
    expect(a.validate(token, ctx)).toBeUndefined();
  });

  it('keeps a bounded, sanitized login log', () => {
    const { accounts: a } = accounts({ t: Date.now() });
    for (let i = 0; i < 205; i++)
      a.recordLogin({ ok: false, kind: 'internet', username: `x<script>${i}`, ip: '1.2.3.4', userAgent: 'u' });
    const logins = a.listLogins(500);
    expect(logins).toHaveLength(200);
    expect(logins[0].username).toBe('x?script?204');
  });
});

describe('login limits', () => {
  it('blocks an address after 5 failures per minute and backs off globally without a lockout', async () => {
    const now = { t: 0 };
    const slept: number[] = [];
    const limiter = new LoginLimiter({ now: () => now.t, sleep: async (ms) => void slept.push(ms) });
    for (let i = 0; i < 5; i++) limiter.fail('1.1.1.1');
    expect(limiter.blocked('1.1.1.1')).toBe(true);
    expect(limiter.blocked('2.2.2.2')).toBe(false);
    now.t += 61_000;
    expect(limiter.blocked('1.1.1.1')).toBe(false);
    // Global: 20 free failures in 10 minutes, then 250 ms doubling up to 30 s.
    for (let i = 0; i < 15; i++) limiter.fail(`10.0.0.${i}`);
    expect(limiter.delayMs()).toBe(250);
    limiter.fail('10.0.1.1');
    expect(limiter.delayMs()).toBe(500);
    for (let i = 0; i < 30; i++) limiter.fail(`10.0.2.${i}`);
    expect(limiter.delayMs()).toBe(30_000);
    expect(await limiter.throttle()).toBe(30_000);
    expect(slept).toEqual([30_000]);
    // Never permanent: ten minutes later the delay is gone.
    now.t += 600_001;
    expect(limiter.delayMs()).toBe(0);
    // A reserved attempt counts at once; a success removes it again.
    const attempt = limiter.reserve('3.3.3.3');
    expect(limiter.delayMs()).toBe(0);
    attempt.settle(true);
    attempt.settle(false);
    expect(limiter.blocked('3.3.3.3')).toBe(false);
  });
});

describe('remote access server (tailnet listener)', () => {
  it('does not listen remotely by default, and the Funnel listener only starts on request', async () => {
    const server = await start(null);
    expect(server.remoteUrl).toBeUndefined();
    expect(server.funnelUrl!()).toBeUndefined();
    expect((await call(`${server.url}/api/health`)).status).toBe(200);
  });

  it('keeps the legacy token on the tailnet while loopback works without it', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    // Port 0 is never valid from the environment; here it lets the test pick a free port.
    expect(server.remoteUrl).toMatch(/^http:\/\/127\.0\.0\.2:\d+$/);
    const remote = server.remoteUrl!;
    expect((await call(`${server.url}/api/health`)).status).toBe(200);
    expect((await call(`${remote}/api/health`)).status).toBe(401);
    expect((await call(`${remote}/api/bootstrap`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await call(`${remote}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    // The UI shell loads so the login screen can render; data stays protected.
    expect(json(await call(`${remote}/api/auth/status`))).toEqual({
      remote: true,
      authenticated: false,
      kind: 'tailnet',
      login: 'token',
      token: true,
    });
  });

  it('logs in with the token into a hashed session cookie and blocks cross-site mutations', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    const remote = server.remoteUrl!;
    expect((await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: 'wrong' } })).status).toBe(401);
    const loggedIn = await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: TOKEN } });
    expect(loggedIn.status).toBe(200);
    const cookie = String(loggedIn.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    // Plain HTTP on the tailnet listener: no Secure flag (the browser would drop the cookie).
    expect(cookie).not.toMatch(/Secure/);
    // The cookie is a random session id, never the token itself.
    expect(cookie).not.toContain(TOKEN);
    const session = sessionCookie(loggedIn);
    expect((await call(`${remote}/api/bootstrap`, { headers: { cookie: session } })).status).toBe(200);
    const host = new URL(remote).host;
    const mutate = (headers: Record<string, string>) =>
      call(`${remote}/api/settings`, {
        method: 'PATCH',
        headers: { cookie: session, host, ...headers },
        body: { memoryEnabled: false },
      });
    expect((await mutate({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await mutate({})).status).toBe(403);
    expect((await mutate({ origin: `http://${host}`, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await mutate({ origin: `http://${host}` })).status).toBe(200);
    const logout = await call(`${remote}/api/auth/logout`, { method: 'POST', headers: { cookie: session }, body: {} });
    expect(String(logout.headers['set-cookie'])).toMatch(/Max-Age=0/);
    // Logout deletes the session on the server too.
    expect((await call(`${remote}/api/bootstrap`, { headers: { cookie: session } })).status).toBe(401);
  });

  it('limits failed logins per address and protects the event stream and export', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    const remote = server.remoteUrl!;
    for (let i = 0; i < 5; i++)
      expect((await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: `x${i}` } })).status).toBe(401);
    expect((await call(`${remote}/api/auth/login`, { method: 'POST', body: { token: TOKEN } })).status).toBe(429);
    expect((await call(`${remote}/api/export`)).status).toBe(401);
    expect((await call(`${remote}/api/events`)).status).toBe(401);
    // The failures appear in "Últimos acessos" (local only).
    const state = json(await call(`${server.url}/api/remote-access`));
    expect(state.logins.filter((l: { ok: boolean }) => !l.ok)).toHaveLength(6);
    expect(state.logins[0]).toMatchObject({ reason: 'rate-limit', kind: 'tailnet', ip: '127.0.0.2' });
  });

  it('keeps refusing foreign Host headers and proxy headers on loopback', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    expect((await call(`${server.url}/api/health`, { headers: { host: 'evil.example' } })).status).toBe(403);
    // A reverse proxy on this computer is not "local": login required, no account → 401.
    expect((await call(`${server.url}/api/health`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status).toBe(
      401,
    );
    expect(
      json(await call(`${server.url}/api/auth/status`, { headers: { 'tailscale-funnel-request': '?1' } })),
    ).toEqual({
      remote: true,
      authenticated: false,
      kind: 'internet',
      login: 'unavailable',
      token: false,
    });
  });

  it('uses the account on the tailnet when one exists, and serve identity counts as tailnet', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    expect((await createAccount(server)).status).toBe(200);
    const remote = server.remoteUrl!;
    expect(json(await call(`${remote}/api/auth/status`))).toMatchObject({ login: 'password', token: true });
    const ok = await login(remote);
    expect(ok.status).toBe(200);
    expect((await call(`${remote}/api/bootstrap`, { headers: { cookie: sessionCookie(ok) } })).status).toBe(200);
    // tailscale serve on loopback: tailnet, HTTPS-terminated, so Secure + HSTS.
    const serve = {
      'tailscale-user-login': 'me@example.com',
      'x-forwarded-for': '100.64.0.8',
      'x-forwarded-proto': 'https',
    };
    const viaServe = await login(server.url, 'dono', PASSWORD, serve);
    expect(viaServe.status).toBe(200);
    expect(String(viaServe.headers['set-cookie'])).toMatch(/; Secure/);
    expect(viaServe.headers['strict-transport-security']).toBe('max-age=31536000');
    // The legacy Bearer token also works through serve (tailnet).
    expect(
      (await call(`${server.url}/api/health`, { headers: { ...serve, authorization: `Bearer ${TOKEN}` } })).status,
    ).toBe(200);
  });
});

describe('internet access (Funnel listener)', () => {
  it('answers errors in the language the client asks for (Accept-Language or ?lang=), pt-BR otherwise', async () => {
    const server = await start(null);
    const refused = await call(`${server.url}/api/remote-access/funnel`, {
      method: 'PUT',
      body: { enabled: true },
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    });
    expect([refused.status, json(refused).error]).toEqual([
      409,
      'Create the username and password before publishing to the internet.',
    ]);
    expect((await createAccount(server)).status).toBe(200);
    const funnel = await funnelUrl(server);
    const english = await login(funnel, 'dono', 'senha errada mesmo', { 'accept-language': 'en' });
    expect([english.status, json(english).error]).toEqual([401, 'Incorrect username or password']);
    const portuguese = await login(funnel, 'dono', 'senha errada mesmo', { 'accept-language': 'fr, pt;q=0.5' });
    expect(json(portuguese).error).toBe(LOGIN_FAILED);
    const unsupported = await login(funnel, 'dono', 'senha errada mesmo', { 'accept-language': 'fr' });
    expect(json(unsupported).error).toBe(LOGIN_FAILED);
    const guarded = await call(`${funnel}/api/bootstrap?lang=en`);
    expect([guarded.status, json(guarded).error]).toEqual([401, 'Authentication required']);
    // The generic 404 of server/index.ts is a catalog key too.
    const notFound = await call(`${server.url}/api/nothing-here`, { headers: { 'accept-language': 'en' } });
    expect(json(notFound).error).toBe('Endpoint not found');
  });

  it('requires the account: no login without it, and Funnel cannot be enabled before it exists', async () => {
    const server = await start(null);
    const refused = await call(`${server.url}/api/remote-access/funnel`, { method: 'PUT', body: { enabled: true } });
    expect(refused.status).toBe(409);
    expect(json(refused).error).toMatch(/usuário e a senha/);
    expect(server.funnelUrl!()).toBeUndefined();
  });

  it('logs in with username and password, generic errors, Secure cookie, HSTS and the session list', async () => {
    const server = await start(null);
    expect((await createAccount(server)).status).toBe(200);
    const funnel = await funnelUrl(server);
    const forwarded = { 'x-forwarded-for': '198.51.100.20', 'tailscale-funnel-request': '?1', 'user-agent': 'Celular' };
    const status = json(await call(`${funnel}/api/auth/status`, { headers: forwarded }));
    expect(status).toEqual({ remote: true, authenticated: false, kind: 'internet', login: 'password', token: false });
    expect((await call(`${funnel}/api/bootstrap`)).status).toBe(401);
    const wrongPassword = await login(funnel, 'dono', 'senha errada mesmo', forwarded);
    const wrongUser = await login(funnel, 'outro', PASSWORD, forwarded);
    expect([wrongPassword.status, wrongUser.status]).toEqual([401, 401]);
    expect(json(wrongPassword).error).toBe(LOGIN_FAILED);
    expect(json(wrongUser).error).toBe(LOGIN_FAILED);
    const ok = await login(funnel, 'dono', PASSWORD, forwarded);
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(
      /^adelic_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure$/,
    );
    expect(ok.headers['strict-transport-security']).toBe('max-age=31536000');
    const session = sessionCookie(ok);
    expect(json(await call(`${funnel}/api/auth/status`, { headers: { cookie: session } }))).toMatchObject({
      authenticated: true,
      username: 'dono',
    });
    const listed = json(await call(`${funnel}/api/remote-access`, { headers: { cookie: session } }));
    expect(listed.kind).toBe('internet');
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      kind: 'internet',
      ip: '198.51.100.20',
      userAgent: 'Celular',
      current: true,
    });
    expect(listed.logins.slice(0, 3).map((l: { ok: boolean }) => l.ok)).toEqual([true, false, false]);
    // Logout from the internet ends the session.
    const out = await call(`${funnel}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: session, ...origin(funnel) },
      body: {},
    });
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0; Secure/);
    expect((await call(`${funnel}/api/bootstrap`, { headers: { cookie: session } })).status).toBe(401);
  });

  it('never accepts the Bearer token from the internet, nor a tailnet session', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    await createAccount(server);
    const funnel = await funnelUrl(server);
    expect((await call(`${funnel}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    expect((await call(`${funnel}/api/auth/login`, { method: 'POST', body: { token: TOKEN } })).status).toBe(401);
    const tokenLogin = await call(`${server.remoteUrl}/api/auth/login`, { method: 'POST', body: { token: TOKEN } });
    expect((await call(`${funnel}/api/health`, { headers: { cookie: sessionCookie(tokenLogin) } })).status).toBe(401);
  });

  it('refuses credentials, Funnel, terminal, MCP, automations, hooks, git push and remote settings', async () => {
    const server = await start({ bind: '127.0.0.2', port: 0 as never, token: TOKEN });
    await createAccount(server);
    const funnel = await funnelUrl(server);
    const project = tempDir();
    const created = json(
      await call(`${server.url}/api/projects`, {
        method: 'POST',
        body: { name: 'P', path: project, memoryWorkspace: 'w', memoryProject: 'p' },
      }),
    );
    const as = async (url: string) => {
      const ok = await login(url);
      const cookie = sessionCookie(ok);
      return (method: string, path: string, body?: unknown) =>
        call(`${url}${path}`, { method, headers: { cookie, ...origin(url) }, body });
    };
    const internet = await as(funnel);
    const tailnet = await as(server.remoteUrl!);
    const id = created.id as string;
    const localOnly: [string, string, unknown?][] = [
      ['PUT', '/api/remote-access/account', { username: 'dono', password: 'nova senha bem longa' }],
      ['DELETE', '/api/remote-access/account', {}],
      ['PUT', '/api/remote-access/funnel', { enabled: false }],
      ['GET', '/api/remote-access/tailscale'],
      ['PATCH', '/api/settings', { terminalRemote: true }],
      ['PATCH', '/api/settings', { internetManualApproval: false }],
    ];
    for (const [method, path, body] of localOnly) {
      expect((await internet(method, path, body)).status, `${method} ${path} (internet)`).toBe(403);
      expect((await tailnet(method, path, body)).status, `${method} ${path} (tailnet)`).toBe(403);
    }
    const internetOnly: [string, string, unknown?][] = [
      ['POST', `/api/projects/${id}/terminal`, { command: 'id' }],
      ['GET', `/api/projects/${id}/terminal/events`],
      ['POST', '/api/mcp-servers', { name: 'x', command: 'x' }],
      ['PUT', `/api/projects/${id}/mcp`, { servers: [] }],
      ['POST', '/api/automations', {}],
      ['PUT', `/api/projects/${id}/hooks`, {}],
      ['POST', `/api/projects/${id}/git/push`, {}],
      ['PATCH', '/api/settings', { automations: true }],
    ];
    for (const [method, path, body] of internetOnly)
      expect((await internet(method, path, body)).status, `${method} ${path}`).toBe(403);
    // Express ignores case and trailing slashes when routing: the guard does too.
    for (const [method, path, body] of [
      ['PUT', '/API/Remote-Access/Account', { username: 'dono', password: 'nova senha bem longa' }],
      ['PUT', '/api/remote-access/funnel/', { enabled: false }],
      ['POST', `/api/projects/${id}/git/push/`, {}],
      ['POST', `/api/projects/${id}/GIT/push`, {}],
      ['POST', '/api/MCP-servers', { name: 'x', command: 'x' }],
    ] as const)
      expect((await internet(method, path, body)).status, `${method} ${path}`).toBe(403);
    expect((await call(`${funnel}/API/export`)).status).toBe(401);
    expect((await call(`${funnel}/Api/bootstrap`)).status).toBe(401);
    expect(
      (await call(`${server.remoteUrl}/API/export`, { headers: { host: new URL(server.remoteUrl!).host } })).status,
    ).toBe(401);
    // The terminal stays refused from the internet even with the tailnet opt-in on.
    expect((await call(`${server.url}/api/settings`, { method: 'PATCH', body: { terminalRemote: true } })).status).toBe(
      200,
    );
    const terminal = json(await internet('GET', `/api/projects/${id}/terminal`));
    expect(terminal).toMatchObject({ enabled: false, remote: true, commands: [] });
    expect(terminal.reason).toMatch(/internet/);
    expect((await internet('POST', `/api/projects/${id}/terminal`, { command: 'id' })).status).toBe(403);
    expect(json(await tailnet('GET', `/api/projects/${id}/terminal`))).toMatchObject({ enabled: true });
    // Ordinary work and reading stay available.
    expect((await internet('GET', '/api/bootstrap')).status).toBe(200);
    expect((await internet('GET', '/api/mcp-servers')).status).toBe(200);
    expect((await internet('PATCH', '/api/settings', { memoryEnabled: false })).status).toBe(200);
    // Local keeps every power.
    expect(
      (await call(`${server.url}/api/settings`, { method: 'PATCH', body: { internetManualApproval: false } })).status,
    ).toBe(200);
  });

  it('ends open event streams and sessions when the password changes or sessions are revoked', async () => {
    const server = await start(null);
    await createAccount(server);
    const funnel = await funnelUrl(server);
    const cookie = sessionCookie(await login(funnel));
    const second = sessionCookie(await login(funnel));
    const stream = new Promise<string>((resolve) => {
      const req = request(`${funnel}/api/events`, { headers: { cookie } }, (res) => {
        res.on('data', () => undefined);
        res.on('close', () => resolve('closed'));
      });
      req.on('error', () => resolve('closed'));
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100));
    const list = json(await call(`${server.url}/api/remote-access`));
    expect(list.sessions).toHaveLength(2);
    const revokeOne = await call(`${server.url}/api/remote-access/sessions/${list.sessions[0].id}`, {
      method: 'DELETE',
      body: {},
    });
    expect(json(revokeOne).sessions).toHaveLength(1);
    expect((await call(`${server.url}/api/remote-access/sessions/nope`, { method: 'DELETE', body: {} })).status).toBe(
      404,
    );
    await call(`${server.url}/api/remote-access/sessions/revoke-all`, { method: 'POST', body: {} });
    expect(await stream).toBe('closed');
    expect((await call(`${funnel}/api/bootstrap`, { headers: { cookie } })).status).toBe(401);
    expect((await call(`${funnel}/api/bootstrap`, { headers: { cookie: second } })).status).toBe(401);
    // A new password revokes everything as well.
    const third = sessionCookie(await login(funnel));
    await createAccount(server, 'dono', 'uma nova senha comprida');
    expect((await call(`${funnel}/api/bootstrap`, { headers: { cookie: third } })).status).toBe(401);
    expect((await login(funnel, 'dono', 'uma nova senha comprida')).status).toBe(200);
    // Deleting the account turns Funnel off.
    const deleted = json(await call(`${server.url}/api/remote-access/account`, { method: 'DELETE', body: {} }));
    expect(deleted.account).toBeNull();
    expect(deleted.funnel.wanted).toBe(false);
  });

  it('sends the security headers on every response', async () => {
    const server = await start(null);
    await createAccount(server);
    const funnel = await funnelUrl(server);
    for (const url of [`${server.url}/api/health`, `${funnel}/api/auth/status`, `${funnel}/api/bootstrap`]) {
      const reply = await call(url);
      expect(reply.headers['x-frame-options']).toBe('DENY');
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(String(reply.headers['content-security-policy'])).toMatch(/^frame-src .*; frame-ancestors 'none'$/);
    }
    // HSTS only over HTTPS (Funnel), never on plain local HTTP.
    expect((await call(`${server.url}/api/health`)).headers['strict-transport-security']).toBeUndefined();
    expect((await call(`${funnel}/api/auth/status`)).headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('backs off globally for distinct forwarded addresses and limits each forwarded address', async () => {
    const slept: number[] = [];
    const limiter = new LoginLimiter({ sleep: async (ms) => void slept.push(ms), globalFree: 3 });
    const dir = tempDir();
    const fake = fakeTailscale();
    const server = await startServer({
      port: 0,
      dataDir: dir,
      remote: null,
      funnelPort: 0,
      funnelService: new FunnelService(fake.run),
    });
    cleanup.push(() => server.close());
    // The limiter is injected through createBackend; here we exercise it via its own API on the
    // real server: per forwarded address first.
    await createAccount(server);
    const funnel = await funnelUrl(server);
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    for (let i = 0; i < 5; i++)
      expect((await login(funnel, 'dono', 'errada errada', from('203.0.113.1'))).status).toBe(401);
    expect((await login(funnel, 'dono', PASSWORD, from('203.0.113.1'))).status).toBe(429);
    // Parallel attempts from one address cannot pass the limit either.
    const burst = await Promise.all(
      Array.from({ length: 8 }, () => login(funnel, 'dono', 'errada errada', from('203.0.113.3'))),
    );
    expect(burst.filter((r) => r.status === 401)).toHaveLength(5);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(3);
    // Another forwarded address is not blocked by the first one.
    expect((await login(funnel, 'dono', PASSWORD, from('203.0.113.2'))).status).toBe(200);
    // Global backoff (unit): over the free budget every attempt waits.
    for (let i = 0; i < 4; i++) limiter.fail(`198.51.100.${i}`);
    expect(await limiter.throttle()).toBe(500);
    expect(slept).toEqual([500]);
  });
});

describe('internet runs use manual approval', () => {
  it('forces approvalMode manual for runs started from an internet session (setting on by default)', async () => {
    const { createBackend } = await import('../server/index.js');
    const { Store } = await import('../server/store.js');
    const { createServer } = await import('node:http');
    const { tagListener } = await import('../server/http/auth.js');
    const dir = tempDir();
    const store = new Store(dir);
    cleanup.push(() => store.close());
    const modes: (string | undefined)[] = [];
    const providers = {
      list: async () => [
        {
          id: 'codex',
          name: 'stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: 'test',
          models: [{ id: 'm1', name: 'm1', isDefault: true }],
          defaultModel: 'm1',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: false },
        },
      ],
      run: async (input: { approvalMode?: string }) => {
        modes.push(input.approvalMode);
        return { text: 'ok', stopReason: 'completed' };
      },
      approve: async () => {},
      shutdown: async () => {},
    };
    let funnelPort = 0;
    const backend = createBackend(
      store,
      providers as never,
      undefined,
      undefined,
      { retries: 0 },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        funnelListener: { port: () => funnelPort, listening: () => true, ensure: async () => funnelPort },
      },
    );
    cleanup.push(() => backend.access.stop());
    const local = createServer(backend.app);
    tagListener(local, 'local');
    const internet = createServer(backend.app);
    tagListener(internet, 'funnel');
    for (const s of [local, internet]) {
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
    }
    const port = (s: typeof local) => (s.address() as { port: number }).port;
    funnelPort = port(internet);
    const localUrl = `http://127.0.0.1:${port(local)}`;
    const netUrl = `http://127.0.0.1:${funnelPort}`;
    await createAccount({ url: localUrl } as RunningServer);
    const cookie = sessionCookie(await login(netUrl));
    const project = tempDir();
    const p = json(
      await call(`${localUrl}/api/projects`, {
        method: 'POST',
        body: { name: 'P', path: project, memoryWorkspace: 'w', memoryProject: 'p' },
      }),
    );
    const session = json(
      await call(`${localUrl}/api/sessions`, {
        method: 'POST',
        body: { projectId: p.id, providerId: 'codex', mode: 'fast' },
      }),
    );
    const send = async (url: string, headers: Record<string, string>, text: string) => {
      const sent = await call(`${url}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers,
        body: { content: text },
      });
      expect(sent.status).toBe(202);
      for (let i = 0; i < 100 && store.getSession(session.id)?.activeRunId; i++)
        await new Promise((r) => setTimeout(r, 20));
      return json(sent).runId as string;
    };
    await send(localUrl, {}, 'oi local');
    const remoteRun = await send(netUrl, { cookie, ...origin(netUrl) }, 'oi da internet');
    expect(modes).toEqual(['auto-safe', 'manual']);
    expect(store.getRun(remoteRun)?.manualApproval).toBe(true);
    // Queued and retried from the internet: still manual; approvals stay available there.
    const queued = await call(`${netUrl}/api/sessions/${session.id}/queue`, {
      method: 'POST',
      headers: { cookie, ...origin(netUrl) },
      body: { content: 'na fila' },
    });
    expect(queued.status).toBe(202);
    for (let i = 0; i < 100 && store.getSession(session.id)?.activeRunId; i++)
      await new Promise((r) => setTimeout(r, 20));
    const retried = await call(`${localUrl}/api/runs/${remoteRun}/retry`, { method: 'POST', body: {} });
    expect(retried.status).toBe(202);
    for (let i = 0; i < 100 && store.getSession(session.id)?.activeRunId; i++)
      await new Promise((r) => setTimeout(r, 20));
    // The local retry of an internet run keeps manual approval.
    expect(modes).toEqual(['auto-safe', 'manual', 'manual', 'manual']);
    const approval = await call(`${netUrl}/api/approvals/nao-existe`, {
      method: 'POST',
      headers: { cookie, ...origin(netUrl) },
      body: { decision: 'approve' },
    });
    expect(approval.status).toBe(404);
    // The setting can only be turned off locally; then internet runs follow the normal mode.
    await call(`${localUrl}/api/settings`, { method: 'PATCH', body: { internetManualApproval: false } });
    await send(netUrl, { cookie, ...origin(netUrl) }, 'de novo');
    expect(modes.at(-1)).toBe('auto-safe');
    // The global setting itself never changed.
    expect(store.getSettings()?.approvalMode).toBe('auto-safe');
  });
});

describe('Tailscale Funnel commands', () => {
  it('builds the exact commands and never replaces another published target', async () => {
    expect(funnelOnArgs(4319)).toEqual([
      'funnel',
      '--bg',
      '--yes',
      '--https=443',
      '--set-path=/',
      'http://127.0.0.1:4319',
    ]);
    expect(funnelOffArgs()).toEqual(['funnel', '--yes', '--https=443', '--set-path=/', 'off']);
    expect(() => funnelOnArgs(0)).toThrow();
    const fake = fakeTailscale();
    const service = new FunnelService(fake.run);
    const off = await service.status(4555);
    expect(off).toMatchObject({
      installed: true,
      loggedIn: true,
      dnsName: 'casa.exemplo.ts.net',
      https: true,
      funnelAllowed: true,
      port443Allowed: true,
      funnelOn: false,
      publicUrl: 'https://casa.exemplo.ts.net/',
      requirements: [],
    });
    expect((await service.enable(4555)).funnelOn).toBe(true);
    expect(fake.calls).toContainEqual(funnelOnArgs(4555));
    // Idempotent: a second enable runs no command that changes the config.
    const before = fake.calls.length;
    await service.enable(4555);
    expect(fake.calls.slice(before).filter((c) => c[0] === 'funnel' && c[1] !== 'status')).toEqual([]);
    expect((await service.disable(4555)).funnelOn).toBe(false);
    expect(fake.calls).toContainEqual(funnelOffArgs());
    // Something else on https://host/: reported, and enable refuses.
    fake.setServe({ Web: { 'casa.exemplo.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } } });
    expect((await service.status(4555)).conflict).toBe('http://127.0.0.1:8080');
    await expect(service.enable(4555)).rejects.toThrow(/já publica outro destino/);
    // Disable leaves other targets alone.
    const count = fake.calls.length;
    await service.disable(4555);
    expect(fake.calls.slice(count).some((c) => c.at(-1) === 'off')).toBe(false);
    // A mount left on an older port is ours: disable removes it.
    fake.setServe({
      Web: { 'casa.exemplo.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4444' } } } },
      AllowFunnel: { 'casa.exemplo.ts.net:443': true },
    });
    expect(await service.status(4555, 4444)).toMatchObject({ funnelOn: false, stale: true });
    const offs = () => fake.calls.filter((c) => c.at(-1) === 'off').length;
    const offBefore = offs();
    await service.disable(4555, 4444);
    expect(offs()).toBe(offBefore + 1);
  });

  it('explains what the tailnet admin must allow', async () => {
    const service = new FunnelService(fakeTailscale({ caps: [], failOn: '--bg' }).run);
    const state = await service.status(4555);
    expect(state).toMatchObject({ https: false, funnelAllowed: false });
    expect(state.requirements.map((r) => r.url)).toEqual([
      'https://login.tailscale.com/admin/dns',
      'https://login.tailscale.com/admin/acls/file',
    ]);
    await expect(service.enable(4555)).rejects.toMatchObject({
      status: 502,
      url: 'https://login.tailscale.com/admin/acls/file',
    });
    expect(explainTailscaleError('Access denied: serve config denied').text).toMatch(/--operator/);
    expect(explainTailscaleError('Funnel not available; HTTPS must be enabled.').url).toBe(
      'https://login.tailscale.com/admin/dns',
    );
    expect(explainTailscaleError('Unable to turn on Funnel while shields-up is enabled').text).toMatch(/shields up/);
    expect(explainTailscaleError('other').text).toBe('other');
    expect(
      parseCapabilities({
        CapMap: { funnel: null, https: null, 'https://tailscale.com/cap/funnel-ports?ports=8443,10000': null },
      }),
    ).toEqual({
      https: true,
      funnel: true,
      port443: false,
    });
    expect(parseCapabilities({ Capabilities: ['https://tailscale.com/cap/funnel-ports?ports=400-500'] }).port443).toBe(
      true,
    );
  });

  it('reports a missing or stopped Tailscale without failing', async () => {
    const missing = new FunnelService(async () => {
      throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
    });
    expect(await missing.status(1)).toMatchObject({
      installed: false,
      error: 'O comando tailscale não foi encontrado neste computador.',
    });
    await expect(missing.enable(1)).rejects.toThrow(/não foi encontrado/);
    const stopped = new FunnelService(async (args) => {
      if (args[0] === 'version') return { stdout: '1.102.3', stderr: '' };
      if (args[0] === 'status') return { stdout: JSON.stringify({ BackendState: 'Stopped', Self: {} }), stderr: '' };
      throw Object.assign(new Error('x'), { killed: true });
    });
    const state = await stopped.status(1);
    expect(state).toMatchObject({
      installed: true,
      loggedIn: false,
      error: 'O comando tailscale não respondeu a tempo.',
    });
    expect(state.requirements[0].text).toMatch(/tailscale up/);
    const broken = new FunnelService(async (args) => {
      if (args[0] === 'version') return { stdout: '1', stderr: '' };
      throw Object.assign(new Error('x'), { stderr: 'failed to connect to local tailscaled' });
    });
    expect((await broken.status(1)).error).toMatch(/tailscaled/);
  });

  it('shows the Tailscale error and the admin page when publishing fails, only on this computer', async () => {
    const fake = fakeTailscale({ caps: ['https'], failOn: '--bg' });
    const server = await startServer({
      port: 0,
      dataDir: tempDir(),
      remote: { bind: '127.0.0.2', port: 0 as never, token: TOKEN },
      funnelPort: 0,
      funnelService: new FunnelService(fake.run),
    });
    cleanup.push(() => server.close());
    await createAccount(server);
    const status = json(await call(`${server.url}/api/remote-access/tailscale`));
    expect(status).toMatchObject({ funnelAllowed: false, dnsName: 'casa.exemplo.ts.net' });
    const failed = await call(`${server.url}/api/remote-access/funnel`, { method: 'PUT', body: { enabled: true } });
    expect(failed.status).toBe(502);
    expect(json(failed)).toMatchObject({ url: 'https://login.tailscale.com/admin/acls/file' });
    expect(json(failed).error).toMatch(/atributo "funnel"/);
    const local = json(await call(`${server.url}/api/remote-access`));
    expect(local.funnel).toMatchObject({ wanted: false, listening: true });
    expect(local.funnel.lastError).toMatch(/funnel/);
    expect(local.tailnet.url).toMatch(/^http:\/\/127\.0\.0\.2:/);
    // A tailnet session sees the state but not the Tailscale error text.
    const cookie = sessionCookie(await login(server.remoteUrl!));
    const remote = json(await call(`${server.remoteUrl}/api/remote-access`, { headers: { cookie } }));
    expect(remote.kind).toBe('tailnet');
    expect(remote.funnel.lastError).toBeUndefined();
    // Turning off when nothing is published runs no command that changes the config.
    const off = await call(`${server.url}/api/remote-access/funnel`, { method: 'PUT', body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(fake.calls.some((c) => c.at(-1) === 'off')).toBe(false);
    expect(
      (await call(`${server.url}/api/remote-access/funnel`, { method: 'PUT', body: { enabled: 'x' } })).status,
    ).toBe(400);
    expect(
      (await call(`${server.url}/api/remote-access/account`, { method: 'PUT', body: { username: 'A' } })).status,
    ).toBe(400);
  });

  it('re-applies Funnel at startup only when it was wanted and an account exists', async () => {
    const dir = tempDir();
    const fake = fakeTailscale();
    const first = await startServer({
      port: 0,
      dataDir: dir,
      remote: null,
      funnelPort: 0,
      funnelService: new FunnelService(fake.run),
    });
    await createAccount(first);
    await funnelUrl(first);
    expect(json(await call(`${first.url}/api/remote-access`)).funnel).toMatchObject({ wanted: true, listening: true });
    await first.close();
    // Restart: wanted + account → listener started and the (idempotent) command checked.
    const again = fakeTailscale();
    const second = await startServer({
      port: 0,
      dataDir: dir,
      remote: null,
      funnelPort: 0,
      funnelService: new FunnelService(again.run),
    });
    for (let i = 0; i < 100 && !again.calls.some((c) => c.includes('--bg')); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(second.funnelUrl!()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(again.calls.some((c) => c.includes('--bg'))).toBe(true);
    await call(`${second.url}/api/remote-access/account`, { method: 'DELETE', body: {} });
    await second.close();
    // Without the account nothing is published at startup.
    const none = fakeTailscale();
    const third = await startServer({
      port: 0,
      dataDir: dir,
      remote: null,
      funnelPort: 0,
      funnelService: new FunnelService(none.run),
    });
    cleanup.push(() => third.close());
    await new Promise((r) => setTimeout(r, 100));
    expect(third.funnelUrl!()).toBeUndefined();
    expect(none.calls.some((c) => c.includes('--bg'))).toBe(false);
  });
});

describe('remote-user CLI', () => {
  function io(input: string, env: NodeJS.ProcessEnv) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (c) => (out += c));
    stderr.on('data', (c) => (err += c));
    stdin.end(input);
    return { io: { stdin, stdout, stderr, env }, text: () => ({ out, err }) };
  }

  it('sets, shows, revokes and deletes the account, reading the password twice from stdin', async () => {
    const dir = tempDir();
    const env = { ADELIC_DATA_DIR: dir };
    const usage = io('', env);
    expect(await runRemoteUserCli([], usage.io)).toBe(2);
    expect(usage.text().err).toMatch(/Uso: npm run remote-user/);
    expect(await runRemoteUserCli(['set', 'Inválido'], io('', env).io)).toBe(2);
    const mismatch = io('uma senha bem longa\noutra senha bem longa\n', env);
    expect(await runRemoteUserCli(['set', 'dono'], mismatch.io)).toBe(2);
    expect(mismatch.text().err).toMatch(/não conferem/);
    const weak = io('curta\ncurta\n', env);
    expect(await runRemoteUserCli(['set', 'dono'], weak.io)).toBe(2);
    expect(weak.text().err).toMatch(/12 caracteres/);
    const missing = io('so uma linha comprida', env);
    expect(await runRemoteUserCli(['set', 'dono'], missing.io)).toBe(2);
    const ok = io(`${PASSWORD}\n${PASSWORD}\n`, env);
    expect(await runRemoteUserCli(['set', 'dono'], ok.io)).toBe(0);
    expect(ok.text().out).toMatch(/Conta "dono" salva/);
    // The password never reaches the output.
    expect(JSON.stringify(ok.text())).not.toContain(PASSWORD);
    // The running app (same data folder) logs in with it.
    const server = await startServer({
      port: 0,
      dataDir: dir,
      remote: null,
      funnelPort: 0,
      funnelService: new FunnelService(fakeTailscale().run),
    });
    cleanup.push(() => server.close());
    const funnel = await funnelUrl(server);
    expect((await login(funnel)).status).toBe(200);
    const status = io('', env);
    expect(await runRemoteUserCli(['status'], status.io)).toBe(0);
    expect(status.text().out).toMatch(/Conta: dono[\s\S]*Sessões ativas: 1/);
    const revoke = io('', env);
    expect(await runRemoteUserCli(['revoke-sessions'], revoke.io)).toBe(0);
    expect(revoke.text().out).toMatch(/Sessões encerradas: 1/);
    expect(await runRemoteUserCli(['delete'], io('', env).io)).toBe(0);
    expect((await login(funnel)).status).toBe(401);
    const empty = io('', env);
    await runRemoteUserCli(['status'], empty.io);
    expect(empty.text().out).toMatch(/Nenhuma conta/);
  });

  it('reads without echo from a terminal', async () => {
    const dir = tempDir();
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      raw: [] as boolean[],
      setRawMode(raw: boolean) {
        this.raw.push(raw);
        return this;
      },
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let err = '';
    stderr.on('data', (c) => (err += c));
    const done = runRemoteUserCli(['set', 'dono'], { stdin, stdout, stderr, env: { ADELIC_DATA_DIR: dir } });
    const type = async (text: string) => {
      await new Promise((r) => setTimeout(r, 30));
      stdin.write(text);
    };
    await type(`${PASSWORD}x\u007f\r`);
    await type(`${PASSWORD}\r`);
    expect(await done).toBe(0);
    expect(stdin.raw).toEqual([true, false, true, false]);
    expect(err).not.toContain(PASSWORD);
    const cancelled = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {
        return this;
      },
    });
    const aborted = runRemoteUserCli(['set', 'dono'], {
      stdin: cancelled,
      stdout,
      stderr,
      env: { ADELIC_DATA_DIR: dir },
    });
    await new Promise((r) => setTimeout(r, 30));
    cancelled.write('\u0003');
    expect(await aborted).toBe(1);
  });
});
