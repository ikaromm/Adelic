import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import {
  HANDOFF_MESSAGE_MAX,
  HANDOFF_PROMPT_MARKER,
  HANDOFF_TRANSCRIPT_MAX,
  boundedHistory,
  buildHandoffPrompt,
  handoffHistory,
  localSummary,
  performHandoff,
} from '../server/provider-handoff.js';
import type {
  Message,
  ProviderEvent,
  ProviderInfo,
  ProviderRegistry,
  RunInput,
  RunResult,
  Session,
} from '../shared/contracts.js';

const servers: Server[] = [];
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SUMMARY = '**Objetivo**\nExportar CSV.\n\n**Próximo passo**\nLigar o botão.';
const info = (id: 'codex' | 'kiro', name: string, available = true): ProviderInfo => ({
  id,
  name,
  installed: true,
  available,
  status: available ? 'ready' : 'missing',
  detail: '',
  models: [{ id: `${id}-m`, name: `${id} model`, isDefault: true }],
  defaultModel: `${id}-m`,
  capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: false },
});

type Script = (input: RunInput, emit: (e: ProviderEvent) => void, signal: AbortSignal) => Promise<RunResult>;
const answer: Script = async (input, emit) => {
  const text = input.prompt.startsWith(HANDOFF_PROMPT_MARKER) ? SUMMARY : 'ok';
  emit({ type: 'delta', text });
  return { text, stopReason: 'completed' };
};

async function setup(opts: { script?: Script; codexAvailable?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-handoff-'));
  dirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  const inputs: RunInput[] = [];
  const approvals: [string, string][] = [];
  const providers: ProviderRegistry = {
    async list() {
      return [info('codex', 'Codex', opts.codexAvailable !== false), info('kiro', 'Kiro')];
    },
    async run(input, emit, signal) {
      inputs.push(structuredClone(input));
      return (opts.script ?? answer)(input, emit, signal);
    },
    async approve(id, decision) {
      approvals.push([id, decision]);
    },
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers);
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const now = new Date().toISOString();
  const session: Session = {
    id: 's',
    projectId: null,
    title: 'T',
    providerId: 'codex',
    model: 'codex-m',
    mode: 'fast',
    thinking: 'auto',
    nativeSessionId: 'codex-thread',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: base },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
  };
  const idle = async () => {
    for (let i = 0; i < 200 && (store.getSession('s')?.activeRunId || orchestrator.isActive('s')); i++)
      await new Promise((r) => setTimeout(r, 10));
  };
  const say = async (content: string) => {
    const res = await call('POST', '/api/sessions/s/messages', { content });
    expect(res.status).toBe(202);
    await idle();
  };
  return { store, orchestrator, inputs, approvals, call, say, idle };
}

const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({
  id: `${role}-${content.slice(0, 8)}-${Math.random()}`,
  sessionId: 's',
  role,
  content,
  createdAt: new Date().toISOString(),
  ...extra,
});

