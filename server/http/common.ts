import type { NextFunction, Request, Response } from 'express';
import { SPEND_LIMIT_CODE } from '../../shared/spend-limits.js';
import type { Vars } from '../../shared/i18n.js';
import { errorKey, isServerKey, localeOf, resolveMessage, tr, type ServerKey, type Translatable } from '../i18n.js';

/**
 * Sends `{ error }`. A plain string goes out unchanged (not translated yet); a catalog key
 * (server/i18n/messages) is translated to the request's locale: `error(res, 404, 'remote.sessionNotFound')`
 * or `error(res, 400, { key: 'x.y', vars: { name } })`. Prefer keys in new code (docs/i18n.md).
 */
export function error(res: Response, status: number, message: string | Translatable | Error): Response;
export function error(res: Response, status: number, key: ServerKey, vars: Vars): Response;
export function error(res: Response, status: number, message: string | Translatable | Error, vars?: Vars) {
  const locale = localeOf(res.req);
  const text =
    vars !== undefined
      ? tr(locale, message as ServerKey, vars)
      : message instanceof Error
        ? errorMessage(message, locale)
        : resolveMessage(asKey(message), locale);
  return res.status(status).json({ error: text });
}
/** A string that is a catalog key is translated; any other string is sent as is. */
function asKey(message: string | Translatable): string | Translatable {
  return typeof message === 'string' && isServerKey(message) ? { key: message } : message;
}
export const str = (v: unknown, max = 200) =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;
/**
 * Text of a thrown error. With a locale, an error carrying a catalog key (LocalizedError,
 * `localize()`, `httpError()`) is translated; anything else keeps its own message.
 */
export function message(e: unknown, locale?: Parameters<typeof tr>[0]) {
  return errorMessage(e, locale);
}
function errorMessage(e: unknown, locale?: Parameters<typeof tr>[0]) {
  const key = locale ? errorKey(e) : undefined;
  if (key) return tr(locale, key.key, key.vars);
  return e instanceof Error ? e.message : String(e);
}
/** Text of a thrown error in the language of the request `res` answers. */
export const errorText = (res: Response, e: unknown) => errorMessage(e, localeOf(res.req));
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
