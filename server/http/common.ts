import type { NextFunction, Request, Response } from 'express';
import { SPEND_LIMIT_CODE } from '../../shared/spend-limits.js';
import type { Vars } from '../../shared/i18n.js';
import {
  LocalizedError,
  isServerKey,
  localeOf,
  resolveMessage,
  tr,
  type ServerKey,
  type Translatable,
} from '../i18n.js';

/**
 * Sends `{ error }`. A plain string goes out unchanged (not translated yet); a catalog key
 * (server/i18n/messages) is translated to the request's locale: `error(res, 404, 'remote.sessionNotFound')`
 * or `error(res, 400, { key: 'x.y', vars: { name } })`. Prefer keys in new code (docs/i18n.md).
 */
export function error(res: Response, status: number, message: string | Translatable | LocalizedError): Response;
export function error(res: Response, status: number, key: ServerKey, vars: Vars): Response;
export function error(res: Response, status: number, message: string | Translatable | LocalizedError, vars?: Vars) {
  const locale = localeOf(res.req);
  const text = vars !== undefined ? tr(locale, message as ServerKey, vars) : resolveMessage(asKey(message), locale);
  return res.status(status).json({ error: text });
}
/** A string that is a catalog key is translated; any other string is sent as is. */
function asKey(message: string | Translatable | LocalizedError): string | Translatable | LocalizedError {
  return typeof message === 'string' && isServerKey(message) ? { key: message } : message;
}
export const str = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;
export function message(e: unknown, locale?: Parameters<typeof tr>[0]) {
  if (e instanceof LocalizedError && locale) return tr(locale, e.key, e.vars);
  return e instanceof Error ? e.message : String(e);
}
/** Status carried by an error thrown on purpose (e.g. 409 conflict), if any. */
export function errorStatus(e: unknown): number | undefined {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}
/**
 * Sends a thrown error as `{ error }` with its status. A usage-limit refusal also carries
 * `code: 'spend_limit'` and the limit, so the UI can offer "Continuar mesmo assim".
 */
export function failure(res: Response, e: unknown, fallbackStatus = 500) {
  const { code, limit } = (e ?? {}) as { code?: unknown; limit?: unknown };
  return res
    .status(errorStatus(e) || fallbackStatus)
    .json({ error: message(e, localeOf(res.req)), ...(code === SPEND_LIMIT_CODE ? { code, limit } : {}) });
}

/** Loopback-only API: rejects foreign Host headers and cross-site mutations. */
export function originGuard(req: Request, res: Response, next: NextFunction) {
  const host = (req.get('host') || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host)) return error(res, 403, 'common.invalidHost');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.is('application/json')) return error(res, 415, 'auth.jsonRequired');
    const origin = req.get('origin');
    if (origin) {
      try {
        const u = new URL(origin);
        if (!['http:', 'https:'].includes(u.protocol) || u.host.toLowerCase() !== host)
          return error(res, 403, 'common.foreignOrigin');
      } catch {
        return error(res, 403, 'common.invalidOrigin');
      }
    }
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return error(res, 403, 'auth.externalOrigin');
  }
  next();
}
