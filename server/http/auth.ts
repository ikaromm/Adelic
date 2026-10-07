import type { NextFunction, Request, Response } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { LOGIN_FAILED, PASSWORD_MAX, type AccessKind, type AuthStatus } from '../../shared/remote-access.js';
import type { Store } from '../store.js';
import {
  LoginLimiter,
  OWNER_ID,
  RemoteAccounts,
  SESSION_ABSOLUTE_MS,
  TOKEN_USER_ID,
  cleanIp,
  sameSecret,
} from '../remote-auth.js';
import { error } from './common.js';

/**
 * Remote access (docs/specs/remote-access.md). Every request is classified first:
 * - `local`: loopback socket on the local listener and no proxy headers. The only kind that
 *   skips login; it keeps the original Host/Origin guard.
 * - `tailnet`: the optional ADELIC_REMOTE_BIND listener, or `tailscale serve` (loopback with a
 *   Tailscale-User-Login identity header and no Funnel marker).
 * - `internet`: the Funnel listener (ADELIC_FUNNEL_PORT), a Tailscale-Funnel-Request header, or
 *   any other proxied request that cannot be proven to come from the tailnet (fail closed).
 * Remote kinds need a login session (cookie). The legacy ADELIC_REMOTE_TOKEN is accepted on the
 * tailnet only, never from the internet.
 */
export interface RemoteAccess {
  bind: string;
  port: number;
  token: string;
}

export const SESSION_COOKIE = 'adelic_session';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopbackAddress = (address: string | undefined) => LOOPBACK.has(address ?? '');

/** Reads and validates the remote configuration; throws instead of starting insecurely. */
export function remoteAccessFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteAccess | undefined {
  const bind = env.ADELIC_REMOTE_BIND?.trim();
  if (!bind) return undefined;
  const token = env.ADELIC_REMOTE_TOKEN?.trim() ?? '';
  if (token.length < 32)
    throw new Error(
      'ADELIC_REMOTE_BIND exige ADELIC_REMOTE_TOKEN com pelo menos 32 caracteres; o acesso remoto não foi aberto.',
    );
  if (!/^[\d.:a-fA-F]+$/.test(bind) || bind === '0.0.0.0' || bind === '::')
    throw new Error(
      'ADELIC_REMOTE_BIND deve ser um endereço IP específico (por exemplo o IP Tailscale), não 0.0.0.0 nem um nome.',
    );
  const port = Number(env.ADELIC_REMOTE_PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADELIC_REMOTE_PORT inválida.');
  return { bind, port, token };
}

export const DEFAULT_FUNNEL_PORT = 4319;
/** Port of the loopback listener that receives Funnel traffic (127.0.0.1 only). */
export function funnelPortFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.ADELIC_FUNNEL_PORT?.trim();
  const port = Number(raw || DEFAULT_FUNNEL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADELIC_FUNNEL_PORT inválida.');
  return port;
}

// ---- Classification ----
export type ListenerRole = 'local' | 'tailnet' | 'funnel';
const listenerRoles = new WeakMap<Socket, ListenerRole>();
/** Marks every connection accepted by `server` with its listener's role. */
export function tagListener(server: HttpServer, role: ListenerRole) {
  server.on('connection', (socket: Socket) => listenerRoles.set(socket, role));
}

/** Headers a reverse proxy adds; any of them on loopback means "not this computer's browser". */
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-forwarded-prefix',
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'x-original-forwarded-for',
  'via',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-headers-info',
  'tailscale-app-capabilities',
  'tailscale-ingress-src',
];
type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(',') : value;
};
const present = (headers: Headers, name: string) => header(headers, name) !== undefined;

export interface RequestFacts {
  remoteAddress?: string;
  localPort?: number;
  listener?: ListenerRole;
  headers: Headers;
}
export interface AccessInfo {
  kind: AccessKind;
  /** Client address for limits and the session list (the forwarded one only for Funnel/serve). */
  ip: string;
  /** TLS was terminated by tailscaled (Funnel or serve): Secure cookie and HSTS. */
  https: boolean;
  via: 'local' | 'tailnet-listener' | 'serve' | 'funnel' | 'proxy' | 'unknown';
}