describe('handoff summary prompt and local summary', () => {
  it('bounds the transcript, caps each message and counts what was left out', () => {
    const long = 'x'.repeat(HANDOFF_MESSAGE_MAX * 3);
    const messages = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `${i} ${long}`));
    messages.push(msg('user', 'último pedido'));
    const prompt = buildHandoffPrompt(messages, 'Codex', 'Kiro');
    expect(prompt.startsWith(HANDOFF_PROMPT_MARKER)).toBe(true);
    expect(prompt).toContain('Kiro');
    expect(prompt).toContain('Não use ferramentas');
    expect(prompt).toContain('**Próximo passo**');
    expect(prompt.length).toBeLessThan(HANDOFF_TRANSCRIPT_MAX + 2000);
    expect(prompt).toContain('Usuário: último pedido');
    expect(prompt).toMatch(/\[\d+ mensagens anteriores omitidas\]/);
    expect(prompt).not.toContain('x'.repeat(HANDOFF_MESSAGE_MAX + 1));
    expect(prompt).toContain('[…]');
  });

  it('starts from the latest earlier handoff summary', () => {
    const messages = [
      msg('user', 'pedido antigo'),
      msg('system', 'resumo anterior', {
        handoff: {
          fromProviderId: 'kiro',
          fromName: 'Kiro',
          toProviderId: 'codex',
          toName: 'Codex',
          source: 'model',
        },
      }),
      msg('user', 'pedido novo'),
    ];
    const prompt = buildHandoffPrompt(messages, 'Codex', 'Kiro');
    expect(prompt).not.toContain('pedido antigo');
    expect(prompt).toContain('Resumo anterior: resumo anterior');
    const local = localSummary(messages, 'teste');
    expect(local).toContain('**Resumo anterior**\nresumo anterior');
    expect(local).not.toContain('pedido antigo');
  });

  it('builds a deterministic local summary with objective, state, references and next step', () => {
    const messages = [
      msg('user', 'Adicione exportação CSV em src/report.ts'),
      msg('assistant', 'Criei `npm run export` e alterei server/http/runs.ts.'),
      msg('user', 'Agora ligue o botão'),
    ];
    const a = localSummary(messages, 'Codex indisponível');
    expect(a).toBe(localSummary(messages, 'Codex indisponível'));
    expect(a).toContain('sem chamada de modelo (Codex indisponível)');
    expect(a).toContain('**Objetivo**\nAdicione exportação CSV em src/report.ts');
    expect(a).toContain('Última resposta do agente: Criei');
    expect(a).toContain('`npm run export`');
    expect(a).toContain('`src/report.ts`');
    expect(a).toContain('`server/http/runs.ts`');
    expect(a).toContain('Retomar a partir do último pedido: Agora ligue o botão');
    expect(localSummary([], 'x')).toContain('nenhum registrado');
  });

  it('gives later runs the summary and only the messages after it, keeping the summary within budget', () => {
    const summary = msg('system', 'S'.repeat(5000), {
      handoff: { fromProviderId: 'codex', fromName: 'Codex', toProviderId: 'kiro', toName: 'Kiro', source: 'model' },
    });
    const messages = [msg('user', 'antes'), summary, msg('user', 'depois'), msg('assistant', 'resposta')];
    const history = handoffHistory(messages);
    expect(history.map((m) => m.content.slice(0, 20))).toEqual([
      expect.stringContaining('[Resumo da conversa'),
      'depois',
      'resposta',
    ]);
    // Sent as an assistant turn so a model-written summary never reads as a system instruction.
    expect(history[0].role).toBe('assistant');
    expect(handoffHistory([msg('user', 'a')])).toHaveLength(1);
    const bounded = boundedHistory(history, 2500);
    expect(bounded[0].content.length).toBeLessThanOrEqual(1500);
    expect(bounded.slice(1).map((m) => m.content)).toEqual(['depois', 'resposta']);
    // With a tiny budget the summary still survives.
    expect(boundedHistory(history, 10)).toHaveLength(1);
    expect(boundedHistory([msg('user', 'abc')], 10).map((m) => m.content)).toEqual(['abc']);
  });
});

