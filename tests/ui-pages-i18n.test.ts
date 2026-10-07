import { describe, expect, it } from 'vitest';
import { AUTOMATION_MESSAGES } from '../shared/schemas';
import { describeSchedule, type AutomationSchedule } from '../shared/automations';
import { occurrenceLabel, scheduleLabel, validationMessage } from '../src/components/AutomationsPage';
import { errorScopeName } from '../src/ErrorBoundary';

// UI pages translated in docs/i18n.md: schedule labels, form validation, error fallback.
const schedules: AutomationSchedule[] = [
  { kind: 'daily', time: '09:00' },
  { kind: 'weekly', days: [3, 1], time: '19:30' },
  { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '07:00' },
  { kind: 'interval', hours: 6 },
  { kind: 'interval', hours: 1 },
];

describe('automation schedule labels', () => {
  it('pt-BR matches the shared describeSchedule() byte for byte', () => {
    for (const schedule of schedules) expect(scheduleLabel(schedule, 'pt-BR')).toBe(describeSchedule(schedule));
  });
  it('English names days, times and plural hours', () => {
    expect(schedules.map((schedule) => scheduleLabel(schedule, 'en'))).toEqual([
      'Daily at 9:00 AM',
      'Mon, Wed at 7:30 PM',
      'Every day at 7:00 AM',
      'Every 6 hours',
      'Every 1 hour',
    ]);
  });
  it('formats occurrences in the locale and the automation zone', () => {
    const at = Date.UTC(2026, 9, 12, 12, 0); // Monday 09:00 in São Paulo
    expect(occurrenceLabel(at, 'America/Sao_Paulo', 'pt-BR')).toMatch(/^seg\.,? 12 de out\.,? 09:00$/);
    expect(occurrenceLabel(at, 'America/Sao_Paulo', 'en')).toMatch(/^Mon, Oct 12,? 09:00\sAM$/);
  });
});

describe('automation form validation', () => {
  it('keeps the API messages in pt-BR and translates them in English', () => {
    for (const message of Object.values(AUTOMATION_MESSAGES)) expect(validationMessage(message, 'pt-BR')).toBe(message);
    expect(validationMessage(AUTOMATION_MESSAGES.name, 'en')).toBe('Name required (up to 80 characters)');
    expect(validationMessage(AUTOMATION_MESSAGES.schedule, 'en')).toMatch(/^Invalid schedule: .* 1 to 168 hours$/);
    expect(validationMessage('Automação inválida', 'en')).toBe('Invalid automation');
    expect(validationMessage('outra mensagem', 'en')).toBe('outra mensagem');
  });
});

describe('ErrorBoundary scope names', () => {
  const scopes = ['o Adelic', 'a conversa', 'o terminal', 'o git', 'a atividade', 'as automações', 'a memória'];
  it('keeps the pt-BR names and translates them in English', () => {
    for (const scope of [...scopes, 'as configurações']) expect(errorScopeName(scope, 'pt-BR')).toBe(scope);
    expect(scopes.map((scope) => errorScopeName(scope, 'en'))).toEqual([
      'Adelic',
      'the conversation',
      'the terminal',
      'Git',
      'the activity',
      'the automations',
      'the memory',
    ]);
    expect(errorScopeName('outra coisa', 'en')).toBe('outra coisa');
  });
  it('recognises the names App.tsx passes already translated, in either language', () => {
    expect(errorScopeName('the conversation', 'en')).toBe('the conversation');
    expect(errorScopeName('the conversation', 'pt-BR')).toBe('a conversa');
    expect(errorScopeName('the memory', 'pt-BR')).toBe('a memória');
    expect(errorScopeName('a memória', 'en')).toBe('the memory');
  });
});
