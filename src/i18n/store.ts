// Current UI locale, outside React (docs/i18n.md). `useI18n()` subscribes to it; plain modules
// (src/format.ts, src/labels.ts, api.ts) read `getLocale()`. No catalog imports here.
import {
  DEFAULT_LOCALE,
  isLanguagePreference,
  resolveLanguage,
  type LanguagePreference,
  type Locale,
} from '../../shared/i18n';

/** localStorage mirror of Settings.language: read before login (RemoteGate) and on reload. */
export const LANGUAGE_STORAGE_KEY = 'adelic-language';

const listeners = new Set<() => void>();
const inBrowser = () => typeof window !== 'undefined' && typeof navigator !== 'undefined';
function storage() {
  try {
    return inBrowser() ? window.localStorage : null;
  } catch {
    return null;
  }
}
function storedPreference(): LanguagePreference {
  try {
    const value = storage()?.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePreference(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}
/** `auto` follows the browser; outside a browser (unit tests, SSR) it stays pt-BR. */
const resolve = (value: LanguagePreference): Locale =>
  inBrowser() ? resolveLanguage(value, navigator.language) : value === 'auto' ? DEFAULT_LOCALE : value;

let preference: LanguagePreference = storedPreference();
let current: Locale = resolve(preference);
syncDocument();

function syncDocument() {
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

export const getLocale = () => current;
export const getLanguagePreference = () => preference;

/**
 * Applies a language preference: resolves `auto`, mirrors it in localStorage, updates
 * `<html lang>` and re-renders every `useI18n()` consumer. Saving it on the server
 * (Settings.language) is the caller's job.
 */
export function setLanguagePreference(next: LanguagePreference) {
  const valid: LanguagePreference = isLanguagePreference(next) ? next : 'auto';
  try {
    storage()?.setItem(LANGUAGE_STORAGE_KEY, valid);
  } catch {}
  const locale = resolve(valid);
  if (valid === preference && locale === current) return;
  preference = valid;
  current = locale;
  syncDocument();
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
