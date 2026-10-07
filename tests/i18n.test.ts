import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import {
  defineMessages,
  interpolate,
  interpolateParts,
  localeFromTag,
  mergeAreas,
  negotiateLocale,
  resolveLanguage,
  translate,
} from '../shared/i18n.js';
import * as uiAreas from '../src/i18n/messages';
import * as serverAreas from '../server/i18n/messages/index.js';
import { LocalizedError, localeMiddleware, requestLocale, tr } from '../server/i18n.js';
import { error, failure } from '../server/http/common.js';
import { t, tRich } from '../src/i18n';
import { thinkingLabel } from '../src/reasoning';
import { formatCost, formatDuration, formatTokens, formatters, relativeTime, runTokens } from '../src/format';

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholders = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();

describe.each([
  ['UI', uiAreas],
  ['server', serverAreas],
])('%s catalogs', (_name, areas) => {
  const entries = Object.entries(
    areas as Record<string, { 'pt-BR': Record<string, string>; en: Record<string, string> }>,
  );

  it.each(entries)('area %s: en has exactly the pt-BR keys, non-empty, with the same placeholders', (area, catalog) => {
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog['pt-BR']).sort());
    for (const [key, pt] of Object.entries(catalog['pt-BR'])) {
      expect(pt.trim(), key).not.toBe('');
      expect(catalog.en[key].trim(), key).not.toBe('');
      expect(placeholders(catalog.en[key]), key).toEqual(placeholders(pt));
    }
    // Keys are namespaced by their area (auth.*, composer.*), except shared leaf vocabularies.
    for (const key of Object.keys(catalog['pt-BR'])) expect(key).toMatch(/^[a-z][A-Za-z]*\.[\w.]+$/);
    expect(area).toMatch(/^[a-z][a-z-]*$/);
  });

  it('no key is defined by two areas (merging would silently drop one)', () => {
    const seen = new Map<string, string>();
    for (const [area, catalog] of entries)
      for (const key of Object.keys(catalog['pt-BR'])) {
        expect(seen.get(key), `${key} in ${area}`).toBeUndefined();
        seen.set(key, area);
      }
  });
});

describe('translation core', () => {
  const catalogs = mergeAreas({
    demo: defineMessages(
      {
        'demo.hello': 'Olá, {name}',
        'demo.files.one': '{count} arquivo',
        'demo.files.other': '{count} arquivos',
        'demo.items.zero': 'Nenhum item',
        'demo.items.one': 'Um item',
        'demo.items.other': '{count} itens',
        'demo.onlyPt': 'só em português',
      },
      {
        'demo.hello': 'Hello, {name}',
        'demo.files.one': '{count} file',
        'demo.files.other': '{count} files',
        'demo.items.zero': 'No items',
        'demo.items.one': 'One item',
        'demo.items.other': '{count} items',
        'demo.onlyPt': '',
      },
    ),
  });
  delete (catalogs.en as Record<string, string>)['demo.onlyPt'];

  it('interpolates {name} and keeps unknown placeholders visible', () => {
    expect(translate(catalogs, 'en', 'demo.hello', { name: 'Ana' })).toBe('Hello, Ana');
    expect(interpolate('{a} e {b}', { a: 1 })).toBe('1 e {b}');
    expect(interpolate('sem variáveis')).toBe('sem variáveis');
    expect(interpolateParts('Use {x} agora', { x: 42 })).toEqual(['Use ', 42, ' agora']);
    expect(interpolateParts('{x}', { y: 1 })).toEqual(['{x}']);
  });

  it('picks plurals with Intl.PluralRules per locale, and .zero when present', () => {
    expect(translate(catalogs, 'pt-BR', 'demo.files', { count: 1 })).toBe('1 arquivo');
    expect(translate(catalogs, 'pt-BR', 'demo.files', { count: 0 })).toBe('0 arquivo'); // CLDR pt: 0 is "one"
    expect(translate(catalogs, 'pt-BR', 'demo.files', { count: 3 })).toBe('3 arquivos');
    expect(translate(catalogs, 'en', 'demo.files', { count: 1 })).toBe('1 file');
    expect(translate(catalogs, 'en', 'demo.files', { count: 0 })).toBe('0 files');
    expect(translate(catalogs, 'en', 'demo.items', { count: 0 })).toBe('No items');
    expect(translate(catalogs, 'en', 'demo.items', { count: 7 })).toBe('7 items');
  });

  it('falls back to pt-BR, then to the key', () => {
    expect(translate(catalogs, 'en', 'demo.onlyPt')).toBe('só em português');
    expect(translate(catalogs, 'en', 'demo.missing')).toBe('demo.missing');
  });

  it('resolves auto from the browser and negotiates Accept-Language by q', () => {
    expect(resolveLanguage('auto', 'pt-PT')).toBe('pt-BR');
    expect(resolveLanguage('auto', 'de-DE')).toBe('en');
    expect(resolveLanguage(undefined, undefined)).toBe('en');
    expect(resolveLanguage('pt-BR', 'en-US')).toBe('pt-BR');
    expect(localeFromTag('EN-gb')).toBe('en');
    expect(localeFromTag('es')).toBeUndefined();
    expect(negotiateLocale('en-US,en;q=0.9,pt-BR;q=0.8')).toBe('en');
    expect(negotiateLocale('fr;q=1, pt-BR;q=0.4, en;q=0.6')).toBe('en');
    expect(negotiateLocale('en;q=0, pt')).toBe('pt-BR');
    expect(negotiateLocale('fr')).toBe('pt-BR');
    expect(negotiateLocale(undefined)).toBe('pt-BR');
  });
});

