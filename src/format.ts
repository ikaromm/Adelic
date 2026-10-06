const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Compact pt-BR duration for activity rows and metrics: "2,4 s", "12 s", "6 min 33 s", "1 h 5 min". */
export function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1).replace('.', ',')} s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** Short recency label for the sidebar: "agora", "5 min", "3 h", "2 d", "12 set", "12 set 2025". */
export function relativeTime(value: string | undefined, now = Date.now()): string {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Math.max(0, now - time);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'agora';
  if (diff < hour) return `${Math.floor(diff / minute)} min`;
  if (diff < day) return `${Math.floor(diff / hour)} h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} d`;
  const date = new Date(time);
  const label = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label} ${date.getFullYear()}`;
}

/** Keyboard hint for the global new-conversation shortcut (Ctrl+K, or ⌘K on Apple platforms). */
export function newConversationShortcut(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform || '',
): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}

/** Compact token count: 980, 4,6 mil, 1,2 mi. Undefined stays unknown ("—" in the UI). */
export function formatTokens(value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return `${(value / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
}

/** Tokens of a run as "4,6 mil entrada · 5 saída", or undefined when the provider sent none. */
export function runTokens(run: { inputTokens?: number; outputTokens?: number }): string | undefined {
  const input = formatTokens(run.inputTokens),
    output = formatTokens(run.outputTokens);
  if (!input && !output) return undefined;
  return [input && `${input} entrada`, output && `${output} saída`].filter(Boolean).join(' · ');
}

/** Cost in USD only when the provider reported it; unknown is never shown as zero. */
export function formatCost(costUsd: number | undefined): string | undefined {
  if (costUsd == null || !Number.isFinite(costUsd)) return undefined;
  return costUsd < 0.01 ? `US$ ${costUsd.toFixed(4)}` : `US$ ${costUsd.toFixed(2)}`;
}
