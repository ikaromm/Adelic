import { describe, expect, it } from 'vitest';
import type { Approval, Run, StreamEvent } from '../shared/contracts';
import {
  badgeTitle,
  decide,
  defaultNotifications,
  isAttentive,
  noticeFor,
  notificationsEnabled,
} from '../src/hooks/useRunNotifications';

const run = (patch: Partial<Run>): Run => ({
  id: 'r1',
  sessionId: 's1',
  providerId: 'codex',
  status: 'running',
  route: { level: 'fast', reason: '', tools: false, memory: false, contextBudget: 0 },
  startedAt: '2026-10-06T00:00:00Z',
  ...patch,
});
const approval = (patch: Partial<Approval>): Approval => ({
  id: 'a1',
  runId: 'r1',
  sessionId: 's1',
  title: 'Executar comando de teste',
  detail: 'rm -rf segredo',
  kind: 'command',
  status: 'pending',
  ...patch,
});
const titles = (id: string) => (id === 's1' ? 'Planejar a viagem' : undefined);

describe('run notifications: which event becomes which notice', () => {
  it('announces a completed run with the conversation title only', () => {
    expect(noticeFor({ type: 'run', run: run({ status: 'completed' }) }, titles)).toEqual({
      key: 'run:r1:completed',
      sessionId: 's1',
      title: 'Resposta pronta',
      body: 'Planejar a viagem',
    });
  });

  it('announces a failure with the classified reason, falling back to a clipped error', () => {
    const failed = run({
      status: 'failed',
      error: 'stack trace…',
      failure: { kind: 'transient', reason: 'tempo esgotado', retryable: true },
    });
    expect(noticeFor({ type: 'run', run: failed }, titles)?.body).toBe('Planejar a viagem: tempo esgotado');
    const long = noticeFor({ type: 'run', run: run({ status: 'failed', error: 'x'.repeat(500) }) }, titles);
    expect(long?.title).toBe('Execução falhou');
    expect(long!.body.length).toBeLessThan(220);
    expect(noticeFor({ type: 'run', run: run({ status: 'failed' }) }, () => undefined)?.body).toBe(
      'Conversa: erro não informado',
    );
  });

  it('announces a pending approval by its title, never its command detail', () => {
    const notice = noticeFor({ type: 'approval', approval: approval({}) }, titles);
    expect(notice).toMatchObject({ key: 'approval:a1', title: 'Aprovação necessária' });
    expect(notice?.body).toBe('Executar comando de teste · Planejar a viagem');
    expect(notice?.body).not.toContain('rm -rf');
  });

  it('ignores running and cancelled runs, decided approvals and content events', () => {
    const ignored: StreamEvent[] = [
      { type: 'run', run: run({ status: 'running' }) },
      { type: 'run', run: run({ status: 'cancelled' }) },
      { type: 'approval', approval: approval({ status: 'approved' }) },
      { type: 'approval', approval: approval({ status: 'denied' }) },
      { type: 'delta', sessionId: 's1', runId: 'r1', messageId: 'm1', text: 'segredo' },
      { type: 'refresh' },
    ];
    for (const event of ignored) expect(noticeFor(event, titles)).toBeNull();
  });
});

describe('run notifications: focus rules and dedupe', () => {
  const completed = noticeFor({ type: 'run', run: run({ status: 'completed' }) }, titles);

  it('stays quiet while the reader is looking, and only counts each outcome once', () => {
    const seen = new Set<string>();
    expect(decide(completed, { seen, attentive: true, enabled: true })).toBe('none');
    // The same run outcome repeated later (for example after the window lost focus) is not announced.
    expect(decide(completed, { seen, attentive: false, enabled: true })).toBe('none');
  });

  it('notifies in the background when enabled, otherwise only raises the title badge', () => {
    expect(decide(completed, { seen: new Set(), attentive: false, enabled: true })).toBe('notify');
    expect(decide(completed, { seen: new Set(), attentive: false, enabled: false })).toBe('badge');
    expect(decide(null, { seen: new Set(), attentive: false, enabled: true })).toBe('none');
  });

  it('treats a run that completes and a new run of the same conversation as separate outcomes', () => {
    const seen = new Set<string>();
    const second = noticeFor({ type: 'run', run: run({ id: 'r2', status: 'completed' }) }, titles);
    expect(decide(completed, { seen, attentive: false, enabled: true })).toBe('notify');
    expect(decide(second, { seen, attentive: false, enabled: true })).toBe('notify');
  });

  it('is attentive only when visible and focused', () => {
    expect(isAttentive({ hidden: false, hasFocus: () => true })).toBe(true);
    expect(isAttentive({ hidden: true, hasFocus: () => true })).toBe(false);
    expect(isAttentive({ hidden: false, hasFocus: () => false })).toBe(false);
  });

  it('badges the title with the pending count', () => {
    expect(badgeTitle('Adelic', 0)).toBe('Adelic');
    expect(badgeTitle('Adelic', 2)).toBe('(2) Adelic');
  });
});

describe('run notifications: default setting', () => {
  const electron = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 adelic/0.4.0 Chrome/140 Electron/44.5.1';
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
  it('is on in the desktop app and off in a browser until chosen', () => {
    expect(defaultNotifications(electron)).toBe(true);
    expect(defaultNotifications(chrome)).toBe(false);
    expect(notificationsEnabled({}, electron)).toBe(true);
    expect(notificationsEnabled({}, chrome)).toBe(false);
    expect(notificationsEnabled({ notifications: false }, electron)).toBe(false);
    expect(notificationsEnabled({ notifications: true }, chrome)).toBe(true);
  });
});