describe('UI t()', () => {
  it('translates real keys in both locales and renders rich parts', () => {
    expect(t('composer.send', undefined, 'pt-BR')).toBe('Enviar mensagem');
    expect(t('composer.send', undefined, 'en')).toBe('Send message');
    expect(t('sidebar.update', { version: '1.2.0' }, 'en')).toBe('Version 1.2.0 available');
    // Outside a browser `auto` resolves to pt-BR, so existing pt-BR assertions keep working.
    expect(t('composer.send')).toBe('Enviar mensagem');
    expect(thinkingLabel('xhigh')).toBe('Muito alto');
    expect(tRich('composer.context.orchestrated', { agent: 'Codex' }, 'en')).toHaveLength(3);
  });
});

describe('locale-aware formatting', () => {
  const now = new Date('2026-10-06T12:00:00Z').getTime();
  it('keeps pt-BR output and adapts decimals, units and dates in English', () => {
    expect(formatDuration(2935, 'en')).toBe('2.9 s');
    expect(formatDuration(2935, 'pt-BR')).toBe('2,9 s');
    expect(formatDuration(393_500, 'en')).toBe('6 min 34 s');
    expect(formatTokens(4611, 'en')).toBe('4.6k');
    expect(formatTokens(1_250_000, 'en')).toBe('1.3M');
    expect(formatTokens(1_250_000, 'pt-BR')).toBe('1,3 mi');
    expect(runTokens({ inputTokens: 4606, outputTokens: 5 }, 'en')).toBe('4.6k in · 5 out');
    expect(formatCost(1.234, 'en')).toBe('$1.23');
    expect(formatCost(1.234, 'pt-BR')).toBe('US$ 1.23');
    expect(relativeTime('2026-10-06T11:59:30Z', now, 'en')).toBe('now');
    expect(relativeTime('2026-09-12T12:00:00Z', now, 'en')).toBe('Sep 12');
    expect(relativeTime('2025-09-12T12:00:00Z', now, 'en')).toBe('Sep 12, 2025');
  });
  it('binds every helper to one locale', () => {
    const en = formatters('en');
    const pt = formatters('pt-BR');
    expect(en.number(1234.5)).toBe('1,234.5');
    expect(pt.number(1234.5)).toBe('1.234,5');
    expect(en.time('not a date')).toBe('—');
    expect(en.shortDate(undefined)).toBe('');
    expect(en.dateTime('2026-09-12T12:00:00')).toMatch(/9\/12\/26/);
    expect(pt.dateTime('2026-09-12T12:00:00')).toMatch(/12\/09\/2026/);
    expect(pt.shortDate('2026-09-12T12:00:00')).toMatch(/12/);
    expect(en.time('2026-09-12T14:05:00')).toMatch(/02:05\s?PM/);
    expect(en.duration(100)).toBe('0.1 s');
    expect(en.relative(undefined)).toBe('');
    expect(en.tokens(5)).toBe('5');
    expect(en.runTokens({})).toBeUndefined();
    expect(en.cost(0.001)).toBe('$0.0010');
  });
});

