// Translation core shared by the UI (src/i18n) and the server (server/i18n.ts): locales,
// catalog definition, interpolation and plurals. No dependencies; see docs/i18n.md.

export type Locale = 'pt-BR' | 'en';
export const LOCALES: readonly Locale[] = ['pt-BR', 'en'];
/** Source of truth for every catalog, and the fallback for a missing key. */
export const DEFAULT_LOCALE: Locale = 'pt-BR';
/** Settings.language: a fixed locale, or `auto` (the browser's language). */
export type LanguagePreference = Locale | 'auto';
export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['auto', 'pt-BR', 'en'];

export type Vars = Record<string, string | number>;
export type Messages = Record<string, string>;
export type Catalogs = Record<Locale, Messages>;

export const isLocale = (value: unknown): value is Locale => value === 'pt-BR' || value === 'en';
export const isLanguagePreference = (value: unknown): value is LanguagePreference =>
  value === 'auto' || isLocale(value);

/** Locale of a BCP 47 tag we support ("pt", "pt-PT" → pt-BR; "en-GB" → en), if any. */
export function localeFromTag(tag: string | undefined | null): Locale | undefined {
  const lower = (tag ?? '').trim().toLowerCase();
  if (lower === 'pt' || lower.startsWith('pt-')) return 'pt-BR';
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  return undefined;
}

/** `auto`: Portuguese browsers get pt-BR, every other language gets English. */
export function resolveLanguage(preference: unknown, browserLanguage: string | undefined | null): Locale {
  if (isLocale(preference)) return preference;
  return localeFromTag(browserLanguage) === 'pt-BR' ? 'pt-BR' : 'en';
}

/**
 * Locale of an Accept-Language header: the supported tag with the highest q wins (ties keep the
 * header order). Without a supported tag the server keeps its historical pt-BR.
 */
export function negotiateLocale(header: string | undefined | null, fallback: Locale = DEFAULT_LOCALE): Locale {
  let best: { locale: Locale; q: number } | undefined;
  for (const part of (header ?? '').split(',')) {
    const [tag, ...params] = part.trim().split(';');
    const locale = localeFromTag(tag);
    if (!locale) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { locale, q };
  }
  return best?.locale ?? fallback;
}

/**
 * One catalog area: the pt-BR object is the source of truth and `en` must have exactly the same
 * keys (a missing or extra key is a type error).
 */
export function defineMessages<P extends Messages>(ptBR: P, en: NoInfer<Record<keyof P, string>>) {
  return { 'pt-BR': ptBR, en } as { 'pt-BR': P; en: Record<keyof P, string> };
}

/** Merges area catalogs into one table per locale. */
export function mergeAreas(areas: Record<string, { 'pt-BR': Messages; en: Messages }>): Catalogs {
  const merged: Catalogs = { 'pt-BR': {}, en: {} };
  for (const area of Object.values(areas)) for (const locale of LOCALES) Object.assign(merged[locale], area[locale]);
  return merged;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Replaces `{name}` with vars.name; unknown placeholders stay visible instead of vanishing. */
export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Like interpolate, but values may be anything (e.g. React elements): returns the literal
 * pieces and the values in order, for the UI to render rich text.
 */
export function interpolateParts<T>(template: string, vars: Record<string, T>): (string | T)[] {
  const parts: (string | T)[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!Object.hasOwn(vars, name)) continue;
    if (match.index > last) parts.push(template.slice(last, match.index));
    parts.push(vars[name]);
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push(template.slice(last));
  return parts;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
export function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)));
  return rules.select(count);
}

/** `key.zero` (when present and count is 0), then the CLDR category, then `key.other`. */
function pluralKey(table: Messages, locale: Locale, key: string, count: number) {
  if (count === 0 && Object.hasOwn(table, `${key}.zero`)) return `${key}.zero`;
  const category = `${key}.${pluralCategory(locale, count)}`;
  if (Object.hasOwn(table, category)) return category;
  return Object.hasOwn(table, `${key}.other`) ? `${key}.other` : undefined;
}

function lookup(catalogs: Catalogs, locale: Locale, key: string, vars?: Vars) {
  const table = catalogs[locale];
  if (Object.hasOwn(table, key)) return table[key];
  const count = vars?.count;
  if (typeof count === 'number') {
    const plural = pluralKey(table, locale, key, count);
    if (plural) return table[plural];
  }
  return undefined;
}

/** Template of `key` in `locale`, falling back to pt-BR and then to the key itself. */
export function template(catalogs: Catalogs, locale: Locale, key: string, vars?: Vars): string {
  return lookup(catalogs, locale, key, vars) ?? lookup(catalogs, DEFAULT_LOCALE, key, vars) ?? key;
}

export function translate(catalogs: Catalogs, locale: Locale, key: string, vars?: Vars): string {
  return interpolate(template(catalogs, locale, key, vars), vars);
}

/** Base names of plural keys: `x` for `x.one` / `x.other`. */
export type PluralBase<K> = K extends `${infer Base}.other` ? Base : never;
