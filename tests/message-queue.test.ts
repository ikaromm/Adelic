import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Orchestrator } from '../server/orchestrator.js';
import { Store } from '../server/store.js';
import {
  QUEUE_LIMIT,
  type MessageQueue,
  type ProviderRegistry,
  type RunInput,
  type RunResult,
  type Session,
  type StreamEvent,
} from '../shared/contracts.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))),
  );
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A provider whose turns finish only when the test says so: `finish(text)` completes the
 * oldest open turn, `fail(text)` makes it throw. Aborts settle as cancelled.
 */
function scriptedProvider(opts: { steer?: boolean } = {}) {
  const open: { input: RunInput; resolve: (r: RunResult) => void; reject: (e: Error) => void }[] = [];
  const prompts: string[] = [];
  const steered: { runId: string; content: string }[] = [];
  const waiters: (() => void)[] = [];
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
          models: [{ id: 'm', name: 'm', isDefault: true }],
          defaultModel: 'm',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true, steer: opts.steer },
        },
      ];
    },
    run(input, emit, signal) {
      prompts.push(input.prompt);
      return new Promise<RunResult>((resolve, reject) => {
        const turn = {
          input,
          resolve: (r: RunResult) => {
            emit({ type: 'delta', text: r.text });
            resolve(r);
          },
          reject,
        };
        open.push(turn);
        signal.addEventListener(
          'abort',
          () => {
            open.splice(open.indexOf(turn), 1);
            resolve({ text: '', stopReason: 'cancelled' });
          },
          { once: true },
        );
        for (const w of waiters.splice(0)) w();
      });
    },
    async approve() {},
    async shutdown() {},
    ...(opts.steer
      ? {
          async steer(runId: string, content: string) {
            steered.push({ runId, content });
          },
        }
      : {}),
  };
  const turnStarted = async (count: number) => {
    while (prompts.length < count) await new Promise<void>((r) => waiters.push(r));
  };
  return {
    providers,
    prompts,
    steered,
    turnStarted,
    finish(text = 'ok') {
      open.shift()!.resolve({ text, stopReason: 'completed' });
    },
    fail(message = 'boom') {
      open.shift()!.reject(new Error(message));
    },
  };
}

function setup(opts: { steer?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'adelic-queue-'));
  if (!opts.dir) dirs.push(dir);
  const store = new Store(dir);
  const now = new Date().toISOString();
  const session: Session = {
    id: 's',
    projectId: null,
    title: 'T',
    providerId: 'codex',
    mode: 'fast',
    createdAt: now,
    updatedAt: now,
  };
  if (!store.getSession('s')) store.putSession(session);
  const provider = scriptedProvider(opts);
  // Retries off: a failed turn fails the run right away.
  store.setSettings({ ...store.getSettings()!, autoRetry: false });
  const orchestrator = new Orchestrator(store, provider.providers, undefined, undefined, undefined, { retries: 0 });
  const events: StreamEvent[] = [];
  orchestrator.subscribe((e) => events.push(e));
  /** Resolves when the run that is currently active (or the next one) finishes. */
  const runEnded = () =>
    new Promise<string>((resolve) => {
      const off = orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.status !== 'running') {
          off();
          // afterRun runs synchronously right after the final run event.
          queueMicrotask(() => resolve(e.run.status));
        }
      });
    });
  const userMessages = () =>
    store
      .listMessages('s')
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
  return { dir, store, session, orchestrator, provider, events, runEnded, userMessages };
}

const contents = (queue: MessageQueue) => queue.items.map((i) => i.content);

