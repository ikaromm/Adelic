// Scheduled automations (docs/specs/automations.md): types and the pure schedule math shared by
// the server (scheduler) and the UI (preview of the next occurrences).
import type { Mode, ProviderId, RunStatus } from './contracts.js';

export const AUTOMATION_NAME_MAX = 80;
export const AUTOMATION_PROMPT_MAX = 8000;
export const AUTOMATION_INTERVAL_MIN_HOURS = 1;
export const AUTOMATION_INTERVAL_MAX_HOURS = 168;
export const AUTOMATION_DENY_DEFAULT_MINUTES = 30;
export const AUTOMATION_DENY_MAX_MINUTES = 1440;
/** Recorded when an occurrence finds its conversation busy. */
export const AUTOMATION_SKIPPED_ACTIVE = 'ignorada: execução em andamento';
export const AUTOMATION_GLOBAL_OFF = 'Automações desativadas em Configurações';
/** Conversation title of an automation: "⏱ <name>". */
export const automationTitle = (name: string) => `⏱ ${name}`.slice(0, 160);

export type AutomationSchedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; hours: number };

export interface AutomationResult {
  /** Absent when no run started (skipped, or the start failed). */
  runId?: string;
  status: RunStatus | 'skipped';
  at: string;
  trigger: 'schedule' | 'catch-up' | 'manual';
  /** Why it was skipped or could not start. */
  detail?: string;
}

export interface Automation {
  id: string;
  name: string;
  /** Sent as a user message; may start with a saved command (`/revisar …`) or `/plano`. */
  prompt: string;
  projectId: string;
  /** Overrides for the automation's conversation; absent: the settings' defaults at creation. */
  providerId?: ProviderId;
  model?: string;
  mode?: Mode;
  schedule: AutomationSchedule;
  /** IANA time zone of the daily/weekly times. */
  timezone: string;
  enabled: boolean;
  /** Run once at startup when an occurrence was missed while Adelic was closed. */
  catchUp: boolean;
  /** Pending approvals of its runs are denied after this many minutes; null waits forever. */
  denyApprovalsAfterMinutes: number | null;
  /** Start of the interval schedule (creation, or the last schedule change/enable). */
  anchorAt: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastResult?: AutomationResult;
  /** Its own conversation, created on the first run and reused. */
  conversationId?: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

/** True for an IANA zone name this runtime knows (`America/Sao_Paulo`, `UTC`). */
export function isValidTimeZone(timeZone: string) {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The machine's zone, falling back to UTC. */
export function systemTimeZone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isValidTimeZone(zone) ? zone : 'UTC';
}

/** Wall-clock fields of an instant in `timeZone`. */
function wallClock(ms: number, timeZone: string) {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms)))
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour % 24,
    minute: fields.minute,
    second: fields.second,
  };
}

/** Offset of `timeZone` from UTC at an instant, in ms (wall clock minus UTC). */
function offsetAt(ms: number, timeZone: string) {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant a wall-clock time happens in `timeZone`. An ambiguous time (clocks set back)
 * resolves to its first occurrence; a time that does not exist (clocks set forward) moves
 * forward by the gap, e.g. 02:30 becomes 03:30.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  const valid = [...new Set([wall - before, wall - after])]
    .filter((at) => at + offsetAt(at, timeZone) === wall)
    .sort((a, b) => a - b);
  return valid[0] ?? wall - before;
}

/**
 * First occurrence strictly after `after` (ms). Daily and weekly times are wall-clock times
 * in `timeZone`; an interval counts real hours from `anchor` (default `after`), so it is
 * unaffected by daylight saving changes.
 */
export function nextOccurrence(schedule: AutomationSchedule, timeZone: string, after: number, anchor = after): number {
  if (schedule.kind === 'interval') {
    const step = schedule.hours * HOUR;
    if (after < anchor + step) return anchor + step;
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const match = TIME.exec(schedule.time);
  if (!match) throw new Error(`Horário inválido: ${schedule.time}`);
  const hour = Number(match[1]),
    minute = Number(match[2]);
  const today = wallClock(after, timeZone);
  for (let i = 0; i <= 15; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (schedule.kind === 'weekly' && !schedule.days.includes(date.getUTCDay())) continue;
    const at = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
    if (at > after) return at;
  }
  throw new Error('Agenda sem ocorrências');
}

/** The next `count` occurrences after `after`, for the form's preview. */
export function nextOccurrences(
  schedule: AutomationSchedule,
  timeZone: string,
  after: number,
  count: number,
  anchor = after,
): number[] {
  const result: number[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    cursor = nextOccurrence(schedule, timeZone, cursor, anchor);
    result.push(cursor);
  }
  return result;
}

const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const WEEKDAY_LABELS = weekdays;

/** Words of a schedule description in one language (the UI passes translated ones). */
export interface ScheduleWords {
  interval: (hours: number) => string;
  daily: (time: string) => string;
  /** `days` is the joined list of weekday names. */
  weekly: (days: string, time: string) => string;
  everyDay: (time: string) => string;
  weekday: (day: number) => string;
  /** Formats the "HH:MM" of a daily or weekly schedule; default: unchanged. */
  time?: (time: string) => string;
}

const ptBR: ScheduleWords = {
  interval: (hours) => `A cada ${hours} h`,
  daily: (time) => `Diária às ${time}`,
  weekly: (days, time) => `${days} às ${time}`,
  everyDay: (time) => `Todos os dias às ${time}`,
  weekday: (day) => weekdays[day],
};

/** Schedule description with the given words (see describeSchedule). */
export function describeScheduleWith(schedule: AutomationSchedule, words: ScheduleWords) {
  if (schedule.kind === 'interval') return words.interval(schedule.hours);
  const time = words.time ? words.time(schedule.time) : schedule.time;
  if (schedule.kind === 'daily') return words.daily(time);
  const days = [...schedule.days].sort((a, b) => a - b);
  if (days.length === 7) return words.everyDay(time);
  return words.weekly(days.map((d) => words.weekday(d)).join(', '), time);
}

/** Short pt-BR description: "Diária às 09:00", "Seg, Qua às 09:00", "A cada 6 h". */
export function describeSchedule(schedule: AutomationSchedule) {
  return describeScheduleWith(schedule, ptBR);
}
