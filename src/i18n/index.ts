// UI translations (docs/i18n.md). Components: `const { t, fmt, locale } = useI18n()`.
// Modules outside React: the plain `t()`, `fmt` and `getLocale()` below read the same
// module-level locale store (src/i18n/store.ts), which `setLocale` keeps in sync.
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { DEFAULT_LOCALE, type LanguagePreference, type Locale, type Vars } from '../../shared/i18n';
import { formatters, type Formatters } from '../format';
import { t, tRich, type MessageKey } from './catalog';
import { getLanguagePreference, getLocale, setLanguagePreference, subscribeLocale } from './store';

export type { Formatters, LanguagePreference, Locale, MessageKey, Vars };
export { LANGUAGE_PREFERENCES, LOCALES } from '../../shared/i18n';
export { catalogs, t, tRich } from './catalog';
export { LANGUAGE_STORAGE_KEY, getLanguagePreference, getLocale, setLanguagePreference } from './store';

/** Formatters of the current locale, for modules outside React (components use `useI18n().fmt`). */
export const fmt: Formatters = new Proxy({} as Formatters, {
  get: (_target, name: keyof Formatters) => formatters(getLocale())[name],
});

// ---- React ----
export interface I18n {
  /** Resolved locale ('pt-BR' or 'en'). */
  locale: Locale;
  /** What Settings › Idioma holds: 'auto', 'pt-BR' or 'en'. */
  preference: LanguagePreference;
  /** Applies a preference at once (localStorage + <html lang>); persist it with the settings API. */
  setLocale: (next: LanguagePreference) => void;
  t: (key: MessageKey, vars?: Vars) => string;
  tRich: (key: MessageKey, vars: Record<string, ReactNode>) => ReactNode[];
  fmt: Formatters;
}

/**
 * Translations bound to the current locale; re-renders when it changes. No provider needed:
 * the locale lives in a module-level store, so RemoteGate (before login) works the same way.
 */
export function useI18n(): I18n {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
  const preference = useSyncExternalStore(subscribeLocale, getLanguagePreference, () => 'auto' as const);
  const setLocale = useCallback((next: LanguagePreference) => setLanguagePreference(next), []);
  return useMemo(
    () => ({
      locale,
      preference,
      setLocale,
      t: (key: MessageKey, vars?: Vars) => t(key, vars, locale),
      tRich: (key: MessageKey, vars: Record<string, ReactNode>) => tRich(key, vars, locale),
      fmt: formatters(locale),
    }),
    [locale, preference, setLocale],
  );
}