describe('message queue in the orchestrator', () => {
  it('starts the next queued message after a completed run, in order', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'primeira');
    await t.provider.turnStarted(1);
    await t.orchestrator.enqueue('s', 'segunda');
    await t.orchestrator.enqueue('s', 'terceira');
    expect(contents(t.orchestrator.queue('s'))).toEqual(['segunda', 'terceira']);

    let ended = t.runEnded();
    t.provider.finish();
    expect(await ended).toBe('completed');
    await t.provider.turnStarted(2);
    expect(contents(t.orchestrator.queue('s'))).toEqual(['terceira']);
    expect(t.userMessages()).toEqual(['primeira', 'segunda']);

    ended = t.runEnded();
    t.provider.finish();
    await ended;
    await t.provider.turnStarted(3);
    expect(t.userMessages()).toEqual(['primeira', 'segunda', 'terceira']);
    expect(t.orchestrator.queue('s').items).toEqual([]);
    // Every queue change is published for the UI.
    expect(t.events.filter((e) => e.type === 'queue').length).toBeGreaterThanOrEqual(4);
    ended = t.runEnded();
    t.provider.finish();
    await ended;
  });

  it('starts right away when the conversation is idle', async () => {
    const t = setup();
    const result = await t.orchestrator.enqueue('s', 'agora');
    expect(result.started?.runId).toBeTruthy();
    expect(t.orchestrator.queue('s').items).toEqual([]);
    await t.provider.turnStarted(1);
    const ended = t.runEnded();
    t.provider.finish();
    await ended;
  });

  it('pauses the queue when the user cancels, and resumes on request', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    await t.orchestrator.enqueue('s', 'depois');
    const ended = t.runEnded();
    await t.orchestrator.cancel('s');
    expect(await ended).toBe('cancelled');
    const paused = t.orchestrator.queue('s');
    expect(paused.paused?.reason).toBe('cancelled');
    expect(contents(paused)).toEqual(['depois']);
    expect(t.orchestrator.isActive('s')).toBe(false);

    const resumed = await t.orchestrator.resumeQueue('s');
    expect(resumed.started?.runId).toBeTruthy();
    expect(resumed.queue).toMatchObject({ items: [] });
    expect(resumed.queue.paused).toBeUndefined();
    await t.provider.turnStarted(2);
    expect(t.userMessages()).toEqual(['longa', 'depois']);
    const done = t.runEnded();
    t.provider.finish();
    await done;
  });

  it('pauses the queue when the run fails', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'quebra');
    await t.provider.turnStarted(1);
    await t.orchestrator.enqueue('s', 'espera');
    const ended = t.runEnded();
    t.provider.fail('falhou de vez');
    expect(await ended).toBe('failed');
    const queue = t.orchestrator.queue('s');
    expect(queue.paused).toMatchObject({ reason: 'failed', error: 'falhou de vez' });
    expect(contents(queue)).toEqual(['espera']);
    // A paused queue does not start on its own, even when another message is queued.
    await t.orchestrator.enqueue('s', 'mais uma');
    expect(t.orchestrator.isActive('s')).toBe(false);
    expect(contents(t.orchestrator.queue('s'))).toEqual(['espera', 'mais uma']);
  });

  it('removing the last queued item clears the pause; edits keep the position', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    const a = (await t.orchestrator.enqueue('s', 'a')).item!;
    const b = (await t.orchestrator.enqueue('s', 'b')).item!;
    t.orchestrator.editQueued('s', a.id, 'a editada');
    expect(contents(t.orchestrator.queue('s'))).toEqual(['a editada', 'b']);
    const ended = t.runEnded();
    await t.orchestrator.cancel('s');
    await ended;
    t.orchestrator.removeQueued('s', a.id);
    expect(t.orchestrator.queue('s').paused?.reason).toBe('cancelled');
    t.orchestrator.removeQueued('s', b.id);
    expect(t.orchestrator.queue('s')).toEqual({ sessionId: 's', items: [] });
    expect(() => t.orchestrator.removeQueued('s', b.id)).toThrow(/não está mais na fila/);
  });

  it('is idempotent per clientId and enforces the queue limit', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    const first = await t.orchestrator.enqueue('s', 'x', 'client-1');
    const again = await t.orchestrator.enqueue('s', 'x', 'client-1');
    expect(again.item?.id).toBe(first.item?.id);
    for (let i = 1; i < QUEUE_LIMIT; i++) await t.orchestrator.enqueue('s', `m${i}`);
    expect(t.orchestrator.queue('s').items).toHaveLength(QUEUE_LIMIT);
    await expect(t.orchestrator.enqueue('s', 'demais')).rejects.toMatchObject({ status: 409 });
    const ended = t.runEnded();
    await t.orchestrator.cancel('s');
    await ended;
  });

  it('"send now" cancels the run, starts the chosen item and keeps the rest queued', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    await t.orchestrator.enqueue('s', 'fila 1');
    const urgent = (await t.orchestrator.enqueue('s', 'urgente')).item!;
    const ended = t.runEnded();
    await t.orchestrator.sendNow('s', { itemId: urgent.id });
    expect(await ended).toBe('cancelled');
    await t.provider.turnStarted(2);
    expect(t.userMessages()).toEqual(['longa', 'urgente']);
    const queue = t.orchestrator.queue('s');
    expect(contents(queue)).toEqual(['fila 1']);
    // Interrupting on purpose is not a pause: the rest continues after the new answer.
    expect(queue.paused).toBeUndefined();
    const next = t.runEnded();
    t.provider.finish();
    await next;
    await t.provider.turnStarted(3);
    expect(t.userMessages()).toEqual(['longa', 'urgente', 'fila 1']);
    const last = t.runEnded();
    t.provider.finish();
    await last;
  });

  it('"send now" with new text goes ahead of the queue', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    await t.orchestrator.enqueue('s', 'fila');
    const ended = t.runEnded();
    await t.orchestrator.sendNow('s', { content: 'texto novo' });
    await ended;
    await t.provider.turnStarted(2);
    expect(t.userMessages()).toEqual(['longa', 'texto novo']);
    expect(contents(t.orchestrator.queue('s'))).toEqual(['fila']);
    const next = t.runEnded();
    t.provider.finish();
    await next;
    await t.provider.turnStarted(3);
    const last = t.runEnded();
    t.provider.finish();
    await last;
  });

  it('steers the active turn with a queued message when the provider supports it', async () => {
    const t = setup({ steer: true });
    const { runId } = await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    const item = (await t.orchestrator.enqueue('s', 'mude o foco')).item!;
    await t.orchestrator.steerQueued('s', item.id);
    expect(t.provider.steered).toEqual([{ runId, content: 'mude o foco' }]);
    expect(t.orchestrator.queue('s').items).toEqual([]);
    expect(t.store.listEvents('s').some((e) => e.text.includes('Orientação enviada'))).toBe(true);
    const ended = t.runEnded();
    t.provider.finish();
    await ended;
  });

  it('refuses to steer without a steerable provider and keeps the item', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    const item = (await t.orchestrator.enqueue('s', 'orientação')).item!;
    await expect(t.orchestrator.steerQueued('s', item.id)).rejects.toMatchObject({ status: 409 });
    expect(contents(t.orchestrator.queue('s'))).toEqual(['orientação']);
    const ended = t.runEnded();
    await t.orchestrator.cancel('s');
    await ended;
  });

  it('persists the queue across a Store reopen and pauses it there', async () => {
    const t = setup();
    await t.orchestrator.start(t.session, 'longa');
    await t.provider.turnStarted(1);
    await t.orchestrator.enqueue('s', 'um');
    await t.orchestrator.enqueue('s', 'dois');
    const ended = t.runEnded();
    await t.orchestrator.shutdown();
    await ended;
    t.store.close();

    const reopened = new Store(t.dir);
    try {
      const queue = reopened.getQueue('s');
      expect(contents(queue)).toEqual(['um', 'dois']);
      expect(queue.paused?.reason).toBe('interrupted');
      // Deleting the conversation removes its queue (ON DELETE CASCADE).
      reopened.deleteSession('s');
      expect(reopened.getQueue('s')).toEqual({ sessionId: 's', items: [] });
    } finally {
      reopened.close();
    }
  });
});

