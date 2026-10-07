import { getLocale } from './i18n/store';
import type { Locale } from '../shared/i18n';

// Locale-aware formatting (docs/i18n.md). Every helper takes an optional locale and defaults to
// the current UI locale; components usually call them through `useI18n().fmt`.

const MONTHS: Record<Locale, string[]> = {
  'pt-BR': ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const decimal = (value: string, locale: Locale) => (locale === 'pt-BR' ? value.replace('.', ',') : value);

/** Compact duration for activity rows and metrics: "2,4 s" (en "2.4 s"), "12 s", "6 min 33 s", "1 h 5 min". */
export function formatDuration(ms?: number | null, locale: Locale = getLocale()): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${decimal((tenths / 10).toFixed(1), locale)} s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/**
 * Short recency label for the sidebar: "agora", "5 min", "3 h", "2 d", "12 set", "12 set 2025"
 * (en: "now", …, "Sep 12", "Sep 12, 2025").
 */
export function relativeTime(value: string | undefined, now = Date.now(), locale: Locale = getLocale()): string {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Math.max(0, now - time);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return locale === 'en' ? 'now' : 'agora';
  if (diff < hour) return `${Math.floor(diff / minute)} min`;
  if (diff < day) return `${Math.floor(diff / hour)} h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d`;
  const date = new Date(time);
  const month = MONTHS[locale][date.getMonth()];
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  if (locale === 'en')
    return sameYear ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`;
  const label = `${date.getDate()} ${month}`;
  return sameYear ? label : `${label} ${date.getFullYear()}`;
}

/** Keyboard hint for the global new-conversation shortcut (Ctrl+K, or ⌘K on Apple platforms). */
export function newConversationShortcut(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform || '',
): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}

/** Compact token count: 980, 4,6 mil, 1,2 mi (en: 4.6k, 1.2M). Undefined stays unknown ("—" in the UI). */
export function formatTokens(value: number | undefined, locale: Locale = getLocale()): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value < 1000) return String(Math.round(value));
  const compact = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 });
  if (value < 1_000_000) return locale === 'en' ? `${compact(value / 1000)}k` : `${compact(value / 1000)} mil`;
  return locale === 'en' ? `${compact(value / 1_000_000)}M` : `${compact(value / 1_000_000)} mi`;
}

/** Tokens of a run as "4,6 mil entrada · 5 saída" (en "4.6k in · 5 out"), or undefined when the provider sent none. */
export function runTokens(
  run: { inputTokens?: number; outputTokens?: number },
  locale: Locale = getLocale(),
): string | undefined {
  const input = formatTokens(run.inputTokens, locale),
    output = formatTokens(run.outputTokens, locale);
  if (!input && !output) return undefined;
  const [inLabel, outLabel] = locale === 'en' ? ['in', 'out'] : ['entrada', 'saída'];
  return [input && `${input} ${inLabel}`, output && `${output} ${outLabel}`].filter(Boolean).join(' · ');
}

/** Cost in USD only when the provider reported it; unknown is never shown as zero. */
export function formatCost(costUsd: number | undefined, locale: Locale = getLocale()): string | undefined {
  if (costUsd == null || !Number.isFinite(costUsd)) return undefined;
  const symbol = locale === 'en' ? '$' : 'US$ ';
  return costUsd < 0.01 ? `${symbol}${costUsd.toFixed(4)}` : `${symbol}${costUsd.toFixed(2)}`;
}

/** Number with the locale's separators ("1.234,5" / "1,234.5"). */
export function formatNumber(value: number, locale: Locale = getLocale(), options?: Intl.NumberFormatOptions): string {
  return value.toLocaleString(locale, options);
}

const validDate = (value?: string | number | Date) => {
  if (value == null || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};
/** "14:05" (en "2:05 PM"); "—" when unknown. */
export function formatTime(value?: string | number | Date, locale: Locale = getLocale()): string {
  const date = validDate(value);
  return date ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—';
}
/** "12 de set." (en "Sep 12"); empty when unknown. */
export function formatShortDate(value?: string | number | Date, locale: Locale = getLocale()): string {
  const date = validDate(value);
  return date ? date.toLocaleDateString(locale, { day: '2-digit', month: 'short' }) : '';
}
/** Date and time for details and tooltips ("12/09/2026, 14:05" / "9/12/2026, 2:05 PM"); empty when unknown. */
export function formatDateTime(value?: string | number | Date, locale: Locale = getLocale()): string {
  const date = validDate(value);
  return date ? date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '';
}

/** The helpers above bound to one locale: `useI18n().fmt`. */
export function formatters(locale: Locale) {
  return {
    duration: (ms?: number | null) => formatDuration(ms, locale),
    relative: (value: string | undefined, now?: number) => relativeTime(value, now, locale),
    tokens: (value: number | undefined) => formatTokens(value, locale),
    runTokens: (run: { inputTokens?: number; outputTokens?: number }) => runTokens(run, locale),
    cost: (costUsd: number | undefined) => formatCost(costUsd, locale),
    number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, locale, options),
    time: (value?: string | number | Date) => formatTime(value, locale),
    shortDate: (value?: string | number | Date) => formatShortDate(value, locale),
    dateTime: (value?: string | number | Date) => formatDateTime(value, locale),
  };
}
export type Formatters = ReturnType<typeof formatters>;