/** Pure classification of a request; see the module comment for the rules. */
export function classifyRequest(facts: RequestFacts, config: { funnelPort?: number } = {}): AccessInfo {
  const { headers } = facts;
  const loopback = isLoopbackAddress(facts.remoteAddress);
  const socketIp = cleanIp(facts.remoteAddress);
  const forwardedIp = () => {
    const last = (header(headers, 'x-forwarded-for') ?? '').split(',').at(-1)?.trim();
    return last && cleanIp(last) !== 'desconhecido' ? cleanIp(last) : socketIp;
  };
  const proxied = PROXY_HEADERS.some((name) => present(headers, name));
  const funnelPort = config.funnelPort && facts.localPort === config.funnelPort;
  // Strongest signal first: the dedicated Funnel listener is internet whatever the headers say.
  if (facts.listener === 'funnel' || funnelPort)
    return { kind: 'internet', ip: loopback ? forwardedIp() : socketIp, https: true, via: 'funnel' };
  if (present(headers, 'tailscale-funnel-request'))
    return { kind: 'internet', ip: loopback ? forwardedIp() : socketIp, https: loopback, via: 'funnel' };
  if (facts.listener === 'tailnet')
    // A proxy in front of the tailnet listener could be anything: fail closed.
    return proxied
      ? { kind: 'internet', ip: socketIp, https: false, via: 'proxy' }
      : { kind: 'tailnet', ip: socketIp, https: false, via: 'tailnet-listener' };
  if (!loopback) return { kind: 'internet', ip: socketIp, https: false, via: 'unknown' };
  // tailscaled strips client-sent identity headers and sets them only for tailnet peers.
  if (present(headers, 'tailscale-user-login'))
    return {
      kind: 'tailnet',
      ip: forwardedIp(),
      https: header(headers, 'x-forwarded-proto') === 'https',
      via: 'serve',
    };
  if (proxied) return { kind: 'internet', ip: socketIp, https: false, via: 'proxy' };
  return { kind: 'local', ip: socketIp, https: false, via: 'local' };
}

const accessByRequest = new WeakMap<Request, AccessInfo & { sessionKey?: string }>();
export const factsOf = (req: Request): RequestFacts => ({
  remoteAddress: req.socket.remoteAddress,
  localPort: req.socket.localPort,
  listener: listenerRoles.get(req.socket),
  headers: req.headers,
});
/** Access of a request; computed by the first middleware, recomputed (no Funnel port) otherwise. */
export function accessOf(req: Request) {
  let info = accessByRequest.get(req);
  if (!info) {
    info = classifyRequest(factsOf(req));
    accessByRequest.set(req, info);
  }
  return info;
}
export const requestKind = (req: Request) => accessOf(req).kind;
export const LOCAL_ONLY = 'Esta opção só pode ser alterada neste computador, não pelo acesso remoto';
export const INTERNET_BLOCKED = 'Indisponível no acesso pela internet; use este computador ou a tailnet.';

/** Runs started from an internet session use manual approval (setting on by default). */
export const forceManualApproval = (req: Request, store: Store) =>
  requestKind(req) === 'internet' && store.getSettings()?.internetManualApproval !== false;

