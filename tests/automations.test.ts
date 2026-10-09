import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from '../server/index.js';
import { migrate, migrations } from '../server/migrations.js';
import { Store } from '../server/store.js';
import { LATE_TOLERANCE_MS, MAX_WAIT_MS } from '../server/automations.js';
import {
  AUTOMATION_SKIPPED_ACTIVE,
  describeSchedule,
  isValidTimeZone,
  nextOccurrence,
  nextOccurrences,
  systemTimeZone,
  zonedTime,
  type Automation,
} from '../shared/automations.js';
import type { ProviderRegistry, RunInput, RunResult, Settings } from '../shared/contracts.js';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (value: string) => Date.parse(value);

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))),
  );
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-automations-'));
  dirs.push(dir);
  return dir;
};

describe('next occurrence', () => {
  it('daily: later today, otherwise tomorrow, in the given zone', () => {
    const sp = 'America/Sao_Paulo'; // UTC-3, no DST
    expect(iso(nextOccurrence({ kind: 'daily', time: '09:00' }, sp, at('2026-10-07T11:00:00Z')))).toBe(
      '2026-10-07T12:00:00.000Z',
    );
    // Exactly at the time is not "after": the next one is tomorrow.
    expect(iso(nextOccurrence({ kind: 'daily', time: '09:00' }, sp, at('2026-10-07T12:00:00Z')))).toBe(
      '2026-10-08T12:00:00.000Z',
    );
    expect(iso(nextOccurrence({ kind: 'daily', time: '00:00' }, 'Asia/Tokyo', at('2026-10-07T16:00:00Z')))).toBe(
      '2026-10-08T15:00:00.000Z',
    );
  });

  it('weekly: only the chosen weekdays, wrapping to next week', () => {
    // 2026-10-07 is a Wednesday.
    const schedule = { kind: 'weekly' as const, days: [1, 5], time: '08:30' };
    expect(nextOccurrences(schedule, 'UTC', at('2026-10-07T10:00:00Z'), 3).map(iso)).toEqual([
      '2026-10-09T08:30:00.000Z',
      '2026-10-12T08:30:00.000Z',
      '2026-10-16T08:30:00.000Z',
    ]);
    expect(iso(nextOccurrence({ kind: 'weekly', days: [3], time: '08:30' }, 'UTC', at('2026-10-07T09:00:00Z')))).toBe(
      '2026-10-14T08:30:00.000Z',
    );
  });

  it('interval: real hours on a grid from the anchor', () => {
    const anchor = at('2026-10-07T10:00:00Z');
    expect(iso(nextOccurrence({ kind: 'interval', hours: 6 }, 'UTC', anchor, anchor))).toBe('2026-10-07T16:00:00.000Z');
    expect(iso(nextOccurrence({ kind: 'interval', hours: 6 }, 'UTC', at('2026-10-08T05:00:00Z'), anchor))).toBe(
      '2026-10-08T10:00:00.000Z',
    );
    expect(iso(nextOccurrence({ kind: 'interval', hours: 6 }, 'UTC', at('2026-10-07T16:00:00Z'), anchor))).toBe(
      '2026-10-07T22:00:00.000Z',
    );
  });

  it('interval keeps 24 real hours across a DST change (not the wall clock)', () => {
    const ny = 'America/New_York';
    const anchor = at('2026-03-07T14:00:00Z'); // 09:00 EST
    const next = nextOccurrence({ kind: 'interval', hours: 24 }, ny, anchor, anchor);
    expect(next - anchor).toBe(24 * HOUR); // 10:00 EDT on the wall clock
  });

  it('DST forward: a time that does not exist moves forward by the gap', () => {
    // New York, 2026-03-08: 02:00 jumps to 03:00.
    expect(iso(zonedTime(2026, 3, 8, 2, 30, 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z');
    const daily = { kind: 'daily' as const, time: '02:30' };
    expect(nextOccurrences(daily, 'America/New_York', at('2026-03-07T12:00:00Z'), 3).map(iso)).toEqual([
      '2026-03-08T07:30:00.000Z', // 03:30 EDT, the day without 02:30
      '2026-03-09T06:30:00.000Z', // 02:30 EDT
      '2026-03-10T06:30:00.000Z',
    ]);
    // Daily 09:00 keeps the wall clock across the change: 23 real hours that day.
    const nine = nextOccurrences({ kind: 'daily', time: '09:00' }, 'America/New_York', at('2026-03-07T15:00:00Z'), 2);
    expect(nine.map(iso)).toEqual(['2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);
    expect(at('2026-03-08T13:00:00Z') - at('2026-03-07T14:00:00Z')).toBe(23 * HOUR);
  });

  it('DST back: an ambiguous time runs once, at its first occurrence', () => {
    // New York, 2026-11-01: 02:00 EDT goes back to 01:00 EST, so 01:30 happens twice.
    const daily = { kind: 'daily' as const, time: '01:30' };
    const [first, second] = nextOccurrences(daily, 'America/New_York', at('2026-10-31T12:00:00Z'), 2);
    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    expect(iso(second)).toBe('2026-11-02T06:30:00.000Z'); // the 01:30 EST repeat is skipped
    // Southern hemisphere and a half-hour shift (Lord Howe, 2026-10-04 02:00 → 02:30).
    expect(iso(zonedTime(2026, 10, 4, 2, 0, 'Australia/Lord_Howe'))).toBe('2026-10-03T15:30:00.000Z');
    // São Paulo has had no DST since 2019; London's autumn change (2026-10-25).
    expect(
      nextOccurrences({ kind: 'daily', time: '09:00' }, 'Europe/London', at('2026-10-24T12:00:00Z'), 2).map(iso),
    ).toEqual(['2026-10-25T09:00:00.000Z', '2026-10-26T09:00:00.000Z']);
  });

  it('leap days: 29 February exists only in leap years', () => {
    const daily = { kind: 'daily' as const, time: '09:00' };
    expect(nextOccurrences(daily, 'UTC', at('2028-02-28T10:00:00Z'), 2).map(iso)).toEqual([
      '2028-02-29T09:00:00.000Z',
      '2028-03-01T09:00:00.000Z',
    ]);
    expect(iso(nextOccurrence(daily, 'UTC', at('2027-02-28T10:00:00Z')))).toBe('2027-03-01T09:00:00.000Z');
    // Weekly on Tuesday: 2028-02-29 is a Tuesday.
    expect(iso(nextOccurrence({ kind: 'weekly', days: [2], time: '07:00' }, 'UTC', at('2028-02-27T00:00:00Z')))).toBe(
      '2028-02-29T07:00:00.000Z',
    );
  });

  it('validates zones and times, and describes schedules in pt-BR', () => {
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(systemTimeZone())).toBe(true);
    expect(() => nextOccurrence({ kind: 'daily', time: '25:00' }, 'UTC', 0)).toThrow(/Horário inválido/);
    expect(() => nextOccurrence({ kind: 'weekly', days: [], time: '09:00' }, 'UTC', 0)).toThrow(/sem ocorrências/);
    expect(describeSchedule({ kind: 'daily', time: '09:00' })).toBe('Diária às 09:00');
    expect(describeSchedule({ kind: 'weekly', days: [3, 1], time: '09:00' })).toBe('Seg, Qua às 09:00');
    expect(describeSchedule({ kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '07:00' })).toBe(
      'Todos os dias às 07:00',
    );
    expect(describeSchedule({ kind: 'interval', hours: 6 })).toBe('A cada 6 h');
  });
});

/**
 * Provider whose turns end when the test says so. A prompt with [aprovar] asks for one
 * approval and answers with the decision it got.
 */
function scriptedProvider() {
  const inputs: RunInput[] = [];
  const open: { input: RunInput; resolve: (r: RunResult) => void }[] = [];
  const decisions: { id: string; decision: 'approve' | 'deny' }[] = [];
  const pending = new Map<string, (decision: 'approve' | 'deny') => void>();
  const providers: ProviderRegistry = {
    async list() {
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: '',
          models: [
            { id: 'm', name: 'm', isDefault: true },
            { id: 'outro', name: 'outro' },
          ],
          defaultModel: 'm',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true },
        },
      ];
    },
    run(input, emit, signal) {
      inputs.push(input);
      return new Promise<RunResult>((resolve) => {
        const turn = { input, resolve };
        open.push(turn);
        signal.addEventListener(
          'abort',
          () => {
            open.splice(open.indexOf(turn), 1);
            resolve({ text: '', stopReason: 'cancelled' });
          },
          { once: true },
        );
        if (input.prompt.includes('[aprovar]')) {
          const id = `ap-${input.runId}`;
          pending.set(id, (decision) => {
            open.splice(open.indexOf(turn), 1);
            emit({ type: 'delta', text: decision });
            resolve({ text: decision, stopReason: 'completed' });
          });
          emit({
            type: 'approval',
            approval: {
              id,
              runId: input.runId,
              sessionId: input.sessionId,
              title: 'Rodar comando',
              detail: 'echo',
              kind: 'command',
              status: 'pending',
            },
          });
        }
      });
    },
    async approve(id, decision) {
      decisions.push({ id, decision });
      pending.get(id)?.(decision);
      pending.delete(id);
    },
    async shutdown() {},
  };
  return {
    providers,
    inputs,
    decisions,
    get openTurns() {
      return open.length;
    },
    finish(text = 'feito') {
      const turn = open.shift()!;
      turn.resolve({ text, stopReason: 'completed' });
    },
  };
}

function automation(over: Partial<Automation> = {}): Automation {
  const now = new Date().toISOString();
  return {
    id: 'a1',
    name: 'Revisão',
    prompt: 'revise o projeto',
    projectId: 'p',
    schedule: { kind: 'daily', time: '09:00' },
    timezone: 'UTC',
    enabled: true,
    catchUp: false,
    denyApprovalsAfterMinutes: 30,
    anchorAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/**
 * A backend over a fresh store, with fake timers and Date. `before` prepares the store before
 * the scheduler starts (startup and catch-up cases).
 */
function setup(
  opts: {
    global?: boolean;
    now?: string;
    dir?: string;
    before?: (store: Store) => void;
    settings?: Partial<Settings>;
  } = {},
) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: at(opts.now ?? '2026-10-07T08:00:00Z') });
  const dir = opts.dir ?? tempDir();
  const store = new Store(dir);
  if (!store.getProject('p'))
    store.putProject({
      id: 'p',
      name: 'Projeto',
      path: dir,
      createdAt: new Date().toISOString(),
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
  store.setSettings({
    ...store.getSettings()!,
    autoRetry: false,
    automations: opts.global ?? true,
    ...opts.settings,
  });
  opts.before?.(store);
  const provider = scriptedProvider();
  const backend = createBackend(store, provider.providers, undefined, undefined, { retries: 0 });
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(0);
    // Fake timers advance scheduler work, not subprocess I/O (for example the async Git probe).
    // Let the real event loop process bounded I/O turns without advancing or sleeping fake time.
    const deadline = performance.now() + 40;
    for (let turns = 0; turns < 10_000 && performance.now() < deadline; turns++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const runEnded = async () => {
    for (let i = 0; i < 50 && backend.orchestrator.isActive(get().conversationId ?? ''); i++) await flush();
  };
  const get = (id = 'a1') => store.getAutomation(id)!;
  return {
    store,
    provider,
    ...backend,
    flush,
    runEnded,
    get,
    close: async () => {
      backend.automations.stop();
      await backend.orchestrator.shutdown();
      store.close();
    },
  };
}

describe('scheduler', () => {
  it('fires at the due time, writes into its own conversation and reuses it', async () => {
    const t = setup({
      before: (store) => store.putAutomation(automation({ nextRunAt: '2026-10-07T09:00:00.000Z' })),
    });
    try {
      expect(t.automations.armed).toBe(true);
      await vi.advanceTimersByTimeAsync(HOUR - 1);
      expect(t.provider.inputs).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await t.flush();
      expect(t.provider.inputs).toHaveLength(1);
      const first = t.get();
      expect(first.lastResult).toMatchObject({ status: 'running', trigger: 'schedule' });
      expect(first.nextRunAt).toBe('2026-10-08T09:00:00.000Z');
      const session = t.store.getSession(first.conversationId!)!;
      expect(session).toMatchObject({ title: '⏱ Revisão', projectId: 'p', providerId: 'codex' });
      const user = t.store.listMessages(session.id).find((m) => m.role === 'user')!;
      expect(user).toMatchObject({ content: 'revise o projeto', automationId: 'a1' });

      t.provider.finish();
      await t.runEnded();
      await t.flush();
      expect(t.get().lastResult?.status).toBe('completed');

      await vi.advanceTimersByTimeAsync(24 * HOUR);
      await t.flush();
      expect(t.provider.inputs).toHaveLength(2);
      expect(t.get().conversationId).toBe(session.id);
      expect(t.store.listSessions().filter((s) => s.title === '⏱ Revisão')).toHaveLength(1);
      expect(
        t.store
          .listMessages(session.id)
          .filter((m) => m.role === 'user')
          .map((m) => m.automationId),
      ).toEqual(['a1', 'a1']);
      t.provider.finish();
      await t.runEnded();
    } finally {
      await t.close();
    }
  });

  it('never runs while the global switch is off, and turning it on fires no backlog', async () => {
    const t = setup({
      global: false,
      before: (store) => store.putAutomation(automation({ nextRunAt: '2026-10-07T09:00:00.000Z' })),
    });
    try {
      expect(t.automations.armed).toBe(false);
      await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
      expect(t.provider.inputs).toHaveLength(0);
      const fired = await t.automations.fire('a1', 'manual');
      expect(fired).toMatchObject({ ok: false, status: 409 });
      expect(t.provider.inputs).toHaveLength(0);
      // The list shows a future next run, not the stale one.
      expect(Date.parse(t.automations.list()[0].nextRunAt!)).toBeGreaterThan(Date.now());

      t.store.setSettings({ ...t.store.getSettings()!, automations: true });
      t.automations.globalChanged();
      await t.flush();
      expect(t.provider.inputs).toHaveLength(0);
      expect(t.get().nextRunAt).toBe('2026-10-10T09:00:00.000Z');
      expect(t.automations.armed).toBe(true);
      t.store.setSettings({ ...t.store.getSettings()!, automations: false });
      t.automations.globalChanged();
      expect(t.automations.armed).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('disabled automations do not run', async () => {
    const t = setup({ before: (store) => store.putAutomation(automation({ enabled: false })) });
    try {
      await vi.advanceTimersByTimeAsync(3 * 24 * HOUR);
      expect(t.provider.inputs).toHaveLength(0);
      expect(t.automations.armed).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('skips an occurrence while its conversation has a run, and never runs two at once', async () => {
    const t = setup({
      before: (store) =>
        store.putAutomation(
          automation({ schedule: { kind: 'interval', hours: 1 }, nextRunAt: '2026-10-07T09:00:00.000Z' }),
        ),
    });
    try {
      await vi.advanceTimersByTimeAsync(HOUR);
      await t.flush();
      expect(t.provider.inputs).toHaveLength(1);
      const runId = t.get().lastResult!.runId;
      await vi.advanceTimersByTimeAsync(HOUR);
      await t.flush();
      expect(t.provider.inputs).toHaveLength(1);
      expect(t.provider.openTurns).toBe(1);
      expect(t.get().lastResult).toMatchObject({ status: 'skipped', detail: AUTOMATION_SKIPPED_ACTIVE });
      // "Executar agora" follows the same rule.
      expect(await t.automations.fire('a1', 'manual')).toMatchObject({ ok: false, status: 409 });
      // Concurrent manual starts: only one goes through.
      t.provider.finish();
      await t.runEnded();
      const [a, b] = await Promise.all([t.automations.fire('a1', 'manual'), t.automations.fire('a1', 'manual')]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      await t.flush();
      expect(t.provider.openTurns).toBe(1);
      expect(t.get().lastResult?.runId).not.toBe(runId);
      t.provider.finish();
      await t.runEnded();
    } finally {
      await t.close();
    }
  });

  it('catchUp on startup: one run when true, none when false; both move to the next occurrence', async () => {
    const missed = '2026-10-06T09:00:00.000Z';
    const t = setup({
      now: '2026-10-07T08:00:00Z',
      before: (store) => {
        store.putAutomation(automation({ id: 'a1', catchUp: true, nextRunAt: missed }));
        store.putAutomation(automation({ id: 'a2', name: 'Sem recuperar', catchUp: false, nextRunAt: missed }));
      },
    });
    try {
      await t.flush();
      expect(t.provider.inputs).toHaveLength(1);
      expect(t.get('a1').lastResult).toMatchObject({ trigger: 'catch-up' });
      expect(t.get('a2').lastResult).toBeUndefined();
      expect(t.get('a1').nextRunAt).toBe('2026-10-07T09:00:00.000Z');
      expect(t.get('a2').nextRunAt).toBe('2026-10-07T09:00:00.000Z');
      t.provider.finish();
      await t.runEnded();
    } finally {
      await t.close();
    }
  });

  it('a timer that fires late (computer asleep) counts as missed', async () => {
    const t = setup({
      before: (store) => store.putAutomation(automation({ catchUp: false, nextRunAt: '2026-10-07T08:10:00.000Z' })),
    });
    try {
      // Suspend: the clock jumps well past the due time without the timer firing on time.
      vi.setSystemTime(at('2026-10-07T08:10:00Z') + LATE_TOLERANCE_MS + 60_000);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.provider.inputs).toHaveLength(0);
      expect(t.get().nextRunAt).toBe('2026-10-07T09:00:00.000Z');
    } finally {
      await t.close();
    }
  });

  it('caps a single wait, so far-off occurrences are re-evaluated', async () => {
    const t = setup({
      before: (store) =>
        store.putAutomation(
          automation({ schedule: { kind: 'interval', hours: 168 }, nextRunAt: '2026-10-14T08:00:00.000Z' }),
        ),
    });
    try {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(MAX_WAIT_MS);
      expect(t.automations.armed).toBe(true);
      expect(t.provider.inputs).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it('records runs cut by a restart and recreates a deleted conversation', async () => {
    const dir = tempDir();
    const first = setup({
      dir,
      before: (store) => store.putAutomation(automation({ nextRunAt: '2026-10-07T09:00:00.000Z' })),
    });
    await vi.advanceTimersByTimeAsync(HOUR);
    await first.flush();
    const conversation = first.get().conversationId!;
    first.automations.stop();
    first.store.close();
    vi.useRealTimers();

    const second = setup({ dir, now: '2026-10-07T09:05:00Z' });
    try {
      expect(second.get().lastResult?.status).toBe('interrupted');
      second.store.deleteSession(conversation);
      const fired = await second.automations.fire('a1', 'manual');
      expect(fired.ok).toBe(true);
      await second.flush();
      expect(second.get().conversationId).not.toBe(conversation);
      expect(second.store.getSession(second.get().conversationId!)?.title).toBe('⏱ Revisão');
      second.provider.finish();
      await second.runEnded();
    } finally {
      await second.close();
    }
  });

  it('applies the automation agent, model and mode to its conversation', async () => {
    const t = setup({
      before: (store) => store.putAutomation(automation({ model: 'outro', mode: 'deep' })),
    });
    try {
      expect((await t.automations.fire('a1', 'manual')).ok).toBe(true);
      await t.flush();
      const session = t.store.getSession(t.get().conversationId!)!;
      expect(session).toMatchObject({ model: 'outro', mode: 'deep' });
      expect(t.provider.inputs[0].model).toBe('outro');
      t.provider.finish();
      await t.runEnded();
      t.store.putAutomation({ ...t.get(), model: 'm', name: 'Renomeada' });
      expect((await t.automations.fire('a1', 'manual')).ok).toBe(true);
      await t.flush();
      expect(t.store.getSession(session.id)).toMatchObject({ model: 'm', title: '⏱ Renomeada' });
      t.provider.finish();
      await t.runEnded();
    } finally {
      await t.close();
    }
  });

  it('a saved command or /plano in the prompt works like a typed message', async () => {
    const t = setup({ before: (store) => store.putAutomation(automation({ prompt: '/revisar o módulo X' })) });
    try {
      expect((await t.automations.fire('a1', 'manual')).ok).toBe(true);
      await t.flush();
      // The built-in /revisar template reached the agent; the message keeps what was written.
      expect(t.provider.inputs[0].prompt).not.toMatch(/^\/revisar/);
      expect(t.provider.inputs[0].prompt).toContain('o módulo X');
      const user = t.store.listMessages(t.get().conversationId!).find((m) => m.role === 'user')!;
      expect(user.content).toBe('/revisar o módulo X');
      t.provider.finish();
      await t.runEnded();
    } finally {
      await t.close();
    }
  });

  it('records a failed start (missing project) without throwing', async () => {
    const t = setup({ before: (store) => store.putAutomation(automation()) });
    try {
      t.store.db.exec('PRAGMA foreign_keys=OFF');
      t.store.db.prepare('DELETE FROM projects').run();
      const fired = await t.automations.fire('a1', 'manual');
      expect(fired).toMatchObject({ ok: false, status: 404 });
      expect(t.get().lastResult).toMatchObject({ status: 'failed', detail: 'Projeto não encontrado' });
      await expect(t.automations.fire('missing', 'manual')).rejects.toThrow('Automação não encontrada');
    } finally {
      await t.close();
    }
  });

  it('a usage limit already reached stops the automation before any model call', async () => {
    const t = setup({
      settings: { spendLimits: { enabled: true, dailyTokens: 0 } },
      before: (store) => store.putAutomation(automation()),
    });
    try {
      const fired = await t.automations.fire('a1', 'manual');
      expect(fired).toMatchObject({ ok: false, status: 409 });
      expect(t.get().lastResult).toMatchObject({ status: 'failed' });
      expect(t.get().lastResult?.detail).toMatch(/Limite de uso atingido/);
      expect(t.provider.inputs).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it('auto-denies a pending approval of an automated run after the timeout, never approves', async () => {
    const t = setup({
      before: (store) => store.putAutomation(automation({ prompt: '[aprovar] rode', denyApprovalsAfterMinutes: 5 })),
    });
    try {
      expect((await t.automations.fire('a1', 'manual')).ok).toBe(true);
      await t.flush();
      const sessionId = t.get().conversationId!;
      expect(t.store.listApprovals(sessionId)[0].status).toBe('pending');
      expect(t.automations.pendingDenials).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(t.provider.decisions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await t.runEnded();
      expect(t.provider.decisions).toEqual([{ id: expect.any(String), decision: 'deny' }]);
      expect(t.store.listApprovals(sessionId)[0].status).toBe('denied');
      expect(t.store.listEvents(sessionId).some((e) => /Negado automaticamente após 5 min/.test(e.text))).toBe(true);
      expect(t.automations.pendingDenials).toBe(0);
      expect(t.get().lastResult?.status).toBe('completed');
    } finally {
      await t.close();
    }
  });

  it('leaves approvals alone when answered in time, when disabled, and outside automations', async () => {
    const t = setup({
      before: (store) => {
        store.putAutomation(automation({ prompt: '[aprovar] rode', denyApprovalsAfterMinutes: 5 }));
        store.putAutomation(automation({ id: 'a2', prompt: '[aprovar] espere', denyApprovalsAfterMinutes: null }));
      },
    });
    try {
      // Answered by the user in time: the timer is cleared.
      await t.automations.fire('a1', 'manual');
      await t.flush();
      const first = t.store.listApprovals(t.get().conversationId!)[0];
      await t.orchestrator.decide(first.id, first.sessionId, 'approve');
      expect(t.automations.pendingDenials).toBe(0);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.provider.decisions).toEqual([{ id: first.id, decision: 'approve' }]);

      // Option off: the run keeps waiting.
      await t.automations.fire('a2', 'manual');
      await t.flush();
      expect(t.automations.pendingDenials).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(t.store.listApprovals(t.get('a2').conversationId!)[0].status).toBe('pending');

      // A conversation the user started is never touched.
      const now = new Date().toISOString();
      const manual = t.store.putSession({
        id: 'manual',
        projectId: 'p',
        title: 'Minha',
        providerId: 'codex',
        mode: 'fast',
        createdAt: now,
        updatedAt: now,
      });
      await t.orchestrator.start(manual, '[aprovar] manual');
      await t.flush();
      expect(t.automations.pendingDenials).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(t.store.listApprovals('manual')[0].status).toBe('pending');
      expect(t.provider.decisions.filter((d) => d.decision === 'approve')).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('stop() clears the scheduler timer and the approval timers', async () => {
    const t = setup({
      before: (store) =>
        store.putAutomation(automation({ prompt: '[aprovar] rode', nextRunAt: '2026-10-07T09:00:00Z' })),
    });
    try {
      await t.automations.fire('a1', 'manual');
      await t.flush();
      expect(t.automations.armed).toBe(true);
      expect(t.automations.pendingDenials).toBe(1);
      t.automations.stop();
      expect(t.automations.armed).toBe(false);
      expect(t.automations.pendingDenials).toBe(0);
      t.automations.reschedule();
      expect(t.automations.armed).toBe(false);
      await vi.advanceTimersByTimeAsync(2 * HOUR);
      expect(t.provider.decisions).toEqual([]);
      expect(t.provider.inputs).toHaveLength(1);
    } finally {
      await t.close();
    }
  });
});

describe('automations API', () => {
  async function serve(global = false) {
    const dir = tempDir();
    const store = new Store(dir);
    store.putProject({
      id: 'p',
      name: 'Projeto',
      path: dir,
      createdAt: new Date().toISOString(),
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    store.setSettings({ ...store.getSettings()!, autoRetry: false, automations: global });
    const provider = scriptedProvider();
    const backend = createBackend(store, provider.providers, undefined, undefined, { retries: 0 });
    const server = createServer(backend.app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', origin: base },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
    };
    return {
      store,
      provider,
      call,
      ...backend,
      close: async () => {
        backend.automations.stop();
        await backend.orchestrator.shutdown();
        store.close();
      },
    };
  }
  const valid = { name: 'Diária', prompt: 'revise', projectId: 'p', schedule: { kind: 'daily', time: '09:00' } };

  it('validates the body with the API messages', async () => {
    const t = await serve();
    try {
      const create = (body: unknown) => t.call('POST', '/api/automations', body);
      expect((await create({ ...valid, name: ' ' })).body.error).toMatch(/Nome obrigatório/);
      expect((await create({ ...valid, prompt: 'x'.repeat(8001) })).body.error).toMatch(/Pedido obrigatório/);
      expect((await create({ ...valid, projectId: undefined })).body.error).toMatch(/projectId obrigatório/);
      expect((await create({ ...valid, projectId: null })).status).toBe(400);
      expect((await create({ ...valid, projectId: 'nope' })).status).toBe(404);
      for (const schedule of [
        { kind: 'daily', time: '9:00' },
        { kind: 'daily', time: '24:00' },
        { kind: 'weekly', days: [], time: '09:00' },
        { kind: 'weekly', days: [7], time: '09:00' },
        { kind: 'weekly', days: [1, 1], time: '09:00' },
        { kind: 'interval', hours: 0 },
        { kind: 'interval', hours: 169 },
        { kind: 'interval', hours: 1.5 },
        { kind: 'cron', expr: '* * * * *' },
      ])
        expect((await create({ ...valid, schedule })).body.error).toMatch(/Agenda inválida/);
      expect((await create({ ...valid, timezone: 'Mars/Base' })).body.error).toMatch(/Fuso horário/);
      expect((await create({ ...valid, denyApprovalsAfterMinutes: 0 })).status).toBe(400);
      expect((await create({ ...valid, model: 'inexistente' })).status).toBe(400);
      expect((await create({ ...valid, providerId: 'nope' })).status).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('creates disabled by default, edits, enables, lists and deletes', async () => {
    const t = await serve();
    try {
      const created = await t.call('POST', '/api/automations', {
        ...valid,
        schedule: { kind: 'weekly', days: [5, 1], time: '08:00' },
        timezone: 'America/Sao_Paulo',
      });
      expect(created.status).toBe(201);
      const a = created.body as Automation;
      expect(a).toMatchObject({
        enabled: false,
        catchUp: false,
        denyApprovalsAfterMinutes: 30,
        timezone: 'America/Sao_Paulo',
        schedule: { kind: 'weekly', days: [1, 5], time: '08:00' },
      });
      expect(a.nextRunAt).toBeUndefined();
      // Default zone is the system's.
      const plain = (await t.call('POST', '/api/automations', valid)).body as Automation;
      expect(plain.timezone).toBe(systemTimeZone());

      const listed = await t.call('GET', '/api/automations');
      expect(listed.body).toMatchObject({ enabled: false });
      expect(listed.body.automations.map((x: Automation) => x.id)).toEqual([a.id, plain.id]);

      const enabled = (await t.call('PATCH', `/api/automations/${a.id}`, { enabled: true })).body as Automation;
      expect(enabled.enabled).toBe(true);
      expect(Date.parse(enabled.nextRunAt!)).toBeGreaterThan(Date.now());
      const edited = (
        await t.call('PATCH', `/api/automations/${a.id}`, {
          name: 'Semanal',
          schedule: { kind: 'interval', hours: 2 },
          model: 'outro',
          mode: 'deep',
          catchUp: true,
          denyApprovalsAfterMinutes: null,
        })
      ).body as Automation;
      expect(edited).toMatchObject({ name: 'Semanal', model: 'outro', mode: 'deep', catchUp: true });
      expect(edited.denyApprovalsAfterMinutes).toBeNull();
      expect(Date.parse(edited.nextRunAt!) - Date.parse(edited.anchorAt)).toBe(2 * HOUR);
      const reset = (await t.call('PATCH', `/api/automations/${a.id}`, { model: null, mode: null })).body;
      expect(reset.model).toBeUndefined();
      expect(reset.mode).toBeUndefined();
      expect((await t.call('PATCH', `/api/automations/${a.id}`, { model: 'inexistente' })).status).toBe(400);
      expect((await t.call('PATCH', `/api/automations/${a.id}`, { projectId: 'nope' })).status).toBe(404);
      expect((await t.call('PATCH', `/api/automations/${a.id}`, { schedule: { kind: 'x' } })).status).toBe(400);
      const off = (await t.call('PATCH', `/api/automations/${a.id}`, { enabled: false })).body;
      expect(off.nextRunAt).toBeUndefined();
      expect((await t.call('PATCH', '/api/automations/nope', { enabled: true })).status).toBe(404);

      expect((await t.call('DELETE', `/api/automations/${a.id}`, {})).status).toBe(204);
      expect((await t.call('DELETE', `/api/automations/${a.id}`, {})).status).toBe(404);
      expect(t.store.getAutomation(a.id)).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  it('"Executar agora" needs the global switch, then runs and keeps the conversation', async () => {
    const t = await serve(false);
    try {
      const a = (await t.call('POST', '/api/automations', valid)).body as Automation;
      const refused = await t.call('POST', `/api/automations/${a.id}/run`, {});
      expect(refused.status).toBe(409);
      expect(refused.body.error).toMatch(/desativadas/);
      expect((await t.call('POST', '/api/automations/nope/run', {})).status).toBe(404);

      expect((await t.call('PATCH', '/api/settings', { automations: true })).body.automations).toBe(true);
      expect((await t.call('PATCH', '/api/settings', { automations: 'sim' })).status).toBe(400);
      // A disabled automation still runs on request: the toggle is about the schedule.
      const ran = await t.call('POST', `/api/automations/${a.id}/run`, {});
      expect(ran.status).toBe(202);
      expect(ran.body.runId).toBeTruthy();
      const conversationId = ran.body.automation.conversationId;
      const idle = async () => {
        for (let i = 0; i < 100 && t.orchestrator.isActive(conversationId); i++)
          await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 20));
      };
      await idle();
      t.provider.finish();
      await idle();
      expect(t.store.getAutomation(a.id)!.lastResult).toMatchObject({ status: 'completed', trigger: 'manual' });
      // Busy: the second occurrence is skipped and recorded as the last result.
      const again = await t.call('POST', `/api/automations/${a.id}/run`, {});
      expect(again.body.automation.conversationId).toBe(conversationId);
      const busy = await t.call('POST', `/api/automations/${a.id}/run`, {});
      expect(busy.status).toBe(409);
      expect(busy.body.automation.lastResult).toMatchObject({ status: 'skipped', detail: AUTOMATION_SKIPPED_ACTIVE });
      await idle();
      t.provider.finish();
      await idle();
      expect(t.store.getAutomation(a.id)!.lastResult?.status).toBe('skipped');

      // Renaming renames its conversation; deleting the automation keeps the conversation.
      await t.call('PATCH', `/api/automations/${a.id}`, { name: 'Nova' });
      expect(t.store.getSession(conversationId)?.title).toBe('⏱ Nova');
      // Moving it to another project drops the link; the next run creates a new conversation.
      t.store.putProject({ ...t.store.getProject('p')!, id: 'q', name: 'Outro' });
      const moved = (await t.call('PATCH', `/api/automations/${a.id}`, { projectId: 'q' })).body as Automation;
      expect(moved.conversationId).toBeUndefined();
      await t.call('DELETE', `/api/automations/${a.id}`, {});
      expect(t.store.getSession(conversationId)).toBeTruthy();
      const exported = (await t.call('GET', '/api/export')).body;
      expect(exported.automations).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe('migration 10', () => {
  it('creates the automations table, cascading from projects', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 8),
    );
    db.exec(`INSERT INTO projects VALUES('p','{}'); INSERT INTO projects VALUES('q','{}');`);
    const result = migrate(db, dir);
    expect(result.applied).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO automations VALUES('a','p','{}');
      INSERT INTO automations VALUES('b','q','{}');`);
    expect(() => db.exec(`INSERT INTO automations VALUES('x','missing','{}')`)).toThrow();
    expect(() => db.exec(`INSERT INTO automations VALUES('y',NULL,'{}')`)).toThrow();
    db.exec(`DELETE FROM projects WHERE id='p';`);
    expect(db.prepare('SELECT id FROM automations').all()).toEqual([{ id: 'b' }]);
    db.close();
  });

  it('deleting a project through the store removes its automations', () => {
    const store = new Store(tempDir());
    store.putProject({
      id: 'p',
      name: 'P',
      path: '/tmp',
      createdAt: new Date().toISOString(),
      memoryWorkspace: 'w',
      memoryProject: 'p',
    });
    store.putAutomation(automation());
    expect(store.listAutomations()).toHaveLength(1);
    store.db.prepare('DELETE FROM projects WHERE id=?').run('p');
    expect(store.listAutomations()).toEqual([]);
    store.close();
  });
});
