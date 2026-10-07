import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan, ProviderRegistry, RunInput, RunResult, Session } from '../shared/contracts.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { BranchSessionSchema, EditMessageSchema, parseBody } from '../shared/schemas.js';

// Edit and resend, and branch a conversation (docs/specs/edit-branch.md).

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))),
  );
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Provider that answers "eco: <prompt tail>" and reports a native session id, or holds turns open. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-edit-'));
  dirs.push(dir);
  const store = new Store(dir);
  const inputs: RunInput[] = [];
  let hold: ((r: RunResult) => void) | undefined;
  let holding = false;
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
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true, images: true },
        },
      ];
    },
    run(input, emit, signal) {
      inputs.push(input);
      emit({ type: 'session', nativeSessionId: `native-${inputs.length}` });
      if (holding)
        return new Promise<RunResult>((resolve) => {
          hold = resolve;
          signal.addEventListener('abort', () => resolve({ text: '', stopReason: 'cancelled' }), { once: true });
        });
      const text = `resposta ${inputs.length}`;
      emit({ type: 'delta', text });
      return Promise.resolve({ text, stopReason: 'completed' });
    },
    async approve() {},
    async shutdown() {},
  };
  store.setSettings({ ...store.getSettings()!, autoRetry: false });
  const { app, orchestrator } = createBackend(store, providers);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const now = new Date().toISOString();
  // A project with orchestration off: one direct call per run, so RunInput.history is the run's history.
  store.putProject({
    id: 'p',
    name: 'p',
    path: dir,
    createdAt: now,
    memoryWorkspace: 'w',
    memoryProject: 'p',
    orchestration: { enabled: false, maxWorkers: 1, review: false },
    graphify: { enabled: false },
  });
  const session = (id: string, extra: Partial<Session> = {}) =>
    store.putSession({
      id,
      projectId: 'p',
      title: 'Original',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    });
  const settle = async (sessionId: string) => {
    for (let i = 0; i < 300; i++) {
      if (!orchestrator.isActive(sessionId) && !store.getSession(sessionId)?.activeRunId) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run did not finish');
  };
  const send = async (sessionId: string, content: string, attachmentIds?: string[]) => {
    const res = await post(`/api/sessions/${sessionId}/messages`, {
      content,
      ...(attachmentIds ? { attachmentIds } : {}),
    });
    expect(res.status).toBe(202);
    await settle(sessionId);
    return (await res.json()) as { runId: string; messageId: string };
  };
  const upload = async (sessionId: string, name: string, bytes: Buffer) => {
    const res = await post(`/api/sessions/${sessionId}/attachments`, { name, data: bytes.toString('base64') });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; name: string };
  };
  const control = {
    holdTurns: (on: boolean) => (holding = on),
    release: () => hold?.({ text: 'fim', stopReason: 'completed' }),
  };
  return { dir, store, orchestrator, base, inputs, session, post, settle, send, upload, control };
}

