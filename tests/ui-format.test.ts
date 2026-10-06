import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  newConversationShortcut,
  relativeTime,
  formatCost,
  formatTokens,
  runTokens,
} from '../src/format';

describe('activity durations', () => {
  it('uses pt-BR decimals below ten seconds and whole units above', () => {
    expect(formatDuration(2935)).toBe('2,9 s');
    expect(formatDuration(9949)).toBe('9,9 s');
    expect(formatDuration(9950)).toBe('10 s');
    expect(formatDuration(59_400)).toBe('59 s');
    expect(formatDuration(393_500)).toBe('6 min 34 s');
    expect(formatDuration(120_000)).toBe('2 min');
    expect(formatDuration(3_900_000)).toBe('1 h 5 min');
  });

  it('shows nothing for unknown or invalid measurements instead of a fake zero', () => {
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('sidebar recency labels', () => {
  const now = new Date('2026-10-06T12:00:00Z').getTime();
  it('scales from minutes to dates', () => {
    expect(relativeTime('2026-10-06T11:59:30Z', now)).toBe('agora');
    expect(relativeTime('2026-10-06T11:55:00Z', now)).toBe('5 min');
    expect(relativeTime('2026-10-06T09:00:00Z', now)).toBe('3 h');
    expect(relativeTime('2026-10-04T12:00:00Z', now)).toBe('2 d');
    expect(relativeTime('2026-09-12T12:00:00Z', now)).toBe('12 set');
    expect(relativeTime('2025-09-12T12:00:00Z', now)).toBe('12 set 2025');
  });

  it('treats clock skew as now and ignores invalid timestamps', () => {
    expect(relativeTime('2026-10-06T12:05:00Z', now)).toBe('agora');
    expect(relativeTime('not a date', now)).toBe('');
    expect(relativeTime(undefined, now)).toBe('');
  });
});

describe('new conversation shortcut hint', () => {
  it('matches the platform modifier', () => {
    expect(newConversationShortcut('Linux x86_64')).toBe('Ctrl K');
    expect(newConversationShortcut('Win32')).toBe('Ctrl K');
    expect(newConversationShortcut('MacIntel')).toBe('⌘K');
  });
});

describe('token and cost formatting', () => {
  it('formats counts compactly and keeps unknown as undefined', () => {
    expect(formatTokens(980)).toBe('980');
    expect(formatTokens(4611)).toBe('4,6 mil');
    expect(formatTokens(1_250_000)).toBe('1,3 mi');
    expect(formatTokens(undefined)).toBeUndefined();
    expect(runTokens({ inputTokens: 4606, outputTokens: 5 })).toBe('4,6 mil entrada · 5 saída');
    expect(runTokens({ outputTokens: 12 })).toBe('12 saída');
    expect(runTokens({})).toBeUndefined();
  });
  it('never turns an unknown cost into zero', () => {
    expect(formatCost(undefined)).toBeUndefined();
    expect(formatCost(0)).toBe('US$ 0.0000');
    expect(formatCost(0.004)).toBe('US$ 0.0040');
    expect(formatCost(1.234)).toBe('US$ 1.23');
  });
});
