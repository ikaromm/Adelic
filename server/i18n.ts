// Server-side translations (docs/i18n.md). The client sends its locale on every request
// (Accept-Language; `?lang=` on EventSource URLs, which cannot set headers); `localeMiddleware`
// resolves it into `req.locale`, and `tr()` / the `error()` helper translate catalog keys.
// Without a supported locale the server answers in pt-BR, as it always did.
//
// Persisted data (run events, activity, messages) stays in the language it was produced in:
// it is history, not UI chrome, and is never re-translated when the locale changes.
import type { NextFunction, Request, Response } from 'express';
import {
  DEFAULT_LOCALE,
  isLocale,
  localeFromTag,
  mergeAreas,
  negotiateLocale,
  translate,
  type Locale,
  type Vars,
} from '../shared/i18n.js';
import * as areas from './i18n/messages/index.js';

type Areas = typeof areas;
export type ServerKey = { [A in keyof Areas]: keyof Areas[A]['pt-BR'] & string }[keyof Areas];

const catalogs = mergeAreas(areas);
const keys = new Set(Object.keys(catalogs[DEFAULT_LOCALE]));
/** True for a key of the server catalog (sentences never match: keys have no spaces). */
export const isServerKey = (value: string): value is ServerKey => keys.has(value);
/** Every key, for tests. */
export const serverCatalogs = catalogs;

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by localeMiddleware; pt-BR when the client did not ask for a supported locale. */
    locale?: Locale;
  }
}

/** Translates a server catalog key; a missing key falls back to pt-BR, then to the key. */
export function tr(locale: Locale | undefined, key: ServerKey, vars?: Vars): string {
  return translate(catalogs, locale ?? DEFAULT_LOCALE, key, vars);
}

/** Locale of a request: `?lang=` first (EventSource), then Accept-Language, else pt-BR. */
export function requestLocale(req: Pick<Request, 'query' | 'get'>): Locale {
  const lang = req.query?.lang;
  if (typeof lang === 'string') {
    const fromQuery = isLocale(lang) ? lang : localeFromTag(lang);
    if (fromQuery) return fromQuery;
  }
  return negotiateLocale(req.get('accept-language'));
}

export function localeMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.locale = requestLocale(req);
  next();
}

/** Locale of the request a response belongs to (pt-BR outside a request). */
export const localeOf = (req: Request | undefined) => req?.locale ?? (req ? requestLocale(req) : DEFAULT_LOCALE);

/** A catalog key with its variables, translated when it reaches a response. */
export interface Translatable {
  key: ServerKey;
  vars?: Vars;
}
export const msg = (key: ServerKey, vars?: Vars): Translatable => ({ key, vars });
export const isTranslatable = (value: unknown): value is Translatable =>
  typeof value === 'object' && value !== null && typeof (value as Translatable).key === 'string';

/**
 * An error thrown away from a request (services, FunnelControl): its `message` is the pt-BR
 * text (logs, tests, older callers) and `failure()` / `error()` re-translate it per request.
 */
export class LocalizedError extends Error {
  constructor(
    readonly key: ServerKey,
    readonly vars?: Vars,
    readonly status?: number,
  ) {
    super(tr(DEFAULT_LOCALE, key, vars));
  }
}

/** Text of a plain string, a Translatable or a LocalizedError in `locale`. */
export function resolveMessage(value: string | Translatable | LocalizedError, locale: Locale): string {
  return typeof value === 'string' ? value : tr(locale, value.key, value.vars);
}