// ---- Security headers ----
export function securityHeaders(csp: string) {
  const policy = `${csp}; frame-ancestors 'none'`;
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (accessOf(req).https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

// ---- Sessions and login ----
function cookieValue(req: Request) {
  for (const part of (req.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
function bearer(req: Request) {
  const value = req.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}
const cookie = (value: string, maxAgeSec: number, secure: boolean) =>
  `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
const PUBLIC_API = new Set(['/api/auth/login', '/api/auth/status', '/api/auth/logout']);
/**
 * Path as the router may match it: Express routing ignores case and a trailing slash, so the
 * guard compares a lowercased, decoded path without repeated or trailing slashes.
 */
export function guardPath(path: string) {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {}
  return decoded
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/+$/, '$1');
}
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Refused from the internet even with a valid session (docs/specs/remote-access.md). */
const INTERNET_DENY: [RegExp, (method: string) => boolean][] = [
  [/^\/api\/mcp-servers(?:\/|$)/, (m) => !SAFE_METHODS.has(m)],
  [/^\/api\/projects\/[^/]+\/mcp$/, (m) => !SAFE_METHODS.has(m)],
  [/^\/api\/automations(?:\/|$)/, (m) => !SAFE_METHODS.has(m)],
  [/^\/api\/projects\/[^/]+\/hooks(?:\/|$)/, (m) => !SAFE_METHODS.has(m)],
  [/^\/api\/projects\/[^/]+\/git\/push$/, () => true],
  [/^\/api\/remote-access\/tailscale$/, () => true],
];
/** Only from this computer: credentials and the Funnel switch. */
const LOCAL_ONLY_PATHS: [RegExp, (method: string) => boolean][] = [
  [/^\/api\/remote-access\/account$/, (m) => !SAFE_METHODS.has(m)],
  [/^\/api\/remote-access\/funnel$/, (m) => !SAFE_METHODS.has(m)],
  [/^\/api\/remote-access\/tailscale$/, () => true],
];

export interface AccessOptions {
  /** Port of the Funnel listener; requests on it are always `internet` (read per request). */
  funnelPort?: () => number | undefined;
  limiter?: LoginLimiter;
  now?: () => number;
  /** Concurrent password checks (scrypt uses 32 MiB each); more wait in line. */
  maxVerifying?: number;
  /** How often open streams re-check their session (default 15 s). */
  sweepMs?: number;
}

/** Accounts, sessions, login and the request guard, built once per backend. */
export class AccessControl {
  readonly accounts: RemoteAccounts;
  readonly limiter: LoginLimiter;
  /** Open responses (event streams) per session, closed when the session ends. */
  private streams = new Map<string, Set<Response>>();
  private verifying = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private readonly store: Store,
    readonly remote: RemoteAccess | undefined,
    private readonly options: AccessOptions = {},
  ) {
    this.accounts = new RemoteAccounts(store.db, options.now);
    this.limiter = options.limiter ?? new LoginLimiter({ now: options.now });
  }

  /** First middleware: classifies the request once. */
  classify = (req: Request, _res: Response, next: NextFunction) => {
    accessByRequest.set(req, classifyRequest(factsOf(req), { funnelPort: this.options.funnelPort?.() }));
    next();
  };

  private context(req: Request) {
    const info = accessOf(req);
    return { kind: info.kind as 'tailnet' | 'internet', ip: info.ip, userAgent: req.get('user-agent') ?? '' };
  }
  /** The valid session of this request, if any (cookie; legacy Bearer token on the tailnet). */
  private authenticate(req: Request) {
    const info = accessOf(req);
    const token = bearer(req);
    if (token !== undefined)
      return info.kind === 'tailnet' && this.remote && sameSecret(token, this.remote.token)
        ? { key: undefined, viaBearer: true }
        : undefined;
    const session = this.accounts.validate(cookieValue(req), this.context(req));
    return session ? { key: session.key, viaBearer: false } : undefined;
  }
  loginMode(kind: AccessKind): AuthStatus['login'] {
    if (kind === 'local') return 'none';
    if (this.accounts.hasAccount()) return 'password';
    if (kind === 'tailnet' && this.remote) return 'token';
    return 'unavailable';
  }

  /** Guard for every request after the auth routes. */
  guard(loopbackGuard: (req: Request, res: Response, next: NextFunction) => void) {
    return (req: Request, res: Response, next: NextFunction) => {
      const info = accessByRequest.get(req) ?? accessOf(req);
      if (info.kind === 'local') return loopbackGuard(req, res, next);
      const path = guardPath(req.path);
      // Exact paths only: the auth routes themselves compare req.path exactly.
      if (PUBLIC_API.has(req.path)) return next();
      const auth = this.authenticate(req);
      if (!auth) {
        // UI shell and assets; anything that could reach the API stays behind login.
        if (path !== '/api' && !path.startsWith('/api/')) return next();
        return error(res, 401, 'Autenticação necessária');
      }
      if (LOCAL_ONLY_PATHS.some(([pattern, method]) => pattern.test(path) && method(req.method)))
        return error(res, 403, LOCAL_ONLY);
      if (
        info.kind === 'internet' &&
        INTERNET_DENY.some(([pattern, method]) => pattern.test(path) && method(req.method))
      )
        return error(res, 403, INTERNET_BLOCKED);
      if (!SAFE_METHODS.has(req.method) && !auth.viaBearer) {
        // Cookie-authenticated mutations must come from this origin (CSRF).
        const origin = req.get('origin');
        const host = req.get('host');
        let sameOrigin = false;
        try {
          sameOrigin = Boolean(origin && host && new URL(origin).host === host);
        } catch {}
        const site = req.get('sec-fetch-site');
        if (!sameOrigin || (site && site !== 'same-origin')) return error(res, 403, 'Origem externa bloqueada');
        if (!req.is('application/json')) return error(res, 415, 'Mutação exige application/json');
      }
      if (auth.key) {
        accessByRequest.set(req, { ...info, sessionKey: auth.key });
        this.track(auth.key, res);
      }
      next();
    };
  }
  private sweep?: NodeJS.Timeout;
  private track(key: string, res: Response) {
    let open = this.streams.get(key);
    if (!open) this.streams.set(key, (open = new Set()));
    open.add(res);
    res.on('close', () => {
      open.delete(res);
      if (!open.size) this.streams.delete(key);
      if (!this.streams.size && this.sweep) {
        clearInterval(this.sweep);
        this.sweep = undefined;
      }
    });
    // Long-lived responses (event streams) end once their session is revoked or expires, even
    // when that happened in another process (npm run remote-user).
    this.sweep ??= setInterval(() => {
      for (const k of this.streams.keys()) if (!this.accounts.alive(k)) this.closeStreams(k);
    }, this.options.sweepMs ?? 15_000);
    this.sweep.unref();
  }
  stop() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
  }
  /** Ends the open responses (event streams) of revoked sessions; all of them without a key. */
  closeStreams(key?: string) {
    for (const [k, open] of this.streams) if (!key || k === key) for (const res of open) res.socket?.destroy();
  }

  private async withVerifySlot<T>(work: () => Promise<T>) {
    const max = this.options.maxVerifying ?? 2;
    if (this.verifying >= max) {
      if (this.waiting.length >= 50)
        throw Object.assign(new Error('Muitas tentativas; aguarde um minuto'), { status: 429 });
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.verifying++;
    try {
      return await work();
    } finally {
      this.verifying--;
      this.waiting.shift()?.();
    }
  }

  /** /api/auth/status, /api/auth/login and /api/auth/logout; mounted before the guard. */
  routes() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const info = accessOf(req);
      if (req.path === '/api/auth/status' && req.method === 'GET') {
        const auth = info.kind === 'local' ? undefined : this.authenticate(req);
        const account = this.accounts.account();
        const status: AuthStatus = {
          remote: info.kind !== 'local',
          authenticated: info.kind === 'local' || Boolean(auth),
          kind: info.kind,
          login: this.loginMode(info.kind),
          token: info.kind === 'tailnet' && Boolean(this.remote),
          ...(auth && account ? { username: account.username } : {}),
        };
        return res.json(status);
      }
      if (req.path === '/api/auth/login' && req.method === 'POST') {
        if (info.kind === 'local') return error(res, 400, 'Login só é necessário no acesso remoto');
        return this.login(req, res);
      }
      if (req.path === '/api/auth/logout' && req.method === 'POST') {
        if (info.kind !== 'local') {
          const session = this.accounts.validate(cookieValue(req), this.context(req));
          if (session) {
            this.accounts.revokeByKey(session.key);
            this.closeStreams(session.key);
          }
        }
        res.setHeader('set-cookie', cookie('', 0, info.https));
        return res.json({ authenticated: false });
      }
      next();
    };
  }

  private async login(req: Request, res: Response) {
    const info = accessOf(req);
    const context = this.context(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const token = typeof body.token === 'string' ? body.token.trim() : undefined;
    const record = (ok: boolean, reason?: 'credentials' | 'rate-limit' | 'no-account') =>
      this.accounts.recordLogin({
        ok,
        kind: context.kind,
        username: token !== undefined ? '' : username,
        ip: info.ip,
        userAgent: context.userAgent,
        ...(reason ? { reason } : {}),
      });
    if (this.limiter.blocked(info.ip)) {
      record(false, 'rate-limit');
      return error(res, 429, 'Muitas tentativas; aguarde um minuto');
    }
    await this.limiter.throttle();
    // Checked again after the wait, and each attempt counts as a failure before the (slow)
    // check, so parallel requests from one address cannot exceed the limit.
    if (this.limiter.blocked(info.ip)) {
      record(false, 'rate-limit');
      return error(res, 429, 'Muitas tentativas; aguarde um minuto');
    }
    const pending = this.limiter.reserve(info.ip);
    let ok: boolean;
    let userId = OWNER_ID;
    let method: 'password' | 'token' = 'password';
    try {
      if (token !== undefined) {
        // The legacy token logs in on the tailnet only; from the internet it is just a failure.
        method = 'token';
        userId = TOKEN_USER_ID;
        ok = info.kind === 'tailnet' && Boolean(this.remote) && sameSecret(token, this.remote!.token);
      } else {
        const bounded = password.length <= PASSWORD_MAX && username.length <= 64;
        ok = await this.withVerifySlot(() =>
          this.accounts.checkPassword(bounded ? username : '', bounded ? password : ''),
        );
      }
    } catch (e) {
      pending.settle(false);
      return error(res, (e as { status?: number }).status ?? 500, (e as Error).message);
    }
    pending.settle(ok);
    if (!ok) {
      record(false, token === undefined && !this.accounts.hasAccount() ? 'no-account' : 'credentials');
      return error(res, 401, LOGIN_FAILED);
    }
    record(true);
    const session = this.accounts.createSession(userId, method, context);
    res.setHeader('set-cookie', cookie(session.token, Math.floor(SESSION_ABSOLUTE_MS / 1000), info.https));
    return res.json({ authenticated: true, kind: info.kind });
  }

  /** Session key of the current request (set by the guard), to mark it in the list. */
  sessionKey(req: Request) {
    return accessByRequest.get(req)?.sessionKey;
  }
}
