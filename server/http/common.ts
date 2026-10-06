import type { NextFunction, Request, Response } from 'express';

export const error = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
export const str = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;
export function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
/** Status carried by an error thrown on purpose (e.g. 409 conflict), if any. */
export function errorStatus(e: unknown): number | undefined {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Loopback-only API: rejects foreign Host headers and cross-site mutations. */
export function originGuard(req: Request, res: Response, next: NextFunction) {
  const host = (req.get('host') || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) return error(res, 403, 'Host inválido');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.is('application/json')) return error(res, 415, 'Mutação exige application/json');
    const origin = req.get('origin');
    if (origin) {
      try {
        const u = new URL(origin);
        if (!['http:', 'https:'].includes(u.protocol) || u.host.toLowerCase() !== host)
          return error(res, 403, 'Origin externo bloqueado');
      } catch {
        return error(res, 403, 'Origin inválido');
      }
    }
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return error(res, 403, 'Origem externa bloqueada');
  }
  next();
}
