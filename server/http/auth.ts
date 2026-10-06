import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { error } from './common.js';

/**
 * Optional remote access (e.g. over Tailscale). Off unless ADELIC_REMOTE_BIND is set, and
 * then only with ADELIC_REMOTE_TOKEN (32+ characters). Loopback keeps the existing
 * Host/Origin guard; every request from another address must carry the token, either as
 * `Authorization: Bearer` or the HttpOnly cookie set by POST /api/auth/login.
 */
export interface RemoteAccess {
  bind: string;
  port: number;
  token: string;
}

const COOKIE = 'adelic_session';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const digest = (value: string) => createHash('sha256').update(value).digest();
const sameToken = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

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

export const isLoopbackRequest = (req: Request) => LOOPBACK.has(req.socket.remoteAddress ?? '');

function presentedToken(req: Request) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = req.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/**
 * Guard for every request. Loopback requests go through the original Host/Origin checks.
 * Remote requests need a valid token; the login endpoint and the static UI shell are the
 * only things served without one.
 */
export function accessGuard(
  remote: RemoteAccess | undefined,
  loopbackGuard: (req: Request, res: Response, next: NextFunction) => void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isLoopbackRequest(req)) return loopbackGuard(req, res, next);
    if (!remote) return error(res, 403, 'Acesso remoto desativado');
    if (req.path === '/api/auth/login' || req.path === '/api/auth/status') return next();
    const token = presentedToken(req);
    if (token && sameToken(token, remote.token)) {
      // Cookie-authenticated mutations must come from this origin (CSRF).
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.get('authorization')) {
        const origin = req.get('origin');
        const host = req.get('host');
        if (!origin || !host || new URL(origin).host !== host) return error(res, 403, 'Origem externa bloqueada');
        if (!req.is('application/json')) return error(res, 415, 'Mutação exige application/json');
      }
      return next();
    }
    if (!req.path.startsWith('/api/')) return next(); // UI shell and assets; data stays behind the token.
    return error(res, 401, 'Autenticação necessária');
  };
}

/** Login/logout/status routes; mounted before the guard's protected routes. */
export function authRoutes(remote: RemoteAccess | undefined) {
  // At most 5 failed logins per client address per minute, against token guessing.
  const failures = new Map<string, number[]>();
  const tooMany = (address: string) => {
    const recent = (failures.get(address) ?? []).filter((at) => Date.now() - at < 60_000);
    failures.set(address, recent);
    return recent.length >= 5;
  };
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/auth/status' && req.method === 'GET') {
      const remoteRequest = !isLoopbackRequest(req);
      const token = presentedToken(req);
      return res.json({
        remote: remoteRequest,
        authenticated: !remoteRequest || Boolean(remote && token && sameToken(token, remote.token)),
      });
    }
    if (req.path === '/api/auth/login' && req.method === 'POST') {
      if (!remote || isLoopbackRequest(req)) return error(res, 400, 'Login só é necessário no acesso remoto');
      const address = req.socket.remoteAddress ?? '';
      if (tooMany(address)) return error(res, 429, 'Muitas tentativas; aguarde um minuto');
      const token = typeof req.body?.token === 'string' ? req.body.token : '';
      if (!sameToken(token, remote.token)) {
        failures.get(address)!.push(Date.now());
        return error(res, 401, 'Token inválido');
      }
      res.setHeader(
        'set-cookie',
        `${COOKIE}=${encodeURIComponent(remote.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`,
      );
      return res.json({ authenticated: true });
    }
    if (req.path === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return res.json({ authenticated: false });
    }
    next();
  };
}