describe('message queue routes', () => {
  async function serve() {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-queue-http-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putSession({
      id: 's',
      projectId: null,
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    const provider = scriptedProvider();
    const { app, orchestrator } = createBackend(store, provider.providers);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', origin: base },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { store, orchestrator, provider, call, cleanup: () => orchestrator.shutdown().then(() => store.close()) };
  }

  it('validates input and returns the queue through the API', async () => {
    const t = await serve();
    try {
      expect((await t.call('GET', '/api/sessions/nope/queue')).status).toBe(404);
      expect(await (await t.call('GET', '/api/sessions/s/queue')).json()).toEqual({ sessionId: 's', items: [] });
      expect((await t.call('POST', '/api/sessions/s/queue', { content: '' })).status).toBe(400);
      expect((await t.call('POST', '/api/sessions/s/queue', { content: 'x'.repeat(32001) })).status).toBe(400);
      expect((await t.call('POST', '/api/sessions/s/queue', { content: 'ok', clientId: 7 })).status).toBe(400);
      expect((await t.call('POST', '/api/sessions/s/send-now', {})).status).toBe(400);
      expect((await t.call('POST', '/api/sessions/s/send-now', { content: 'a', itemId: 'b' })).status).toBe(400);

      // Idle conversation: the queued message starts right away.
      const first = await t.call('POST', '/api/sessions/s/queue', { content: 'primeira', clientId: 'c1' });
      expect(first.status).toBe(202);
      expect((await first.json()).started.runId).toBeTruthy();
      await t.provider.turnStarted(1);
      // Same clientId again: the existing run, nothing new queued.
      const retried = await t.call('POST', '/api/sessions/s/queue', { content: 'primeira', clientId: 'c1' });
      expect((await retried.json()).queue.items).toEqual([]);

      const queued = await t.call('POST', '/api/sessions/s/queue', { content: 'segunda' });
      expect(queued.status).toBe(201);
      const { item } = await queued.json();
      const edited = await t.call('PATCH', `/api/sessions/s/queue/${item.id}`, { content: 'segunda editada' });
      expect(await edited.json()).toMatchObject({ id: item.id, content: 'segunda editada' });
      expect((await t.call('PATCH', `/api/sessions/s/queue/${item.id}`, { content: ' ' })).status).toBe(400);
      expect((await t.call('PATCH', '/api/sessions/s/queue/missing', { content: 'x' })).status).toBe(404);
      expect((await t.call('POST', `/api/sessions/s/queue/${item.id}/steer`, {})).status).toBe(409);
      expect((await t.call('DELETE', `/api/sessions/s/queue/${item.id}`, {})).status).toBe(204);
      expect((await t.call('DELETE', `/api/sessions/s/queue/${item.id}`, {})).status).toBe(404);
      const resumed = await t.call('POST', '/api/sessions/s/queue/resume', {});
      expect(await resumed.json()).toMatchObject({ queue: { sessionId: 's', items: [] } });
    } finally {
      await t.cleanup();
    }
  });
});