describe('POST /api/sessions/:id/handoff', () => {
  it('summarizes on the current provider read-only, switches, clears the native thread and feeds the next run', async () => {
    const t = await setup();
    await t.say('primeiro pedido sobre src/report.ts');
    const before = t.inputs.length;
    const res = await t.call('POST', '/api/sessions/s/handoff', {
      providerId: 'kiro',
      model: 'kiro-m',
      summary: 'model',
    });
    expect(res.status).toBe(202);
    const summaryCall = t.inputs[before];
    expect(summaryCall).toMatchObject({ providerId: 'codex', model: 'codex-m', sandbox: 'read-only', history: [] });
    expect(summaryCall.plan).toMatchObject({ tools: false, memory: false, level: 'fast' });
    expect(summaryCall.nativeSessionId).toBeUndefined();
    expect(summaryCall.prompt).toContain('primeiro pedido sobre src/report.ts');
    expect(res.body.session).toMatchObject({ providerId: 'kiro', model: 'kiro-m', thinking: 'auto' });
    expect(res.body.session.nativeSessionId).toBeUndefined();
    expect(t.store.getSession('s')?.nativeSessionId).toBeUndefined();
    expect(res.body.message).toMatchObject({
      role: 'system',
      content: SUMMARY,
      handoff: { fromProviderId: 'codex', fromName: 'Codex', toProviderId: 'kiro', toName: 'Kiro', source: 'model' },
    });
    expect(res.body.message.handoff.fallback).toBeUndefined();
    expect(t.store.listMessages('s').at(-1)).toMatchObject({ id: res.body.message.id, role: 'system' });

    await t.say('[eco] continue');
    const next = t.inputs.at(-1)!;
    expect(next.providerId).toBe('kiro');
    expect(next.nativeSessionId).toBeUndefined();
    const historyText = next.history.map((m) => m.content).join('\n');
    expect(historyText).toContain(SUMMARY);
    expect(historyText).not.toContain('primeiro pedido');
    expect(next.prompt).not.toContain('primeiro pedido');
    expect(next.prompt).toContain('[eco] continue');
    // A later message after the handoff is carried along with the summary.
    await t.say('mais um');
    const third = t.inputs.at(-1)!;
    expect(third.history[0].content).toContain(SUMMARY);
    expect(third.history.map((m) => m.content)).toContain('[eco] continue');
    expect(third.history.map((m) => m.content).join('\n')).not.toContain('primeiro pedido');
  });

  it('falls back to a local summary when the summary call fails, and says so', async () => {
    const t = await setup({
      script: async (input, emit) => {
        if (input.prompt.startsWith(HANDOFF_PROMPT_MARKER)) throw new Error('401 Unauthorized');
        return answer(input, emit, new AbortController().signal);
      },
    });
    await t.say('pedido inicial');
    const res = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    expect(res.status).toBe(202);
    expect(res.body.message.handoff).toMatchObject({ source: 'local' });
    expect(res.body.message.handoff.fallback).toContain('o resumo pelo Codex falhou: 401 Unauthorized');
    expect(res.body.message.content).toContain('Resumo gerado localmente');
    expect(res.body.message.content).toContain('pedido inicial');
    expect(res.body.session.providerId).toBe('kiro');
    expect(res.body.session.model).toBeUndefined();
  });

  it('falls back to a local summary when the reply is empty', async () => {
    const t = await setup({
      script: async (input, emit) =>
        input.prompt.startsWith(HANDOFF_PROMPT_MARKER)
          ? { text: '  ', stopReason: 'completed' }
          : answer(input, emit, new AbortController().signal),
    });
    await t.say('pedido');
    const res = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    expect(res.body.message.handoff.fallback).toContain('não devolveu um resumo');
  });

  it('does not call an unavailable current provider and builds the summary locally', async () => {
    const t = await setup({ codexAvailable: false });
    const now = new Date().toISOString();
    t.store.addMessage({ id: 'u1', sessionId: 's', role: 'user', content: 'pedido antigo', createdAt: now });
    t.store.addMessage({ id: 'a1', sessionId: 's', role: 'assistant', content: 'resposta antiga', createdAt: now });
    const res = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    expect(res.status).toBe(202);
    expect(t.inputs).toHaveLength(0);
    expect(res.body.message.handoff).toMatchObject({ source: 'local', fallback: 'Codex indisponível' });
  });

  it("'local' never calls a model and 'none' switches without a message, keeping the recent history", async () => {
    const t = await setup();
    await t.say('pedido A');
    const calls = t.inputs.length;
    const local = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'local' });
    expect(local.status).toBe(202);
    expect(t.inputs).toHaveLength(calls);
    expect(local.body.message.handoff).toMatchObject({ source: 'local' });
    expect(local.body.message.handoff.fallback).toBeUndefined();

    const none = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'codex', summary: 'none' });
    expect(none.status).toBe(202);
    expect(none.body.message).toBeUndefined();
    expect(none.body.session.providerId).toBe('codex');
    expect(t.inputs).toHaveLength(calls);
  });

  it("'none' carries the recent history to the new provider", async () => {
    const t = await setup();
    await t.say('pedido A sobre o relatório');
    t.store.putSession({ ...t.store.getSession('s')!, nativeSessionId: 'codex-thread' });
    const res = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'none' });
    expect(res.status).toBe(202);
    expect(t.store.getSession('s')?.nativeSessionId).toBeUndefined();
    await t.say('continue');
    const next = t.inputs.at(-1)!;
    expect(next.providerId).toBe('kiro');
    expect(next.nativeSessionId).toBeUndefined();
    expect(next.history.map((m) => m.content)).toEqual(['pedido A sobre o relatório', 'ok']);
  });

  it('does not add a summary to an empty conversation', async () => {
    const t = await setup();
    const res = await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    expect(res.status).toBe(202);
    expect(res.body.message).toBeUndefined();
    expect(t.inputs).toHaveLength(0);
  });

  it('validates the request', async () => {
    const t = await setup();
    const post = (body: unknown) => t.call('POST', '/api/sessions/s/handoff', body);
    expect(await post({ providerId: 'nope', summary: 'model' })).toMatchObject({
      status: 400,
      body: { error: 'providerId inválido' },
    });
    expect(await post({ providerId: 'kiro', summary: 'tudo' })).toMatchObject({
      status: 400,
      body: { error: 'summary deve ser model, local ou none' },
    });
    expect((await post({ providerId: 'kiro', model: '', summary: 'none' })).status).toBe(400);
    expect(await post({ providerId: 'kiro', model: 'outro', summary: 'none' })).toMatchObject({
      status: 400,
      body: { error: 'Modelo não anunciado para este provedor' },
    });
    expect(await post({ providerId: 'codex', summary: 'none' })).toMatchObject({
      status: 400,
      body: { error: 'Escolha um agente diferente do atual' },
    });
    expect(await post({ providerId: 'claude', summary: 'none' })).toMatchObject({
      status: 400,
      body: { error: 'Provedor não encontrado' },
    });
    expect((await t.call('POST', '/api/sessions/zz/handoff', { providerId: 'kiro', summary: 'none' })).status).toBe(
      404,
    );
    expect(t.store.getSession('s')).toMatchObject({ providerId: 'codex', nativeSessionId: 'codex-thread' });
  });

  it('refuses an unavailable target', async () => {
    const t = await setup({ codexAvailable: false });
    t.store.putSession({ ...t.store.getSession('s')!, providerId: 'kiro' });
    expect(await t.call('POST', '/api/sessions/s/handoff', { providerId: 'codex', summary: 'none' })).toMatchObject({
      status: 400,
      body: { error: 'Codex está indisponível neste computador' },
    });
  });

  it('returns 409 while a run is active, while a plan executes and while another handoff writes its summary', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await setup({
      script: async (input, emit) => {
        await gate;
        return answer(input, emit, new AbortController().signal);
      },
    });
    const sent = await t.call('POST', '/api/sessions/s/messages', { content: 'demorado' });
    expect(sent.status).toBe(202);
    expect(await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'none' })).toMatchObject({
      status: 409,
      body: { error: 'Não é possível trocar de agente durante uma execução' },
    });
    release();
    await t.idle();

    const now = new Date().toISOString();
    t.store.putPlan({
      id: 'plan',
      sessionId: 's',
      runId: 'r',
      title: 'P',
      status: 'executing',
      requirements: '',
      design: '',
      tasks: [],
      markdown: '',
      createdAt: now,
      updatedAt: now,
    });
    expect((await t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'none' })).status).toBe(409);
    t.store.putPlan({ ...t.store.getPlan('plan')!, status: 'approved' });

    // While the summary is being written, messages and PATCH wait for 409.
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((r) => (releaseSummary = r));
    const slow = await setup({
      script: async (input, emit) => {
        if (input.prompt.startsWith(HANDOFF_PROMPT_MARKER)) await summaryGate;
        return answer(input, emit, new AbortController().signal);
      },
    });
    await slow.say('pedido');
    const pending = slow.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    for (let i = 0; i < 100 && !slow.orchestrator.isActive('s'); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await slow.call('POST', '/api/sessions/s/messages', { content: 'x' })).status).toBe(409);
    expect((await slow.call('PATCH', '/api/sessions/s', { mode: 'deep' })).status).toBe(409);
    expect((await slow.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'none' })).status).toBe(
      409,
    );
    releaseSummary();
    expect((await pending).status).toBe(202);
    expect(slow.orchestrator.isActive('s')).toBe(false);
  });

  it('cancelling during the summary leaves the conversation on the current provider', async () => {
    const t = await setup({
      script: async (input, emit, signal) => {
        if (input.prompt.startsWith(HANDOFF_PROMPT_MARKER))
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        return answer(input, emit, signal);
      },
    });
    await t.say('pedido');
    const pending = t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    for (let i = 0; i < 100 && !t.orchestrator.isActive('s'); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await t.call('POST', '/api/sessions/s/cancel', {})).status).toBe(202);
    expect(await pending).toMatchObject({ status: 409, body: { error: 'Passagem cancelada' } });
    expect(t.store.getSession('s')?.providerId).toBe('codex');
    expect(t.store.listMessages('s').some((m) => m.handoff)).toBe(false);
  });

  it('starts messages queued during the handoff on the new provider', async () => {
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((r) => (releaseSummary = r));
    const t = await setup({
      script: async (input, emit) => {
        if (input.prompt.startsWith(HANDOFF_PROMPT_MARKER)) await summaryGate;
        return answer(input, emit, new AbortController().signal);
      },
    });
    await t.say('pedido');
    const pending = t.call('POST', '/api/sessions/s/handoff', { providerId: 'kiro', summary: 'model' });
    for (let i = 0; i < 100 && !t.orchestrator.isActive('s'); i++) await new Promise((r) => setTimeout(r, 5));
    expect((await t.call('POST', '/api/sessions/s/queue', { content: 'na fila' })).status).toBe(201);
    releaseSummary();
    expect((await pending).status).toBe(202);
    for (let i = 0; i < 100 && t.inputs.at(-1)?.providerId !== 'kiro'; i++) await new Promise((r) => setTimeout(r, 10));
    await t.idle();
    expect(t.inputs.at(-1)).toMatchObject({ providerId: 'kiro' });
    expect(t.inputs.at(-1)!.history[0].content).toContain(SUMMARY);
  });
});