describe('edit and resend', () => {
  it('replaces the message, discards later ones, clears the native session and resends with the earlier history', async () => {
    const t = await setup();
    t.session('s');
    await t.send('s', 'primeira pergunta');
    const second = await t.send('s', 'segunda pergunta');
    await t.send('s', 'terceira pergunta');
    expect(t.store.getSession('s')?.nativeSessionId).toBe('native-3');
    expect(t.store.listMessages('s')).toHaveLength(6);
    const discardedRuns = t.store
      .listMessages('s')
      .slice(2)
      .map((m) => m.runId);

    // The native session the provider sees is cleared before the run starts.
    const res = await t.post(`/api/sessions/s/messages/${second.messageId}/edit`, { content: 'segunda editada' });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { runId: string; messageId: string };
    await t.settle('s');
    const edited = t.inputs.at(-1)!;
    expect(edited.nativeSessionId).toBeUndefined();
    expect(edited.prompt).toContain('segunda editada');
    // History is only what came before the edited message.
    expect(edited.history.map((m) => m.content)).toEqual(['primeira pergunta', 'resposta 1']);

    const messages = t.store.listMessages('s');
    expect(messages.map((m) => m.content)).toEqual([
      'primeira pergunta',
      'resposta 1',
      'segunda editada',
      'resposta 4',
    ]);
    expect(messages[2].id).toBe(started.messageId);
    expect(messages[2].id).not.toBe(second.messageId);
    // The new run reported its own native session, which the next message keeps using.
    expect(t.store.getSession('s')?.nativeSessionId).toBe('native-4');
    // Runs stay for history and audit, marked as discarded; their events are gone.
    for (const runId of new Set(discardedRuns)) {
      expect(t.store.getRun(runId!)?.discardedAt).toBeTruthy();
      expect(t.store.listEvents('s').some((e) => e.runId === runId)).toBe(false);
    }
    expect(t.store.getRun(messages[0].runId!)?.discardedAt).toBeUndefined();
    expect(t.store.getRun(started.runId)?.discardedAt).toBeUndefined();
    // Export follows the remaining messages.
    const md = await (await fetch(`${t.base}/api/sessions/s/export`)).text();
    expect(md).toContain('segunda editada');
    expect(md).not.toContain('terceira pergunta');
  });

  it('keeps the message search index consistent', async () => {
    const t = await setup();
    t.session('s');
    const first = await t.send('s', 'girassol amarelo');
    await t.send('s', 'orquidea violeta');
    expect(t.store.searchConversations('orquidea')).toHaveLength(1);
    await t.post(`/api/sessions/s/messages/${first.messageId}/edit`, { content: 'margarida branca' });
    await t.settle('s');
    expect(t.store.searchConversations('girassol')).toHaveLength(0);
    expect(t.store.searchConversations('orquidea')).toHaveLength(0);
    expect(t.store.searchConversations('margarida')[0]?.matches).toHaveLength(1);
    // Every remaining message is indexed exactly once, and nothing else is.
    const indexed = t.store.db.prepare('SELECT message_id FROM messages_fts WHERE session_id=?').all('s') as {
      message_id: string;
    }[];
    expect(indexed.map((r) => r.message_id).sort()).toEqual(
      t.store
        .listMessages('s')
        .map((m) => m.id)
        .sort(),
    );
  });

  it('keeps the attachments by default and replaces them when attachmentIds is sent', async () => {
    const t = await setup();
    t.session('s');
    const image = await t.upload('s', 'foto.png', PNG);
    const note = await t.upload('s', 'nota.txt', Buffer.from('conteúdo da nota'));
    const sent = await t.send('s', 'veja os anexos', [image.id, note.id]);
    await t.post(`/api/sessions/s/messages/${sent.messageId}/edit`, { content: 'veja de novo' });
    await t.settle('s');
    let user = t.store.listMessages('s')[0];
    expect(user.attachments?.map((a) => a.id)).toEqual([image.id, note.id]);
    expect(t.inputs.at(-1)!.attachments?.map((a) => a.name)).toEqual(['foto.png']);
    expect(t.inputs.at(-1)!.prompt).toContain('conteúdo da nota');

    // Removing a chip in the editor sends the remaining ids.
    await t.post(`/api/sessions/s/messages/${user.id}/edit`, { content: 'só a nota', attachmentIds: [note.id] });
    await t.settle('s');
    user = t.store.listMessages('s')[0];
    expect(user.attachments?.map((a) => a.id)).toEqual([note.id]);
    expect(t.inputs.at(-1)!.attachments).toBeUndefined();
    await t.post(`/api/sessions/s/messages/${user.id}/edit`, { content: 'sem anexos', attachmentIds: [] });
    await t.settle('s');
    expect(t.store.listMessages('s')[0].attachments).toBeUndefined();
  });

  it('validates the request and refuses while a run is active or a plan is executing', async () => {
    const t = await setup();
    t.session('s');
    t.session('other');
    const first = await t.send('s', 'olá');
    const answer = t.store.listMessages('s')[1];
    const foreign = await t.upload('other', 'x.txt', Buffer.from('x'));
    const edit = (sessionId: string, messageId: string, body: unknown) =>
      t.post(`/api/sessions/${sessionId}/messages/${messageId}/edit`, body);

    expect((await edit('nope', first.messageId, { content: 'x' })).status).toBe(404);
    expect((await edit('s', 'nope', { content: 'x' })).status).toBe(404);
    expect((await edit('other', first.messageId, { content: 'x' })).status).toBe(404);
    expect((await edit('s', answer.id, { content: 'x' })).status).toBe(400);
    expect((await edit('s', first.messageId, { content: '   ' })).status).toBe(400);
    expect((await edit('s', first.messageId, { content: 'x'.repeat(32001) })).status).toBe(400);
    const bad = await edit('s', first.messageId, { content: 'x', attachmentIds: [foreign.id] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Anexo não encontrado/);

    // A run in progress blocks the edit.
    t.control.holdTurns(true);
    const second = await t.post('/api/sessions/s/messages', { content: 'demorada' });
    expect(second.status).toBe(202);
    const busy = await edit('s', first.messageId, { content: 'x' });
    expect(busy.status).toBe(409);
    t.control.release();
    t.control.holdTurns(false);
    await t.settle('s');

    // So does an executing plan, even between task runs.
    const plan: Plan = {
      id: 'plan1',
      sessionId: 's',
      runId: 'r-plan',
      title: 'Plano',
      status: 'executing',
      requirements: '',
      design: '',
      tasks: [],
      markdown: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    t.store.putPlan(plan);
    const planBusy = await edit('s', first.messageId, { content: 'x' });
    expect(planBusy.status).toBe(409);
    expect((await planBusy.json()).error).toMatch(/plano/);
    t.store.putPlan({ ...plan, status: 'approved' });
    expect(t.store.listMessages('s')).toHaveLength(4);
    expect(t.inputs).toHaveLength(2);
  });

  it('is idempotent with clientMessageId and rejects plans written by discarded runs', async () => {
    const t = await setup();
    t.session('s');
    const first = await t.send('s', 'um');
    const second = await t.send('s', 'dois');
    const now = new Date().toISOString();
    t.store.putPlan({
      id: 'p2',
      sessionId: 's',
      runId: second.runId,
      title: 'Plano',
      status: 'draft',
      requirements: '',
      design: '',
      tasks: [],
      markdown: '',
      createdAt: now,
      updatedAt: now,
    });
    const body = { content: 'um, editado', clientMessageId: 'c-1' };
    const a = await (await t.post(`/api/sessions/s/messages/${first.messageId}/edit`, body)).json();
    await t.settle('s');
    // A retry after the original message is gone finds the run it started.
    const b = await t.post(`/api/sessions/s/messages/${first.messageId}/edit`, body);
    expect(b.status).toBe(202);
    expect(await b.json()).toEqual(a);
    expect(t.inputs).toHaveLength(3);
    expect(t.store.getPlan('p2')?.status).toBe('rejected');
  });
});

describe('branch a conversation', () => {
  it('copies the messages up to the chosen one with new ids and duplicated attachment files', async () => {
    const t = await setup();
    t.session('s', { thinking: 'auto', planFirst: undefined });
    const image = await t.upload('s', 'foto.png', PNG);
    const first = await t.send('s', 'com imagem', [image.id]);
    await t.send('s', 'depois');
    const answer = t.store.listMessages('s')[1];
    const before = JSON.stringify(t.store.listMessages('s'));

    const res = await t.post('/api/sessions/s/branch', { messageId: answer.id });
    expect(res.status).toBe(201);
    const branch = (await res.json()) as Session;
    expect(branch).toMatchObject({
      title: 'Original (ramo)',
      projectId: 'p',
      providerId: 'codex',
      mode: 'fast',
      branchedFrom: { sessionId: 's', messageId: answer.id },
    });
    expect(branch.nativeSessionId).toBeUndefined();
    expect(branch.activeRunId).toBeUndefined();
    const copied = t.store.listMessages(branch.id);
    expect(copied.map((m) => m.content)).toEqual(['com imagem', 'resposta 1']);
    expect(copied.every((m) => m.sessionId === branch.id)).toBe(true);
    expect(copied.map((m) => m.id)).not.toContain(first.messageId);
    // The prompt and its answer stay paired, under a run id that is not the original's.
    expect(copied[0].runId).toBe(copied[1].runId);
    expect(copied[0].runId).not.toBe(first.runId);
    const copy = t.store.getAttachment(copied[0].attachments![0].id)!;
    expect(copy.id).not.toBe(image.id);
    expect(copy.sessionId).toBe(branch.id);
    expect(readFileSync(t.store.attachmentPath(copy))).toEqual(PNG);
    // Plans, queue and runs are not copied; the original is untouched.
    expect(t.store.listRuns(branch.id)).toEqual([]);
    expect(t.store.listPlans(branch.id)).toEqual([]);
    expect(JSON.stringify(t.store.listMessages('s'))).toBe(before);
    expect(t.store.listAttachments('s')).toHaveLength(1);
    // Search finds the copies too.
    expect(
      t.store
        .searchConversations('imagem')
        .map((h) => h.sessionId)
        .sort(),
    ).toEqual([branch.id, 's'].sort());

    // Deleting the original leaves the branch whole.
    const original = t.store.getAttachment(image.id)!;
    const originalPath = t.store.attachmentPath(original);
    t.store.deleteSession('s');
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(t.store.attachmentPath(copy))).toBe(true);
    expect(t.store.listMessages(branch.id)).toHaveLength(2);
    const served = await fetch(`${t.base}/api/attachments/${copy.id}`);
    expect(served.status).toBe(200);
    // The branch keeps working on its own, starting a fresh native session.
    await t.send(branch.id, 'continua no ramo');
    expect(t.inputs.at(-1)!.nativeSessionId).toBeUndefined();
    expect(t.inputs.at(-1)!.history.map((m) => m.content)).toEqual(['com imagem', 'resposta 1']);
  });

  it('validates the request', async () => {
    const t = await setup();
    t.session('s');
    t.session('other');
    const first = await t.send('s', 'olá');
    const branch = (body: unknown, id = 's') => t.post(`/api/sessions/${id}/branch`, body);
    expect((await branch({ messageId: first.messageId }, 'nope')).status).toBe(404);
    expect((await branch({})).status).toBe(400);
    expect((await branch({ messageId: 7 })).status).toBe(400);
    expect((await branch({ messageId: 'nope' })).status).toBe(404);
    expect((await branch({ messageId: first.messageId }, 'other')).status).toBe(404);
    // A message whose answer is still being written cannot be branched.
    t.control.holdTurns(true);
    const pending = await (await t.post('/api/sessions/s/messages', { content: 'demorada' })).json();
    expect((await branch({ messageId: pending.messageId })).status).toBe(201);
    const running = t.store.listMessages('s').at(-1)!;
    const refused = await branch({ messageId: running.id });
    expect(refused.status).toBe(409);
    t.control.release();
    await t.settle('s');
  });

  it('truncates long titles to the session title limit', async () => {
    const t = await setup();
    t.session('s', { title: 'x'.repeat(160) });
    const first = await t.send('s', 'olá');
    const created = t.store.branchSession('s', first.messageId);
    expect(created.title).toHaveLength(160);
    expect(created.title.endsWith(' (ramo)')).toBe(true);
  });
});

describe('edit and branch schemas', () => {
  it('parses the bodies with the API messages', () => {
    expect(parseBody(EditMessageSchema, { content: ' oi ' }, 'x')).toEqual({ ok: true, data: { content: 'oi' } });
    expect(parseBody(EditMessageSchema, { content: 'oi', attachmentIds: ['bad'] }, 'x')).toMatchObject({ ok: false });
    expect(parseBody(BranchSessionSchema, { messageId: 'm' }, 'x')).toEqual({ ok: true, data: { messageId: 'm' } });
    expect(parseBody(BranchSessionSchema, {}, 'x')).toEqual({ ok: false, message: 'messageId obrigatório' });
  });
});