describe('server tr() and error()', () => {
  const fakeRes = (locale?: 'pt-BR' | 'en') => {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      req: { locale },
      status(code: number) {
        sent.status = code;
        return res;
      },
      json(body: unknown) {
        sent.body = body;
        return res;
      },
    };
    return { res: res as unknown as Response, sent };
  };

  it('translates keys, keeps pt-BR as the fallback and never misses a key', () => {
    expect(tr('en', 'auth.required')).toBe('Authentication required');
    expect(tr(undefined, 'auth.required')).toBe('Autenticação necessária');
    const merged = mergeAreas(serverAreas);
    for (const key of Object.keys(merged['pt-BR'])) expect(Object.hasOwn(merged.en, key), key).toBe(true);
  });

  it('error() sends plain strings unchanged and translates keys and key+vars', () => {
    const plain = fakeRes('en');
    error(plain.res, 400, 'Projeto não encontrado');
    expect(plain.sent).toEqual({ status: 400, body: { error: 'Projeto não encontrado' } });
    const key = fakeRes('en');
    error(key.res, 404, 'remote.sessionNotFound');
    expect(key.sent.body).toEqual({ error: 'Session not found' });
    const object = fakeRes('pt-BR');
    error(object.res, 401, { key: 'auth.loginFailed' });
    expect(object.sent.body).toEqual({ error: 'Usuário ou senha incorretos' });
    const withVars = fakeRes('en');
    error(withVars.res, 403, 'auth.localOnly', {});
    expect(withVars.sent.body).toEqual({
      error: 'This option can only be changed on this computer, not through remote access',
    });
  });

  it('LocalizedError carries pt-BR as its message and is re-translated per request', () => {
    const e = new LocalizedError('remote.accountFirst', undefined, 409);
    expect(e.message).toBe('Crie o usuário e a senha antes de publicar na internet.');
    const out = fakeRes('en');
    failure(out.res, e);
    expect(out.sent).toEqual({
      status: 409,
      body: { error: 'Create the username and password before publishing to the internet.' },
    });
    const direct = fakeRes('en');
    error(direct.res, 409, e);
    expect(direct.sent.body).toEqual({ error: 'Create the username and password before publishing to the internet.' });
  });

  it('resolves the request locale from ?lang= first, then Accept-Language', () => {
    const req = (query: Record<string, unknown>, header?: string) =>
      ({ query, get: (name: string) => (name === 'accept-language' ? header : undefined) }) as unknown as Request;
    expect(requestLocale(req({ lang: 'en' }, 'pt-BR'))).toBe('en');
    expect(requestLocale(req({ lang: 'en-GB' }))).toBe('en');
    expect(requestLocale(req({ lang: 'xx' }, 'en'))).toBe('en');
    expect(requestLocale(req({}, undefined))).toBe('pt-BR');
    const r = req({}, 'en');
    let called = false;
    localeMiddleware(r, {} as Response, () => (called = true));
    expect([r.locale, called]).toEqual(['en', true]);
  });
});
