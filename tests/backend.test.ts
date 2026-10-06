import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderRegistry, RunInput } from '../shared/contracts.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { Orchestrator } from '../server/orchestrator.js';
import type { Approval, Project, Run, Session } from '../shared/contracts.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(listProviders?: ProviderRegistry['list']) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-test-'));
  dirs.push(dir);
  const store = new Store(dir);
  let calls = 0;
  const providers: ProviderRegistry = {
    async list() {
      return listProviders
        ? listProviders()
        : [
            {
              id: 'codex',
              name: 'stub',
              installed: true,
              available: true,
              status: 'ready' as const,
              detail: 'test',
              models: [{ id: 'm1', name: 'm1', isDefault: true, efforts: ['low', 'medium'] }],
              defaultModel: 'm1',
              capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
            },
            {
              id: 'claude',
              name: 'stub claude',
              installed: true,
              available: true,
              status: 'ready' as const,
              detail: 'test',
              models: [{ id: 'new', name: 'new' }],
              capabilities: { fast: true, tools: true, approvals: false, cancel: true, reasoning: true },
            },
          ];
    },
    async run(_input, emit, signal) {
      calls++;
      emit({ type: 'delta', text: 'ok' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 35);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
      return { text: 'ok', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers);
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  return { store, server, orchestrator, calls: () => calls };
}
async function ready(server: Server) {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
const headers = (base: string) => ({ 'content-type': 'application/json', origin: base });

describe('backend persistence and API', () => {
  it('rejects unknown explicit models without persistence and coalesces concurrent catalog discovery with retry after failure', async () => {
    let calls = 0,
      release!: () => void,
      started!: () => void,
      fail = true;
    let gate = new Promise<void>((r) => {
      release = r;
    });
    const discoveryStarted = new Promise<void>((r) => {
      started = r;
    });
    const models = [{ id: 'm1', name: 'Model 1', efforts: ['high'] }];
    const { store, server } = setup(async () => {
      calls++;
      started();
      await gate;
      if (fail) throw new Error('temporary discovery failure');
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: 'test',
          models,
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    });
    const base = await ready(server);
    const post = (model: string) =>
      fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: headers(base),
        body: JSON.stringify({ providerId: 'codex', model }),
      });
    const a = post('m1'),
      b = post('m1');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        discoveryStarted,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('timed out waiting for catalog discovery to start')), 2000);
        }),
      ]);
      expect(calls).toBe(1);
    } finally {
      if (timeout) clearTimeout(timeout);
      release();
    }
    const ra = await a,
      rb = await b;
    expect([ra.status, rb.status]).toEqual([400, 400]);
    expect(await ra.text()).toContain('temporary discovery failure');
    expect(store.listSessions()).toHaveLength(0);
    fail = false;
    gate = Promise.resolve();
    const valid = await post('m1');
    expect(valid.status).toBe(201);
    expect(calls).toBeGreaterThanOrEqual(2);
    const unknown = await post('unknown');
    expect(unknown.status).toBe(400);
    expect(store.listSessions()).toHaveLength(1);
    const session = (await valid.json()) as Session;
    const patch = await fetch(`${base}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ model: 'unknown' }),
    });
    expect(patch.status).toBe(400);
    expect(store.getSession(session.id)?.model).toBe('m1');
    store.close();
  });

  it('revalidates PATCH after catalog awaits when the session is deleted or becomes active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { store, server } = setup(async () => {
      await gate;
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: 'test',
          models: [{ id: 'm1', name: 'Model 1' }],
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    });
    const base = await ready(server);
    const now = new Date().toISOString();
    const create = async (id: string) => {
      const s: Session = {
        id,
        projectId: null,
        title: 'T',
        providerId: 'codex',
        mode: 'fast',
        createdAt: now,
        updatedAt: now,
      };
      store.putSession(s);
      return s;
    };
    await create('gone');
    const deletion = fetch(`${base}/api/sessions/gone`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ model: 'm1' }),
    });
    await new Promise((r) => setTimeout(r, 15));
    store.deleteSession('gone');
    release();
    expect((await deletion).status).toBe(404);
    store.close();
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((r) => {
      releaseActive = r;
    });
    const second = setup(async () => {
      await activeGate;
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: 'test',
          models: [{ id: 'm1', name: 'Model 1' }],
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    });
    const activeBase = await ready(second.server);
    second.store.putSession({
      id: 'active',
      projectId: null,
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    const active = fetch(`${activeBase}/api/sessions/active`, {
      method: 'PATCH',
      headers: headers(activeBase),
      body: JSON.stringify({ model: 'm1' }),
    });
    await new Promise((r) => setTimeout(r, 15));
    second.store.putSession({ ...second.store.getSession('active')!, activeRunId: 'run-active' });
    releaseActive();
    expect((await active).status).toBe(409);
    expect(second.store.getSession('active')).toMatchObject({ activeRunId: 'run-active' });
    expect(second.store.getSession('active')).not.toHaveProperty('model');
    second.store.close();
    let releaseChange!: () => void;
    const changeGate = new Promise<void>((r) => {
      releaseChange = r;
    });
    const third = setup(async () => {
      await changeGate;
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: 'test',
          models: [{ id: 'm1', name: 'Model 1' }],
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    });
    const changeBase = await ready(third.server);
    third.store.putSession({
      id: 'changed',
      projectId: null,
      title: 'Before',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    const changing = fetch(`${changeBase}/api/sessions/changed`, {
      method: 'PATCH',
      headers: headers(changeBase),
      body: JSON.stringify({ model: 'm1' }),
    });
    await new Promise((r) => setTimeout(r, 15));
    third.store.putSession({ ...third.store.getSession('changed')!, title: 'Concurrent update' });
    releaseChange();
    expect((await changing).status).toBe(409);
    expect(third.store.getSession('changed')).toMatchObject({ title: 'Concurrent update' });
    expect(third.store.getSession('changed')).not.toHaveProperty('model');
    third.store.close();
  });

  it('migrates populated project-bound tables to nullable project IDs and keeps foreign keys intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-legacy-schema-'));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data TEXT NOT NULL,FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
      CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT,client_id TEXT,data TEXT NOT NULL,FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE);
      CREATE TABLE delegated_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,data TEXT NOT NULL);
      INSERT INTO projects VALUES('p','{"id":"p","name":"P","path":"/tmp","createdAt":"now","memoryWorkspace":"w","memoryProject":"p"}');
      INSERT INTO sessions VALUES('s','p','{"id":"s","projectId":"p","title":"T","providerId":"codex","mode":"fast","createdAt":"now","updatedAt":"now"}');
      INSERT INTO messages VALUES('m','s','r',NULL,'{"id":"m","sessionId":"s","runId":"r","role":"user","content":"kept","createdAt":"now"}');
      INSERT INTO delegated_tasks VALUES('t','p','s','r','{"id":"t","projectId":"p","sessionId":"s","runId":"r","role":"worker","title":"kept","instructions":"task","scope":[],"dependsOn":[],"providerId":"codex","status":"completed","createdAt":"now"}');`);
    db.close();
    const store = new Store(dir);
    expect(store.getSession('s')?.projectId).toBe('p');
    expect(store.listMessages('s')[0].content).toBe('kept');
    expect(store.getTask('t')?.title).toBe('kept');
    store.putSession({
      id: 'detached',
      projectId: null,
      title: 'Detached',
      providerId: 'codex',
      mode: 'fast',
      createdAt: 'now',
      updatedAt: 'now',
    });
    store.putTask({
      id: 'detached-task',
      projectId: null,
      sessionId: 'detached',
      runId: 'r2',
      role: 'worker',
      title: 'Detached task',
      instructions: 'task',
      scope: [],
      dependsOn: [],
      providerId: 'codex',
      status: 'completed',
      createdAt: 'now',
    });
    expect(store.getSession('detached')?.projectId).toBeNull();
    expect(store.getTask('detached-task')?.projectId).toBeNull();
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    store.close();
  });

  it('creates detached sessions and atomically links, switches, and unlinks their project', async () => {
    const { store, server, orchestrator } = setup();
    const base = await ready(server);
    const now = new Date().toISOString();
    for (const id of ['p1', 'p2'])
      store.putProject({ id, name: id, path: process.cwd(), createdAt: now, memoryWorkspace: 'w', memoryProject: id });
    const create = async (body: unknown) =>
      fetch(`${base}/api/sessions`, { method: 'POST', headers: headers(base), body: JSON.stringify(body) });
    const absent = await create({ providerId: 'codex' });
    const detached = (await absent.json()) as Session;
    expect(absent.status).toBe(201);
    expect(detached.projectId).toBeNull();
    const explicitNull = await create({ projectId: null });
    expect(explicitNull.status).toBe(201);
    expect((await explicitNull.json()).projectId).toBeNull();
    const badType = await create({ projectId: 7 });
    expect(badType.status).toBe(400);
    store.putSession({ ...detached, nativeSessionId: 'native-old' });
    const linked = await fetch(`${base}/api/sessions/${detached.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ projectId: 'p1' }),
    });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ projectId: 'p1' });
    expect(store.getSession(detached.id)?.nativeSessionId).toBeUndefined();
    store.putSession({ ...store.getSession(detached.id)!, nativeSessionId: 'native-p1' });
    const switched = await fetch(`${base}/api/sessions/${detached.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ projectId: 'p2' }),
    });
    expect(switched.status).toBe(200);
    expect(store.getSession(detached.id)?.projectId).toBe('p2');
    expect(store.getSession(detached.id)).not.toHaveProperty('nativeSessionId');
    const invalid = await fetch(`${base}/api/sessions/${detached.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ projectId: 'missing', title: 'partial mutation' }),
    });
    expect(invalid.status).toBe(404);
    expect(store.getSession(detached.id)?.title).toBe('Nova conversa');
    expect(store.getSession(detached.id)?.projectId).toBe('p2');
    store.putSession({ ...store.getSession(detached.id)!, nativeSessionId: 'native-p2' });
    const unlinked = await fetch(`${base}/api/sessions/${detached.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ projectId: null }),
    });
    expect(unlinked.status).toBe(200);
    expect(await unlinked.json()).toMatchObject({ projectId: null });
    expect(store.getSession(detached.id)?.nativeSessionId).toBeUndefined();
    const runDone = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === detached.id && event.run.status === 'completed') resolve();
      }),
    );
    const busy = await fetch(`${base}/api/sessions/${detached.id}/messages`, {
      method: 'POST',
      headers: headers(base),
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(busy.status).toBe(202);
    const duringRun = await fetch(`${base}/api/sessions/${detached.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ projectId: 'p1', title: 'should not change' }),
    });
    expect(duringRun.status).toBe(409);
    expect(store.getSession(detached.id)).toMatchObject({ projectId: null, title: 'hello' });
    await runDone;
    store.close();
  });

  it('validates and persists the independent thinking selection on sessions', async () => {
    const { store, server } = setup();
    const base = await ready(server);
    const post = async (body: unknown) =>
      fetch(`${base}/api/sessions`, { method: 'POST', headers: headers(base), body: JSON.stringify(body) });
    const invalidCreate = await post({ thinking: 'maximum' });
    expect(invalidCreate.status).toBe(400);
    const created = await post({ thinking: 'medium' });
    expect(created.status).toBe(201);
    const session = (await created.json()) as Session;
    expect(session.thinking).toBe('medium');
    expect(store.getSession(session.id)?.thinking).toBe('medium');
    const invalidPatch = await fetch(`${base}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ thinking: 'maximum', title: 'must stay unchanged' }),
    });
    expect(invalidPatch.status).toBe(400);
    expect(store.getSession(session.id)).toMatchObject({ thinking: 'medium', title: 'Nova conversa' });
    const setAuto = await fetch(`${base}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ thinking: 'auto' }),
    });
    expect(setAuto.status).toBe(200);
    expect((await setAuto.json()).thinking).toBe('auto');
    expect(store.getSession(session.id)?.thinking).toBe('auto');
    const unsupported = await post({ thinking: 'high' });
    expect(unsupported.status).toBe(400);
    expect(store.listSessions()).toHaveLength(1);
    const dataDir = store.dataDir;
    store.close();
    const reopened = new Store(dataDir);
    expect(reopened.getSession(session.id)?.thinking).toBe('auto');
    reopened.close();
  });

  it('applies a manual thinking override to every delegated phase without changing routing policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-thinking-phases-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: false },
      orchestration: {
        enabled: true,
        maxWorkers: 1,
        review: true,
        workerProviderId: 'kiro',
        workerModel: 'model-luna',
        reviewerProviderId: 'claude',
        reviewerModel: 'model-astra',
      },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      model: 'model-a',
      mode: 'deep',
      thinking: 'ultra',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    const inputs: RunInput[] = [];
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'Sol',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'model-a', name: 'Model A', efforts: ['low', 'medium', 'high', 'ultra'], isDefault: true }],
            defaultModel: 'model-a',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
          {
            id: 'kiro',
            name: 'Luna',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'model-luna', name: 'Luna Model', efforts: ['low', 'medium', 'high', 'max'] }],
            defaultModel: 'model-luna',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
          {
            id: 'claude',
            name: 'Astra',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'model-astra', name: 'Astra Model', efforts: ['low', 'medium', 'high', 'ultra'] }],
            defaultModel: 'model-astra',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input, emit) {
        inputs.push(input);
        if (input.prompt.includes('Produza somente JSON válido'))
          return {
            text: JSON.stringify({
              tasks: [{ id: 'work', title: 'Work', instructions: 'Inspect target', scope: [], dependsOn: [] }],
            }),
            stopReason: 'completed',
          };
        if (input.prompt.includes('Faça revisão independente')) return { text: 'Reviewed', stopReason: 'completed' };
        if (input.prompt.includes('Responda ao pedido completo')) {
          emit({ type: 'delta', text: 'Done' });
          return { text: 'Done', stopReason: 'completed' };
        }
        return { text: 'Worker output', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === 's' && event.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, 'Implemente um endpoint para esta aplicação');
    await done;
    expect(inputs.map((input) => input.plan.effort)).toEqual(['ultra', 'max', 'ultra', 'ultra']);
    expect(
      inputs.map((input) =>
        input.prompt.includes('Produza somente JSON válido')
          ? 'planner'
          : input.prompt.includes('Faça revisão independente')
            ? 'reviewer'
            : input.prompt.includes('Responda ao pedido completo')
              ? 'synthesis'
              : 'worker',
      ),
    ).toEqual(['planner', 'worker', 'reviewer', 'synthesis']);
    expect(inputs.find((input) => input.prompt.includes('Produza somente JSON válido'))?.plan.tools).toBe(false);
    expect(inputs.find((input) => input.prompt.includes('Produza somente JSON válido'))?.plan.level).toBe('fast');
    expect(inputs.filter((input) => input.prompt.includes('Responda ao pedido completo'))[0].plan.tools).toBe(false);
    expect(store.listRuns('s')[0].route.effort).toBe('ultra');
    expect(store.listSessionTasks('s').find((task) => task.role === 'worker')?.effort).toBe('max');
    await orchestrator.shutdown();
    store.close();
  });

  it('rejects unsupported manual thinking before persisting a run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-thinking-unsupported-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const models = [
      { id: 'model-a', name: 'Model A', efforts: ['low'] },
      { id: 'model-empty', name: 'Model Empty', efforts: [] },
      { id: 'model-xhigh', name: 'Model xhigh', efforts: ['xhigh'] },
    ];
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'Stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models,
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run() {
        throw new Error('must not run');
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    for (const [id, model, name] of [
      ['s', 'model-a', 'Model A'],
      ['empty', 'model-empty', 'Model Empty'],
      ['xhigh', 'model-xhigh', 'Model xhigh'],
    ]) {
      const session: Session = {
        id,
        projectId: 'p',
        title: 'T',
        providerId: 'codex',
        model,
        mode: 'fast',
        thinking: 'high',
        createdAt: now,
        updatedAt: now,
      };
      store.putSession(session);
      await expect(orchestrator.start(session, 'hello')).rejects.toThrow(`não anuncia esforço high para ${name}`);
      expect(store.listMessages(id)).toEqual([]);
      expect(store.listRuns(id)).toEqual([]);
    }
    await orchestrator.shutdown();
    store.close();
  });

  it('keeps quick conceptual turns single-call while exposing tools only if needed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-thinking-fast-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
      graphify: { enabled: true },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      thinking: 'high',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let captured: RunInput | undefined;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'Stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'm1', isDefault: true, efforts: ['high'] }],
            defaultModel: 'm1',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input, emit) {
        captured = input;
        emit({ type: 'delta', text: 'ok' });
        return { text: 'ok', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === 's' && event.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, 'Uma pergunta direta');
    await done;
    expect(captured?.plan).toMatchObject({ level: 'fast', effort: 'high', tools: true, memory: false });
    expect(store.listSessionTasks('s')).toEqual([]);
    await orchestrator.shutdown();
    store.close();
  });

  it('reserves sessions across delayed catalog discovery, coalescing retries and rejecting other message IDs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-thinking-race-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      thinking: 'auto',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let listCalls = 0,
      runCalls = 0;
    const providers: ProviderRegistry = {
      async list() {
        listCalls++;
        await catalogGate;
        return [
          {
            id: 'codex',
            name: 'Stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'm1', efforts: ['medium'] }],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input, emit) {
        runCalls++;
        emit({ type: 'delta', text: 'ok' });
        return { text: 'ok', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    let runFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      runFinished = resolve;
    });
    orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === 's' && event.run.status === 'completed') runFinished();
    });
    const first = orchestrator.start(session, 'hello', 'client-1');
    expect(orchestrator.isActive('s')).toBe(true);
    const retry = orchestrator.start(session, 'hello', 'client-1');
    await expect(orchestrator.start(session, 'different', 'client-2')).rejects.toMatchObject({ status: 409 });
    const [accepted, retried] = await Promise.all([first, retry]);
    expect(retried).toEqual(accepted);
    expect(store.listRuns('s')).toHaveLength(1);
    expect(runCalls).toBe(0);
    releaseCatalog();
    await finished;
    expect(store.listRuns('s')).toHaveLength(1);
    expect(runCalls).toBe(1);
    expect(listCalls).toBe(1);
    expect(orchestrator.isActive('s')).toBe(false);
    await orchestrator.shutdown();
    store.close();
  });

  it('reserves a valid manual-thinking run during slow discovery and retries after cancellation before persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-manual-thinking-reservation-'));
    dirs.push(dir);
    const store = new Store(dir),
      now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const session: Session = {
      id: 'manual-race',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      model: 'm1',
      mode: 'fast',
      thinking: 'high',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let release!: () => void,
      calls = 0,
      runCalls = 0;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const providers: ProviderRegistry = {
      async list() {
        calls++;
        if (calls === 1) await gate;
        return [
          {
            id: 'codex',
            name: 'Stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'M1', efforts: ['high'] }],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run() {
        runCalls++;
        return { text: 'ok', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const first = orchestrator.start(session, 'hello');
    expect(orchestrator.isActive(session.id)).toBe(true);
    await expect(orchestrator.start(session, 'hello', 'different')).rejects.toMatchObject({ status: 409 });
    await orchestrator.cancel(session.id);
    release();
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(store.listRuns(session.id)).toHaveLength(0);
    let done!: () => void;
    const completed = new Promise<void>((r) => {
      done = r;
    });
    orchestrator.subscribe((event) => {
      if (event.type === 'run' && event.run.sessionId === session.id && event.run.status === 'completed') done();
    });
    const retry = await orchestrator.start(session, 'hello', 'retry');
    expect(retry.runId).toBeTruthy();
    await completed;
    expect(runCalls).toBe(1);
    await orchestrator.shutdown();
    store.close();
  });

  it('releases the session reservation when catalog discovery fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-thinking-retry-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      thinking: 'auto',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let listCalls = 0;
    const providers: ProviderRegistry = {
      async list() {
        listCalls++;
        throw new Error('catalog offline');
      },
      async run(_input, emit) {
        emit({ type: 'delta', text: 'ok' });
        return { text: 'ok', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const failed = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.sessionId === 's' && e.run.status === 'failed') resolve();
      }),
    );
    const accepted = await orchestrator.start(session, 'first', 'retry-id');
    await failed;
    expect(accepted.runId).toBeTruthy();
    expect(listCalls).toBe(1);
    expect(orchestrator.isActive('s')).toBe(false);
    expect(store.listMessages('s')).toHaveLength(2);
    expect(store.listRuns('s')).toHaveLength(1);
    await orchestrator.shutdown();
    store.close();
  });

  it('cancels and releases a session reserved during catalog discovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-thinking-cancel-start-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({ id: 'p', name: 'P', path: dir, createdAt: now, memoryWorkspace: 'w', memoryProject: 'p' });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      thinking: 'auto',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let releaseCatalog!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const providers: ProviderRegistry = {
      async list() {
        await gate;
        return [
          {
            id: 'codex',
            name: 'Stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run() {
        throw new Error('must not run');
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const finished = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.sessionId === 's' && e.run.status === 'cancelled') resolve();
      }),
    );
    const starting = await orchestrator.start(session, 'hello', 'cancel-id');
    expect(orchestrator.isActive('s')).toBe(true);
    await orchestrator.cancel('s');
    releaseCatalog();
    await finished;
    expect(starting.runId).toBeTruthy();
    expect(orchestrator.isActive('s')).toBe(false);
    expect(store.listMessages('s')).toHaveLength(2);
    expect(store.listRuns('s')).toHaveLength(1);
    await orchestrator.shutdown();
    store.close();
  });

  it('runs detached orchestration in its own folder without project memory, graph, or brief context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-detached-run-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.setSettings({ ...store.getSettings()!, memoryEnabled: true });
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: true },
    });
    store.putBrief({
      projectId: 'p',
      updatedAt: now,
      paths: ['secret/project.ts'],
      truncated: false,
      objective: 'prior project objective',
      summary: 'PROJECT-ONLY-CONTEXT',
    });
    const session: Session = {
      id: 's',
      projectId: null,
      title: 'T',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let memoryLookups = 0;
    const inputs: RunInput[] = [];
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(input, emit) {
        inputs.push(input);
        if (input.prompt.includes('Produza somente JSON válido'))
          return {
            text: JSON.stringify({
              tasks: [{ id: 'work', title: 'Work', instructions: 'Inspect requested files', scope: [], dependsOn: [] }],
            }),
            stopReason: 'completed',
          };
        if (input.prompt.includes('Faça revisão independente')) return { text: 'Reviewed', stopReason: 'completed' };
        if (input.prompt.includes('Responda ao pedido completo')) {
          emit({ type: 'delta', text: 'Detached answer' });
          return { text: 'Detached answer', stopReason: 'completed' };
        }
        return { text: 'Detached worker output', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers, async () => {
      memoryLookups++;
      return 'PROJECT-MEMORY-CONTEXT';
    });
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.sessionId === 's' && e.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(
      session,
      'Lembre a decisão na memória e implemente uma função no servidor backend com testes',
    );
    await done;
    const root = join(dir, 'conversations', 's');
    expect(existsSync(root)).toBe(true);
    expect(memoryLookups).toBe(0);
    expect(inputs.length).toBeGreaterThan(1);
    expect(
      inputs.every((input) => input.cwd === root && input.memoryContext === undefined && input.plan.memory === false),
    ).toBe(true);
    expect(
      inputs.every(
        (input) => !input.prompt.includes('PROJECT-ONLY-CONTEXT') && !input.prompt.includes('PROJECT-MEMORY-CONTEXT'),
      ),
    ).toBe(true);
    const tasks = store.listSessionTasks('s');
    expect(tasks.length).toBeGreaterThan(1);
    expect(tasks.every((task) => task.projectId === null && task.status === 'completed')).toBe(true);
    expect(store.getBrief('p')?.summary).toBe('PROJECT-ONLY-CONTEXT');
    expect(store.listProjects()).toHaveLength(1);
    await orchestrator.shutdown();
    store.close();
  });

  it('cancels detached delegated tasks by session scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-detached-cancel-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    const session: Session = {
      id: 'detached-cancel',
      projectId: null,
      title: 'T',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let workerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      workerStarted = resolve;
    });
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(input, _emit, signal) {
        if (input.prompt.includes('Produza somente JSON válido'))
          return {
            text: JSON.stringify({
              tasks: [{ id: 'work', title: 'Work', instructions: 'Wait for cancellation', scope: [], dependsOn: [] }],
            }),
            stopReason: 'completed',
          };
        workerStarted();
        return await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    await orchestrator.start(session, 'Implemente uma função no servidor backend com testes');
    await started;
    await orchestrator.cancel(session.id);
    await orchestrator.shutdown();
    expect(store.listRuns(session.id)[0].status).toBe('cancelled');
    expect(
      store.listSessionTasks(session.id).filter((task) => task.status === 'running' || task.status === 'queued'),
    ).toEqual([]);
    expect(store.listSessionTasks(session.id).find((task) => task.role === 'worker')).toMatchObject({
      projectId: null,
      status: 'cancelled',
    });
    store.close();
  });

  it('persists state and marks active runs interrupted on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-store-'));
    dirs.push(dir);
    let store = new Store(dir);
    const project = {
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: new Date().toISOString(),
      memoryWorkspace: 'w',
      memoryProject: 'p',
    };
    store.putProject(project);
    const session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex' as const,
      mode: 'auto' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeRunId: 'r',
    };
    store.putSession(session);
    const run = {
      id: 'r',
      sessionId: 's',
      providerId: 'codex' as const,
      status: 'running' as const,
      route: {
        level: 'fast' as const,
        reason: 'test',
        tools: false,
        memory: false,
        effort: 'low' as const,
        contextBudget: 6000,
      },
      startedAt: new Date().toISOString(),
    };
    store.putRun(run);
    store.close();
    store = new Store(dir);
    expect(store.getRun('r')?.status).toBe('interrupted');
    expect(store.getSession('s')?.activeRunId).toBeUndefined();
    store.close();
  });

  it('exports full coordination artifacts and removes deleted-session tasks transactionally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-coordination-export-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({ id: 'p', name: 'P', path: dir, createdAt: now, memoryWorkspace: 'w', memoryProject: 'p' });
    store.putSession({
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    });
    store.putTask({
      id: 't',
      projectId: 'p',
      sessionId: 's',
      runId: 'r',
      role: 'worker',
      title: 'Task',
      instructions: 'Do work',
      scope: [],
      dependsOn: [],
      providerId: 'codex',
      status: 'completed',
      createdAt: now,
      completedAt: now,
      output: 'full task output',
    });
    store.putBrief({
      projectId: 'p',
      updatedAt: now,
      paths: ['src/a.ts'],
      truncated: false,
      objective: 'objective',
      summary: 'summary',
    });
    const exported = store.exportData() as { tasks: { output: string }[]; briefs: { projectId: string }[] };
    expect(exported.tasks[0].output).toBe('full task output');
    expect(exported.briefs).toEqual([expect.objectContaining({ projectId: 'p' })]);
    store.deleteSession('s');
    expect(store.getTask('t')).toBeUndefined();
    expect(store.listSessionTasks('s')).toEqual([]);
    expect(store.exportData().tasks).toEqual([]);
    expect(store.getBrief('p')?.summary).toBe('summary');
    store.close();
  });

  it('returns all task metadata for a session without loading outputs into the detail snapshot', async () => {
    const { store, server } = setup();
    const base = await ready(server);
    const now = new Date().toISOString();
    const session: Session = {
      id: 'long-session',
      projectId: null,
      title: 'Long history',
      providerId: 'codex',
      mode: 'auto',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    for (let index = 0; index < 35; index++)
      store.putTask({
        id: `task-${index}`,
        projectId: null,
        sessionId: session.id,
        runId: `run-${Math.floor(index / 4)}`,
        role: 'worker',
        title: `Task ${index}`,
        instructions: 'i'.repeat(800),
        scope: [`src/${index}.ts`],
        dependsOn: [],
        providerId: 'codex',
        model: 'model-a',
        status: 'completed',
        createdAt: now,
        completedAt: now,
        summary: `summary ${index}`,
        output: `FULL-OUTPUT-${index}-` + 'x'.repeat(5000),
      });
    const detailResponse = await fetch(`${base}/api/sessions/${session.id}`, { headers: headers(base) });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as { tasks: Record<string, unknown>[] };
    expect(detail.tasks).toHaveLength(35);
    expect(detail.tasks[0]).toMatchObject({
      id: 'task-34',
      title: 'Task 34',
      role: 'worker',
      model: 'model-a',
      scope: ['src/34.ts'],
      summary: 'summary 34',
    });
    expect(
      detail.tasks.every((task) => !Object.hasOwn(task, 'output') && String(task.instructions).length === 600),
    ).toBe(true);
    const fullTask = await fetch(`${base}/api/tasks/task-34`, { headers: headers(base) });
    expect(await fullTask.json()).toMatchObject({ id: 'task-34', output: `FULL-OUTPUT-34-${'x'.repeat(5000)}` });
    store.close();
  });

  it('accepts one run per session and makes retries idempotent', async () => {
    const { store, server, calls, orchestrator } = setup();
    const base = await ready(server);
    const projectResponse = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: headers(base),
      body: JSON.stringify({ name: 'test', path: process.cwd(), memoryWorkspace: 'pessoal', memoryProject: 'adelic' }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string };
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: headers(base),
      body: JSON.stringify({ projectId: project.id, providerId: 'codex' }),
    });
    const session = (await sessionResponse.json()) as { id: string };
    const completed = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === session.id && event.run.status === 'completed') resolve();
      }),
    );
    const payload = JSON.stringify({ content: 'hello', clientMessageId: 'client-1' });
    const first = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: headers(base),
      body: payload,
    });
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { runId: string };
    const retry = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: headers(base),
      body: payload,
    });
    expect(retry.status).toBe(202);
    expect((await retry.json()).runId).toBe(accepted.runId);
    const conflict = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: headers(base),
      body: JSON.stringify({ content: 'another' }),
    });
    expect(conflict.status).toBe(409);
    expect(calls()).toBe(1);
    await completed;
    expect(store.listMessages(session.id).map((m) => m.content)).toEqual(['hello', 'ok']);
    expect(store.getRun(accepted.runId)?.status).toBe('completed');
    const task = store.listSessionTasks(session.id)[0];
    const detail = await fetch(`${base}/api/tasks/${task.id}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).output).toBe('ok');
    expect((await fetch(`${base}/api/tasks/missing`)).status).toBe(404);
    expect(store.detail(store.getSession(session.id)!).tasks[0].output).toBeUndefined();
    await store.close();
  });

  it('rejects foreign origins and non-JSON mutations', async () => {
    const { store, server } = setup();
    const base = await ready(server);
    const foreign = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { ...headers(base), origin: 'http://evil.example' },
      body: '{}',
    });
    expect(foreign.status).toBe(403);
    const form = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { origin: base, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(form.status).toBe(415);
    store.close();
  });

  it('starts a new native conversation after changing provider or model', async () => {
    const { store, server } = setup();
    const base = await ready(server);
    const now = new Date().toISOString();
    const project: Project = {
      id: 'p',
      name: 'P',
      path: process.cwd(),
      createdAt: now,
      memoryWorkspace: 'pessoal',
      memoryProject: 'adelic',
    };
    store.putProject(project);
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      model: 'old',
      mode: 'auto',
      createdAt: now,
      updatedAt: now,
      nativeSessionId: 'codex-thread',
    };
    store.putSession(session);
    const changed = await fetch(`${base}/api/sessions/s`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ providerId: 'claude', model: 'new' }),
    });
    expect(changed.status).toBe(200);
    expect((await changed.json()).nativeSessionId).toBeUndefined();
    expect(store.getSession('s')?.nativeSessionId).toBeUndefined();
    const withNative = { ...store.getSession('s')!, nativeSessionId: 'claude-thread' };
    store.putSession(withNative);
    const defaultModel = await fetch(`${base}/api/sessions/s`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ model: null }),
    });
    expect(defaultModel.status).toBe(200);
    expect((await defaultModel.json()).model).toBeUndefined();
    expect(store.getSession('s')?.nativeSessionId).toBeUndefined();
    store.close();
  });

  it('defaults project coordination on and validates configuration updates atomically', async () => {
    const { store, server } = setup();
    const base = await ready(server);
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: headers(base),
      body: JSON.stringify({ name: 'test', path: process.cwd(), memoryWorkspace: 'pessoal', memoryProject: 'adelic' }),
    });
    const project = (await created.json()) as {
      id: string;
      orchestration: { enabled: boolean; maxWorkers: number; review: boolean };
    };
    expect(project.orchestration).toEqual({ enabled: true, maxWorkers: 2, review: true });
    const invalid = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ name: 'changed', orchestration: { enabled: true, maxWorkers: 8, review: true } }),
    });
    expect(invalid.status).toBe(400);
    expect(store.getProject(project.id)?.name).toBe('test');
    const invalidGraphify = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ name: 'also changed', graphify: { enabled: 'false' } }),
    });
    expect(invalidGraphify.status).toBe(400);
    expect(store.getProject(project.id)?.name).toBe('test');
    expect(store.getProject(project.id)?.graphify).toBeUndefined();
    const graphOff = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ graphify: { enabled: false } }),
    });
    expect(graphOff.status).toBe(200);
    expect((await graphOff.json()).graphify.enabled).toBe(false);
    const configured = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({
        orchestration: {
          enabled: true,
          maxWorkers: 2,
          review: true,
          workerProviderId: 'codex',
          workerModel: 'gpt-6-luna',
          reviewerProviderId: 'claude',
          reviewerModel: 'sonnet',
        },
      }),
    });
    expect(configured.status).toBe(200);
    const cleared = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({
        orchestration: {
          enabled: true,
          maxWorkers: 2,
          review: true,
          workerProviderId: null,
          workerModel: null,
          reviewerProviderId: null,
          reviewerModel: null,
        },
      }),
    });
    const clearedProject = await cleared.json();
    expect(cleared.status).toBe(200);
    expect(clearedProject.orchestration).toEqual({ enabled: true, maxWorkers: 2, review: true });
    const disabled = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ orchestration: { enabled: false, maxWorkers: 1, review: false } }),
    });
    expect(disabled.status).toBe(200);
    expect((await disabled.json()).orchestration.enabled).toBe(false);
    store.close();
  });

  it('runs a dependent multi-step plan and keeps full outputs out of coordination responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-tasks-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: false },
      orchestration: { enabled: true, maxWorkers: 2, review: false },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    const calls: { input: RunInput }[] = [];
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(input, emit) {
        calls.push({ input });
        emit({ type: 'usage', inputTokens: 10, outputTokens: 20, costUsd: 0.1 });
        if (input.prompt.includes('formato:'))
          return {
            text: JSON.stringify({
              tasks: [
                {
                  id: 'inspect',
                  title: 'Inspect',
                  instructions: 'Read the implementation',
                  scope: ['src/a.ts'],
                  dependsOn: [],
                },
                {
                  id: 'change',
                  title: 'Change',
                  instructions: 'Implement based on inspection',
                  scope: ['src/b.ts'],
                  dependsOn: ['inspect'],
                },
              ],
            }),
            stopReason: 'completed',
          };
        if (input.prompt.includes('Tarefa: Inspect')) return { text: 'I'.repeat(40_000), stopReason: 'completed' };
        if (input.prompt.includes('Tarefa: Change')) return { text: 'CHANGE FULL OUTPUT', stopReason: 'completed' };
        emit({ type: 'delta', text: 'final answer' });
        return { text: 'final answer', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, 'Implemente a alteração no arquivo do projeto em duas partes');
    await done;
    const workers = calls.filter(
      (c) => c.input.prompt.includes('Tarefa: Inspect') || c.input.prompt.includes('Tarefa: Change'),
    );
    expect(calls).toHaveLength(4);
    expect(workers.map((c) => c.input.plan.tools)).toEqual([true, true]);
    expect(store.listRuns('s')[0]).toMatchObject({ inputTokens: 40, outputTokens: 80, costUsd: 0.4 });
    expect(workers[1].input.prompt).toContain(`inspect: ${'I'.repeat(1200)}`);
    expect(workers[1].input.prompt).not.toContain('I'.repeat(2000));
    expect(store.listTasks('p').find((t) => t.title === 'Inspect')?.output).toHaveLength(40_000);
    const coordination = orchestrator.coordination('p')!;
    expect(coordination.tasks.map((t) => t.status)).toContain('completed');
    expect(coordination.tasks.every((t) => t.output === undefined)).toBe(true);
    await orchestrator.shutdown();
    store.close();
  });

  it('cancels every concurrently running child task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-child-cancel-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: false },
      orchestration: { enabled: true, maxWorkers: 2, review: false },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let workersStarted = 0;
    let allStarted!: () => void;
    const readyWorkers = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(input, emit, signal) {
        if (input.prompt.includes('Produza somente JSON válido'))
          return {
            text: JSON.stringify({
              tasks: [
                {
                  id: 'a',
                  title: 'A',
                  instructions: 'Não altere arquivos; leia componente A',
                  scope: [],
                  dependsOn: [],
                },
                {
                  id: 'b',
                  title: 'B',
                  instructions: 'Não altere arquivos; leia componente B',
                  scope: [],
                  dependsOn: [],
                },
              ],
            }),
            stopReason: 'completed',
          };
        workersStarted++;
        emit({ type: 'delta', text: 'partial child output' });
        if (workersStarted === 2) allStarted();
        return await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    await orchestrator.start(session, 'Implemente mudanças no código do projeto em módulos independentes');
    await readyWorkers;
    await orchestrator.cancel('s');
    await orchestrator.shutdown();
    expect(workersStarted).toBe(2);
    expect(store.listRuns('s')[0].status).toBe('cancelled');
    expect(
      orchestrator
        .coordination('p')
        ?.tasks.filter((t) => t.role === 'worker')
        .map((t) => t.status),
    ).toEqual(['cancelled', 'cancelled']);
    expect(
      store
        .listTasks('p')
        .filter((t) => t.role === 'worker')
        .every((t) => t.output === 'partial child output'),
    ).toBe(true);
    store.close();
  });

  it('uses one streamed worker for fast questions without replacing the project brief', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-fast-worker-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: true },
    });
    store.setSettings({ ...store.getSettings()!, memoryEnabled: true });
    let memoryCalls = 0;
    store.putBrief({
      projectId: 'p',
      updatedAt: now,
      paths: ['src/index.ts'],
      truncated: false,
      objective: 'prior objective',
      summary: 'prior architecture',
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    const current = `What does 2 + 2 equal? ${'x'.repeat(5000)} END-OF-REQUEST`;
    let calls = 0,
      toolEvents = 0;
    let captured: RunInput | undefined;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'm1', isDefault: true, efforts: ['low'] }],
            defaultModel: 'm1',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input, emit) {
        calls++;
        captured = input;
        emit({ type: 'delta', text: '4' });
        return { text: '4', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers, async () => {
      memoryCalls++;
      return 'should not load';
    });
    orchestrator.subscribe((event) => {
      if (event.type === 'event' && event.event.type === 'tool') toolEvents++;
    });
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, current);
    await done;
    expect(calls).toBe(1);
    expect(toolEvents).toBe(0);
    expect(memoryCalls).toBe(0);
    expect(captured?.plan).toMatchObject({
      level: 'fast',
      effort: 'low',
      tools: true,
      memory: false,
      contextBudget: 3500,
    });
    expect(captured?.prompt).toContain('END-OF-REQUEST');
    expect(captured?.memoryContext).toBeUndefined();
    expect(captured?.prompt).not.toContain('Procedimentos aplicáveis');
    expect(orchestrator.coordination('p')?.tasks.map((t) => t.role)).toEqual(['worker']);
    expect(store.getBrief('p')?.objective).toBe('prior objective');
    await orchestrator.shutdown();
    store.close();
  });

  it('keeps explicit quick mode tool-enabled for a file request and tracks its single executor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-fast-file-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: true },
      orchestration: { enabled: true, maxWorkers: 3, review: true },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let calls = 0;
    let captured: RunInput | undefined;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'm1', isDefault: true, efforts: ['low'] }],
            defaultModel: 'm1',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input, emit) {
        calls++;
        captured = input;
        emit({ type: 'tool', name: 'read_file', description: 'README.md', status: 'completed', toolCallId: 'read-1' });
        emit({ type: 'delta', text: 'Found the project overview.' });
        return { text: 'Found the project overview.', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === 's' && event.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, 'Leia README');
    await done;
    expect(calls).toBe(1);
    expect(captured?.plan).toMatchObject({ level: 'fast', tools: true, memory: false, effort: 'low' });
    expect(captured?.prompt).toContain('use as ferramentas disponíveis');
    expect(store.listSessionTasks('s').map((task) => task.role)).toEqual(['worker']);
    expect(store.listSessionTasks('s')[0]).toMatchObject({
      status: 'completed',
      output: 'Found the project overview.',
    });
    expect(store.listEvents('s').some((event) => event.type === 'tool' && event.toolCallId?.endsWith(':read-1'))).toBe(
      true,
    );
    await orchestrator.shutdown();
    store.close();
  });

  it('reports when a provider cannot honor fast-mode tool availability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-fast-no-tools-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let calls = 0;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: false, approvals: false, cancel: true },
          },
        ];
      },
      async run() {
        calls++;
        return { text: 'unexpected', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const failed = new Promise<Run>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.sessionId === 's' && event.run.status === 'failed') resolve(event.run);
      }),
    );
    await orchestrator.start(session, 'O que é uma árvore binária?');
    const run = await failed;
    expect(calls).toBe(0);
    expect(run.error).toContain('não disponibiliza ferramentas');
    expect(store.listMessages('s').at(-1)?.content).toContain('não disponibiliza ferramentas');
    await orchestrator.shutdown();
    store.close();
  });

  it('loads memory only when routed and forwards bounded untrusted context to relevant roles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-memory-context-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: false },
      orchestration: { enabled: true, maxWorkers: 2, review: true },
    });
    store.setSettings({ ...store.getSettings()!, memoryEnabled: true });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let memoryLookups = 0;
    const memoryLoader = async (_project: Project, query: string) => {
      memoryLookups++;
      if (query.includes('NO-MATCH')) return undefined;
      if (query.includes('LOOKUP-FAIL')) throw new Error('simulated memory timeout');
      return `Private note\n${'memory '.repeat(1000)}`;
    };
    const inputs: RunInput[] = [];
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [
              { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'high'] },
              { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['low', 'high'] },
            ],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(input, emit) {
        inputs.push(input);
        if (input.prompt.includes('Produza somente JSON válido'))
          return {
            text: JSON.stringify({
              tasks: [
                {
                  id: 'inspect',
                  title: 'Inspect',
                  instructions: 'Read the relevant implementation',
                  scope: ['src/a.ts'],
                  dependsOn: [],
                },
              ],
            }),
            stopReason: 'completed',
          };
        if (input.prompt.includes('Faça revisão independente'))
          return { text: 'Review complete', stopReason: 'completed' };
        if (input.prompt.includes('Responda ao pedido completo')) {
          emit({ type: 'delta', text: 'Answer' });
          return { text: 'Answer', stopReason: 'completed' };
        }
        return { text: 'Worker result', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers, memoryLoader);
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, 'Pesquise na memória anterior e implemente uma alteração no arquivo do projeto');
    await done;
    expect(memoryLookups).toBe(1);
    expect(inputs).toHaveLength(4);
    for (const input of inputs) {
      expect(input.memoryContext).toContain('DADOS DE MEMÓRIA NÃO CONFIÁVEIS');
      expect(input.memoryContext!.length).toBeLessThan(4200);
    }
    expect(inputs.find((input) => input.prompt.includes('Faça revisão independente'))?.prompt).toContain(
      'Procedimentos aplicáveis',
    );
    expect(inputs.find((input) => input.prompt.includes('Responda ao pedido completo'))?.prompt).toContain(
      'Procedimentos aplicáveis',
    );
    const runSimpleMemory = async (id: string, request: string, marker: string) => {
      inputs.length = 0;
      memoryLookups = 0;
      const simpleSession: Session = { ...session, id, title: id, createdAt: now, updatedAt: now };
      store.putSession(simpleSession);
      const finished = new Promise<void>((resolve) =>
        orchestrator.subscribe((e) => {
          if (e.type === 'run' && e.run.sessionId === id && e.run.status === 'completed') resolve();
        }),
      );
      await orchestrator.start(simpleSession, request);
      await finished;
      expect(memoryLookups).toBe(1);
      expect(inputs).toHaveLength(1);
      expect(inputs[0].plan).toMatchObject({ level: 'deep', tools: false, effort: 'high' });
      expect(inputs[0].memoryContext).toContain(marker);
      expect(orchestrator.coordination('p')?.tasks[0].role).toBe('worker');
    };
    await runSimpleMemory('s2', 'NO-MATCH: O que decidimos sobre VPN na memória?', 'nenhuma nota pertinente');
    await runSimpleMemory('s3', 'LOOKUP-FAIL: O que decidimos sobre VPN na memória?', 'simulated memory timeout');
    await orchestrator.shutdown();
    store.close();
  });

  it('delegates simple deep inspection directly to one tool-enabled worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-deep-inspection-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: false },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let calls = 0;
    let captured: RunInput | undefined;
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'm1', isDefault: true, efforts: ['low'] }],
            defaultModel: 'm1',
            capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
          },
        ];
      },
      async run(input, emit) {
        calls++;
        captured = input;
        emit({ type: 'delta', text: 'Inspected.' });
        return { text: 'Inspected.', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, 'Leia o arquivo do projeto e explique o fluxo principal');
    await done;
    expect(calls).toBe(1);
    expect(captured?.plan.tools).toBe(true);
    expect(orchestrator.coordination('p')?.tasks.map((t) => t.role)).toEqual(['worker']);
    await orchestrator.shutdown();
    store.close();
  });

  it('preserves partial output from a cancelled direct inspection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-inspect-cancel-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'w',
      memoryProject: 'p',
      graphify: { enabled: false },
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'deep',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let emitted!: () => void;
    const firstDelta = new Promise<void>((resolve) => {
      emitted = resolve;
    });
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(_input, emit, signal) {
        emit({ type: 'delta', text: 'partial inspection' });
        emitted();
        return await new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    await orchestrator.start(session, 'Leia o arquivo do projeto e explique o fluxo principal');
    await firstDelta;
    await orchestrator.cancel('s');
    await orchestrator.shutdown();
    expect(store.listMessages('s').find((m) => m.role === 'assistant')?.content).toBe('partial inspection');
    expect(store.listMessages('s').find((m) => m.role === 'assistant')?.status).toBe('cancelled');
    expect(store.listTasks('p')[0]).toMatchObject({ status: 'cancelled', output: 'partial inspection' });
    store.close();
  });

  it('does not leave a partial turn when accepting it fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-atomic-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'pessoal',
      memoryProject: 'adelic',
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'auto',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    const user = { id: 'u', sessionId: 's', runId: 'r', role: 'user' as const, content: 'hello', createdAt: now };
    const assistant = { id: 'a', sessionId: 's', runId: 'r', role: 'assistant' as const, content: '', createdAt: now };
    const run = {
      id: 'r',
      sessionId: 's',
      providerId: 'codex' as const,
      status: 'running' as const,
      route: {
        level: 'fast' as const,
        reason: 'test',
        tools: false,
        memory: false,
        effort: 'low' as const,
        contextBudget: 6000,
      },
      startedAt: now,
    };
    store.addMessage({ ...user, id: 'taken' });
    expect(() =>
      store.createRun(user, { ...assistant, id: 'taken' }, run, { ...session, activeRunId: 'r' }, 'retry'),
    ).toThrow();
    expect(store.listMessages('s')).toHaveLength(1);
    expect(store.getRun('r')).toBeUndefined();
    expect(store.getSession('s')?.activeRunId).toBeUndefined();
    store.close();
  });

  it('rejects a second decision while an approval is in flight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-approval-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'pessoal',
      memoryProject: 'adelic',
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let releaseApproval!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let approvals = 0;
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: true, cancel: true },
          },
        ];
      },
      async run(input, emit) {
        const approval: Approval = {
          id: 'approval',
          runId: input.runId,
          sessionId: input.sessionId,
          title: 'Tool',
          detail: 'test',
          kind: 'tool',
          status: 'pending',
        };
        emit({ type: 'approval', approval });
        await runGate;
        return { text: 'done', stopReason: 'completed' };
      },
      async approve() {
        approvals++;
        await gate;
      },
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    await orchestrator.start(session, 'hello');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const first = orchestrator.decide('approval', 's', 'approve');
    await expect(orchestrator.decide('approval', 's', 'deny')).rejects.toMatchObject({ status: 409 });
    expect(approvals).toBe(1);
    releaseApproval();
    await first;
    expect(store.getApproval('approval')?.status).toBe('approved');
    releaseRun();
    await orchestrator.shutdown();
    store.close();
  });

  it('persists streamed text before notifying listeners', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-delta-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'pessoal',
      memoryProject: 'adelic',
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    const providers: ProviderRegistry = {
      async list() {
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: false, cancel: true },
          },
        ];
      },
      async run(_input, emit) {
        emit({ type: 'delta', text: 'first' });
        emit({ type: 'delta', text: ' second' });
        return { text: 'first second', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const snapshots: string[] = [];
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status === 'completed') resolve();
      }),
    );
    orchestrator.subscribe((event) => {
      if (event.type === 'delta')
        snapshots.push(store.listMessages('s').find((m) => m.id === event.messageId)?.content ?? '');
    });
    await orchestrator.start(session, 'hello');
    await done;
    await orchestrator.shutdown();
    expect(snapshots).toEqual(['first', 'first second']);
    store.close();
  });

  it('does not start a provider after cancellation during discovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-cancel-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'pessoal',
      memoryProject: 'adelic',
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    let releaseList!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let runCalls = 0;
    const providers: ProviderRegistry = {
      async list() {
        await gate;
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [],
            capabilities: { fast: true, tools: true, approvals: false, cancel: true },
          },
        ];
      },
      async run() {
        runCalls++;
        return { text: 'unexpected', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const orchestrator = new Orchestrator(store, providers);
    const accepted = await orchestrator.start(session, 'hello');
    await orchestrator.cancel('s');
    releaseList();
    await orchestrator.shutdown();
    expect(runCalls).toBe(0);
    expect(store.getRun(accepted.runId)?.status).toBe('cancelled');
    expect(store.getSession('s')?.activeRunId).toBeUndefined();
    store.close();
  });

  it('keeps execution permissions and style from the accepted turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-settings-'));
    dirs.push(dir);
    const store = new Store(dir);
    const now = new Date().toISOString();
    store.putProject({
      id: 'p',
      name: 'P',
      path: dir,
      createdAt: now,
      memoryWorkspace: 'pessoal',
      memoryProject: 'adelic',
    });
    const session: Session = {
      id: 's',
      projectId: 'p',
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    store.setSettings({ ...store.getSettings()!, approvalMode: 'manual' });
    let releaseList!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let received: RunInput | undefined;
    const providers: ProviderRegistry = {
      async list() {
        await gate;
        return [
          {
            id: 'codex',
            name: 'stub',
            installed: true,
            available: true,
            status: 'ready',
            detail: 'test',
            models: [{ id: 'm1', name: 'm1', efforts: ['low'] }],
            capabilities: { fast: true, tools: true, approvals: false, cancel: true },
          },
        ];
      },
      async run(input) {
        received = input;
        return { text: 'ok', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const { app, orchestrator } = createBackend(store, providers);
    const server = createServer(app);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    const base = await ready(server);
    const finished = new Promise<void>((resolve) =>
      orchestrator.subscribe((event) => {
        if (event.type === 'run' && event.run.status === 'completed') resolve();
      }),
    );
    await orchestrator.start(session, 'hello');
    const changed = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ sandbox: 'workspace-write', responseStyle: 'concise', approvalMode: 'auto-safe' }),
    });
    expect(changed.status).toBe(200);
    releaseList();
    await finished;
    expect(received?.sandbox).toBe('read-only');
    expect(received?.approvalMode).toBe('manual');
    expect(received?.prompt).toContain('resposta equilibrada');
    expect(store.getSettings()?.sandbox).toBe('workspace-write');
    expect(store.getSettings()?.approvalMode).toBe('auto-safe');
    const invalid = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ approvalMode: 'always' }),
    });
    expect(invalid.status).toBe(400);
    const manual = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: headers(base),
      body: JSON.stringify({ approvalMode: 'manual' }),
    });
    expect(manual.status).toBe(200);
    expect((await manual.json()).approvalMode).toBe('manual');
    store.close();
  });
});