describe('performHandoff', () => {
  it('denies approvals requested by the summary call and times out to the local summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-handoff-direct-'));
    dirs.push(dir);
    const store = new Store(dir);
    stores.push(store);
    const now = new Date().toISOString();
    const session: Session = {
      id: 's',
      projectId: null,
      title: 'T',
      providerId: 'codex',
      mode: 'auto',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(session);
    store.addMessage({ id: 'u', sessionId: 's', role: 'user', content: 'pedido', createdAt: now });
    const denied: string[] = [];
    const events: string[] = [];
    const providers: ProviderRegistry = {
      list: async () => [info('codex', 'Codex'), info('kiro', 'Kiro')],
      async run(input, emit, signal) {
        emit({
          type: 'approval',
          approval: {
            id: 'ap',
            runId: input.runId,
            sessionId: 's',
            title: 't',
            detail: '',
            kind: 'command',
            status: 'pending',
          },
        });
        emit({ type: 'session', nativeSessionId: 'leak' });
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        return { text: '', stopReason: 'completed' };
      },
      async approve(id, decision) {
        denied.push(`${id}:${decision}`);
      },
      async shutdown() {},
    };
    const result = await performHandoff(
      {
        store,
        providers,
        providerList: () => providers.list(),
        emit: (e) => events.push(e.type),
        cwd: dir,
        signal: new AbortController().signal,
        timeoutMs: 30,
      },
      session,
      { providerId: 'kiro', summary: 'model' },
    );
    expect(denied).toEqual(['ap:deny']);
    expect(result.message?.handoff?.fallback).toContain('tempo esgotado');
    expect(result.session.nativeSessionId).toBeUndefined();
    // The summary call is recorded as a run (started, then failed) for the usage limits.
    expect(events).toEqual(['run', 'run', 'message', 'session']);
    expect(store.listRuns('s')[0]).toMatchObject({ status: 'failed', handoff: { toProviderId: 'kiro' } });
  });
});
