import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from '../server/index.js';
import {
  COMPACTION_INPUT_BUDGET,
  COMPACTION_PROMPT_MARKER,
  SUMMARY_MAX,
  autoCompactReason,
  boundTranscript,
  buildCompactionPrompt,
  cleanSummary,
  messagesAfter,
  runContext,
} from '../server/compaction.js';
import { builtinCommands, expandMessage, listCommands } from '../server/commands.js';
import { migrate, migrations, userVersion } from '../server/migrations.js';
import { boundedPrompt } from '../server/providers/common.js';
import { Store } from '../server/store.js';
import { COMPACTING_TEXT, COMPACT_INVALID, compactCommand } from '../shared/compaction.js';
import { COMMAND_RESERVED, commandFieldsError } from '../shared/commands.js';
import type {
  Compaction,
  Message,
  ProviderRegistry,
  Run,
  RunInput,
  RunResult,
  Session,
  Settings,
  StreamEvent,
} from '../shared/contracts.js';
import { timelineSegments, upsertCompaction } from '../src/compaction-timeline.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tempDir = (prefix = 'adelic-compact-') => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
let clock = Date.parse('2026-10-07T10:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();
const msg = (id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({
  id,
  sessionId: 's',
  role,
  content,
  createdAt: tick(),
  ...extra,
});
const settings = (over: Partial<Settings> = {}): Settings => ({
  defaultProviderId: 'codex',
  defaultMode: 'auto',
  memoryEnabled: false,
  sandbox: 'read-only',
  responseStyle: 'balanced',
  ...over,
});
const compaction = (upTo: string, summary = 'resumo', extra: Partial<Compaction> = {}): Compaction => ({
  id: `c-${upTo}`,
  sessionId: 's',
  runId: `r-${upTo}`,
  summary,
  upToMessageId: upTo,
  createdAt: tick(),
  ...extra,
});

describe('/compactar detection', () => {
  it('recognises the command alone, rejects text after it and ignores anything else', () => {
    expect(compactCommand('/compactar')).toBe('compact');
    expect(compactCommand('  /compactar  \n')).toBe('compact');
    expect(compactCommand('/COMPACTAR')).toBe('compact');
    expect(compactCommand('/compactar agora')).toBe('invalid');
    expect(compactCommand('/compactarx')).toBeUndefined();
    expect(compactCommand('compactar')).toBeUndefined();
    expect(compactCommand('por favor /compactar')).toBeUndefined();
  });
});

describe('summary prompt', () => {
  it('keeps the newest messages within the budget, cutting the oldest one that does not fit', () => {
    const messages = [
      msg('1', 'user', 'q'.repeat(50)),
      msg('2', 'assistant', 'w'.repeat(50)),
      msg('3', 'user', 'z'.repeat(30)),
      msg('4', 'assistant', ''),
      msg('5', 'assistant', 'parcial', { status: 'running' }),
    ];
    const bounded = boundTranscript(messages, 60);
    // 3 fits whole (30), 2 is cut to the remaining 30 keeping its end, 1 is omitted; empty and running skipped.
    expect(bounded.included).toBe(2);
    expect(bounded.omitted).toBe(1);
    expect(bounded.transcript).toContain('z'.repeat(30));
    expect(bounded.transcript).toContain(`[…] ${'w'.repeat(30)}`);
    expect(bounded.transcript).not.toContain('q');
    expect(bounded.transcript).not.toContain('parcial');
    expect(bounded.transcript.indexOf('AGENTE')).toBeLessThan(bounded.transcript.indexOf('USUÁRIO'));
  });

  it('caps a single huge message and the whole transcript at the default budget', () => {
    const huge = Array.from({ length: 20 }, (_, i) => msg(`h${i}`, 'user', 'x'.repeat(20_000)));
    const { transcript, included, omitted } = boundTranscript(huge);
    const text = transcript.replace(/USUÁRIO \([^)]*\):\n/g, '');
    expect(text.replace(/[^x]/g, '').length).toBeLessThanOrEqual(COMPACTION_INPUT_BUDGET);
    expect(included + omitted).toBe(20);
    expect(omitted).toBeGreaterThan(0);
    expect(transcript).toContain('x […]');
  });

  it('asks for the structured pt-BR sections and folds in the previous summary', () => {
    const prompt = buildCompactionPrompt('RESUMO ANTIGO', [msg('1', 'user', 'oi'), msg('2', 'assistant', 'olá')]);
    expect(prompt.startsWith(COMPACTION_PROMPT_MARKER)).toBe(true);
    for (const section of [
      'Objetivo',
      'Decisões',
      'Estado atual',
      'Arquivos e comandos',
      'Perguntas em aberto',
      'Próximos passos',
    ])
      expect(prompt).toContain(`## ${section}`);
    expect(prompt).toContain('Resumo anterior');
    expect(prompt).toContain('RESUMO ANTIGO');
    expect(prompt).toContain('Não execute ferramentas');
    expect(buildCompactionPrompt(undefined, [msg('1', 'user', 'oi')])).not.toContain('Resumo anterior');
    const three = [msg('1', 'user', 'a'), msg('2', 'user', 'b'.repeat(100)), msg('3', 'user', 'c')];
    expect(buildCompactionPrompt(undefined, three, 10)).toContain('[1 mensagens mais antigas foram omitidas');
  });

  it('cleans the answer: trims, unwraps a Markdown fence and caps the size', () => {
    expect(cleanSummary('  ```markdown\n## Objetivo\nX\n```  ')).toBe('## Objetivo\nX');
    expect(cleanSummary('   ')).toBe('');
    expect(cleanSummary('y'.repeat(SUMMARY_MAX + 10)).length).toBeLessThanOrEqual(SUMMARY_MAX + 5);
  });
});

describe('history after compaction', () => {
  it('sends the latest summary plus only the messages after it', () => {
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'user', 'd')];
    expect(runContext(messages, [])).toEqual({ summary: undefined, history: messages });
    const ctx = runContext(messages, [compaction('1', 'velho'), compaction('2', 'novo')]);
    expect(ctx.summary).toBe('novo');
    expect(ctx.history.map((m) => m.id)).toEqual(['3', '4']);
    // A boundary that no longer exists keeps the whole history rather than dropping messages.
    expect(messagesAfter(messages, compaction('gone'))).toEqual(messages);
  });

  it('puts the summary in the provider prompt outside the history budget', () => {
    const input: RunInput = {
      runId: 'r',
      sessionId: 's',
      providerId: 'codex',
      cwd: '/tmp',
      prompt: 'pedido',
      history: [msg('3', 'user', 'depois')],
      plan: { level: 'fast', reason: '', tools: false, memory: false, contextBudget: 0 },
      sandbox: 'read-only',
      summary: 'RESUMO',
    };
    const prompt = boundedPrompt(input);
    expect(prompt).toContain('[RESUMO DA CONVERSA ATÉ AQUI');
    expect(prompt).toContain('RESUMO');
    expect(prompt).not.toContain('depois'); // budget 0: no history, but the summary stays
    expect(prompt.indexOf('RESUMO')).toBeLessThan(prompt.indexOf('[PEDIDO ATUAL]'));
    expect(boundedPrompt({ ...input, summary: undefined })).not.toContain('RESUMO DA CONVERSA');
  });
});

describe('automatic threshold', () => {
  const run = (id: string, inputTokens?: number, extra: Partial<Run> = {}): Run => ({
    id,
    sessionId: 's',
    providerId: 'codex',
    status: 'completed',
    route: { level: 'fast', reason: '', tools: true, memory: false, contextBudget: 0 },
    startedAt: tick(),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...extra,
  });
  const pair = [msg('1', 'user', 'oi'), msg('2', 'assistant', 'olá')];

  it('is off by default and needs an exchange since the last summary', () => {
    expect(autoCompactReason(settings(), pair, [], [run('r', 10 ** 7)])).toBeUndefined();
    const on = settings({ autoCompact: true, autoCompactTokens: 1000 });
    expect(autoCompactReason(on, [msg('1', 'user', 'oi')], [], [run('r', 10 ** 7)])).toBeUndefined();
  });

  it('trips on the last run input tokens, ignoring compaction runs and runs before the summary', () => {
    const on = settings({ autoCompact: true, autoCompactTokens: 1000 });
    expect(autoCompactReason(on, pair, [], [run('a', 999)])).toBeUndefined();
    expect(autoCompactReason(on, pair, [], [run('a', 1001)])).toMatch(/1001 tokens de entrada \(limite 1000\)/);
    // The newest run decides: an older heavy run does not count.
    expect(autoCompactReason(on, pair, [], [run('old', 5000), run('new', 10)])).toBeUndefined();
    expect(autoCompactReason(on, pair, [], [run('a', 5000, { compaction: { auto: false } })])).toBeUndefined();
    const heavy = run('before', 5000);
    const summary = compaction('0');
    expect(autoCompactReason(on, pair, [summary], [heavy])).toBeUndefined();
    // Without a token count from the provider, history characters count (4 per token).
    const long = [msg('1', 'user', 'x'.repeat(4001)), msg('2', 'assistant', 'y')];
    expect(autoCompactReason(on, long, [], [run('a')])).toMatch(/caracteres \(limite 4000\)/);
    expect(autoCompactReason(settings({ autoCompact: true }), long, [], [])).toBeUndefined(); // default 150k
  });
});

describe('timeline', () => {
  it('folds the covered messages under each summary and keeps later ones open', () => {
    const messages = [msg('1', 'user', 'a'), msg('2', 'assistant', 'b'), msg('3', 'user', 'c'), msg('4', 'user', 'd')];
    const segments = timelineSegments(messages, [compaction('2'), compaction('3')]);
    expect(
      segments.map((s) => (s.kind === 'messages' ? s.messages.map((m) => m.id) : s.earlier.map((m) => m.id))),
    ).toEqual([['1', '2'], ['3'], ['4']]);
    expect(segments.map((s) => s.kind === 'compaction' && s.latest)).toEqual([false, true, false]);
    expect(timelineSegments(messages)).toEqual([{ kind: 'messages', messages }]);
    expect(timelineSegments([], [])).toEqual([{ kind: 'messages', messages: [] }]);
    // The card stays even when its boundary message is gone.
    expect(timelineSegments(messages, [compaction('gone')])[0]).toMatchObject({ kind: 'compaction', earlier: [] });
    const c = compaction('1');
    expect(upsertCompaction([], c, 's')).toEqual([c]);
    expect(upsertCompaction([c], { ...c, summary: 'x' }, 's')[0].summary).toBe('x');
    expect(upsertCompaction([c], { ...c, sessionId: 'other' }, 's')).toEqual([c]);
    expect(upsertCompaction(undefined, c, 's')).toEqual([c]);
  });
});

describe('reserved /compactar name', () => {
  it('cannot be taken by saved or repository commands and never expands', () => {
    expect(commandFieldsError({ name: 'compactar', description: '', template: 't' })).toBe(COMMAND_RESERVED);
    expect(builtinCommands.some((c) => c.name === 'compactar')).toBe(true);
    const store = new Store(tempDir());
    try {
      const now = new Date().toISOString();
      // Even a row written around the API does not shadow the built-in action.
      store.putCommand({
        id: 'x',
        name: 'compactar',
        description: '',
        template: 'EXPANDIDO',
        projectId: null,
        createdAt: now,
        updatedAt: now,
      });
      const winner = listCommands(store).commands.find((c) => c.name === 'compactar' && c.active);
      expect(winner?.source).toBe('builtin');
      expect(expandMessage(store, '/compactar')).toEqual({ prompt: '/compactar' });
    } finally {
      store.close();
    }
  });
});

/**
 * Provider that records every call. Compaction prompts answer `summary` (or fail when
 * `failSummary`); `[esperar]` turns stay open until `release`; others answer at once and
 * report `inputTokens` as usage.
 */
function scripted() {
  const inputs: RunInput[] = [];
  const state = { summary: '## Objetivo\nResumo de teste', failSummary: false, inputTokens: 10, emitSession: 'n1' };
  const open: ((r: RunResult) => void)[] = [];
  const approvals: string[] = [];
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
          models: [{ id: 'm', name: 'm', isDefault: true, efforts: ['low', 'high'] }],
          defaultModel: 'm',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    },
    run(input, emit, signal) {
      inputs.push(input);
      if (input.prompt.startsWith(COMPACTION_PROMPT_MARKER)) {
        if (state.failSummary) return Promise.reject(new Error('modelo indisponível'));
        emit({
          type: 'approval',
          approval: {
            id: `a-${input.runId}`,
            runId: input.runId,
            sessionId: input.sessionId,
            title: 'x',
            detail: '',
            kind: 'command',
            status: 'pending',
          },
        });
        emit({ type: 'delta', text: state.summary });
        emit({ type: 'usage', inputTokens: 77, outputTokens: 7 });
        return Promise.resolve({ text: state.summary, stopReason: 'completed' });
      }
      if (input.prompt.includes('[esperar]'))
        return new Promise<RunResult>((resolve) => {
          open.push(resolve);
          signal.addEventListener('abort', () => resolve({ text: '', stopReason: 'cancelled' }), { once: true });
        });
      if (state.emitSession) emit({ type: 'session', nativeSessionId: state.emitSession });
      emit({ type: 'delta', text: 'resposta' });
      emit({ type: 'usage', inputTokens: state.inputTokens, outputTokens: 1 });
      return Promise.resolve({ text: 'resposta', stopReason: 'completed' });
    },
    async approve(id) {
      approvals.push(id);
    },
    async shutdown() {},
  };
  return {
    providers,
    inputs,
    state,
    approvals,
    release() {
      open.shift()?.({ text: 'ok', stopReason: 'completed' });
    },
  };
}

async function setup(over: Partial<Settings> = {}) {
  const store = new Store(tempDir());
  // Direct runs (orchestration off) so each turn is one provider call.
  const now = new Date().toISOString();
  store.putProject({
    id: 'p',
    name: 'P',
    path: tempDir('adelic-compact-project-'),
    createdAt: now,
    memoryWorkspace: 'w',
    memoryProject: 'p',
    orchestration: { enabled: false, maxWorkers: 1, review: false },
  });
  store.setSettings({ ...store.getSettings()!, autoRetry: false, ...over });
  const session: Session = {
    id: 's',
    projectId: 'p',
    title: 'Nova conversa',
    providerId: 'codex',
    mode: 'auto',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const provider = scripted();
  const { app, orchestrator } = createBackend(store, provider.providers, undefined, undefined, { retries: 0 });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    await orchestrator.shutdown();
    await new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r())));
    store.close();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in assertions
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  const events: StreamEvent[] = [];
  orchestrator.subscribe((e) => events.push(e));
  const idle = async () => {
    for (let i = 0; i < 400 && (orchestrator.isActive('s') || store.getSession('s')!.activeRunId); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(orchestrator.isActive('s')).toBe(false);
  };
  const send = async (content: string) => {
    const started = await orchestrator.start(store.getSession('s')!, content);
    await idle();
    return started;
  };
  return { store, orchestrator, provider, call, events, idle, send };
}

describe('manual compaction', () => {
  it('summarises read-only, stores the card, clears the native session and seeds the next run', async () => {
    const t = await setup({ sandbox: 'workspace-write' });
    await t.send('primeira pergunta');
    await t.send('segunda pergunta');
    expect(t.store.getSession('s')!.nativeSessionId).toBe('n1');
    const before = t.store.listMessages('s');

    const accepted = await t.call('POST', '/api/sessions/s/compact', {});
    expect(accepted.status).toBe(202);
    await t.idle();
    const call = t.provider.inputs.at(-1)!;
    expect(call.prompt.startsWith(COMPACTION_PROMPT_MARKER)).toBe(true);
    expect(call.prompt).toContain('segunda pergunta');
    expect(call).toMatchObject({ sandbox: 'read-only', history: [], plan: { tools: false, level: 'fast' } });
    expect(call.nativeSessionId).toBeUndefined();
    // Tools are off; an approval request is refused without the user.
    expect(t.provider.approvals).toEqual([`a-${call.runId}`]);

    const run = t.store.getRun(accepted.body.runId)!;
    expect(run).toMatchObject({ status: 'completed', compaction: { auto: false }, inputTokens: 77 });
    // No message for the compaction: no user bubble, no assistant answer.
    expect(t.store.listMessages('s')).toEqual(before);
    const [stored] = t.store.listCompactions('s');
    expect(stored).toMatchObject({
      sessionId: 's',
      runId: run.id,
      summary: '## Objetivo\nResumo de teste',
      upToMessageId: before.at(-1)!.id,
    });
    expect(t.store.getSession('s')!.nativeSessionId).toBeUndefined();
    expect(t.events.some((e) => e.type === 'compaction')).toBe(true);
    expect(t.store.listEvents('s').map((e) => e.text)).toEqual(
      expect.arrayContaining([COMPACTING_TEXT, 'Conversa compactada']),
    );
    expect((await t.call('GET', '/api/sessions/s/compactions')).body.compactions).toEqual([stored]);
    expect((await t.call('GET', '/api/sessions/s')).body.compactions).toEqual([stored]);

    t.provider.state.emitSession = '';
    await t.send('terceira pergunta');
    const next = t.provider.inputs.at(-1)!;
    expect(next.summary).toBe(stored.summary);
    expect(next.nativeSessionId).toBeUndefined();
    // History holds the messages after the summary; the new message itself is the prompt.
    expect(next.history).toEqual([]);
    expect(next.prompt).toContain('terceira pergunta');
    expect(boundedPrompt(next)).toContain('Resumo de teste');
    expect(boundedPrompt(next)).not.toContain('primeira pergunta');
  });

  it('editing a message the summary covers drops that summary from later runs', async () => {
    const t = await setup();
    await t.send('primeira pergunta');
    await t.send('segunda pergunta');
    await t.call('POST', '/api/sessions/s/compact', {});
    await t.idle();
    expect(t.store.listCompactions('s')).toHaveLength(1);
    const first = t.store.listMessages('s').find((m) => m.content === 'primeira pergunta')!;
    await t.orchestrator.editAndResend('s', first.id, 'pergunta editada', undefined);
    await t.idle();
    const edited = t.provider.inputs.at(-1)!;
    expect(edited.prompt).toContain('pergunta editada');
    expect(edited.summary).toBeUndefined();
    expect(edited.history).toEqual([]);
  });

  it('includes the previous summary in the next one and the latest wins', async () => {
    const t = await setup();
    await t.send('um');
    await t.call('POST', '/api/sessions/s/compact', {});
    await t.idle();
    // Nothing new since the summary: nothing to compact.
    const empty = await t.call('POST', '/api/sessions/s/compact', {});
    expect(empty).toMatchObject({ status: 409, body: { error: 'Não há mensagens novas para compactar' } });
    await t.send('dois');
    t.provider.state.summary = 'SEGUNDO';
    await t.call('POST', '/api/sessions/s/compact', {});
    await t.idle();
    const second = t.provider.inputs.at(-1)!.prompt;
    expect(second).toContain('Resumo anterior');
    expect(second).toContain('Resumo de teste');
    expect(second).toContain('dois');
    expect(second).not.toMatch(/USUÁRIO[^\n]*\n um/);
    expect(t.store.listCompactions('s').map((c) => c.summary)).toEqual(['## Objetivo\nResumo de teste', 'SEGUNDO']);
    await t.send('três');
    await t.send('quatro');
    const last = t.provider.inputs.at(-1)!;
    expect(last.summary).toBe('SEGUNDO');
    expect(last.history.map((m) => m.content)).toEqual(['três', 'resposta']);
  });

  it('`/compactar` alone compacts without a user message and is never expanded by saved commands', async () => {
    const t = await setup();
    await t.send('olá');
    const count = t.store.listMessages('s').length;
    const started = await t.orchestrator.start(t.store.getSession('s')!, '/compactar');
    expect(started.messageId).toBe('');
    await t.idle();
    expect(t.store.listMessages('s')).toHaveLength(count);
    expect(t.store.listCompactions('s')).toHaveLength(1);
    expect(t.provider.inputs.at(-1)!.prompt.startsWith(COMPACTION_PROMPT_MARKER)).toBe(true);
    // Through the messages route too, and with text after it: 400.
    await t.send('mais');
    expect((await t.call('POST', '/api/sessions/s/messages', { content: '/compactar' })).status).toBe(202);
    await t.idle();
    expect(t.store.listCompactions('s')).toHaveLength(2);
    expect(await t.call('POST', '/api/sessions/s/messages', { content: '/compactar já' })).toMatchObject({
      status: 400,
      body: { error: COMPACT_INVALID },
    });
    // Saved commands cannot use the name.
    expect(await t.call('POST', '/api/commands', { name: 'compactar', template: 'x' })).toMatchObject({
      status: 400,
      body: { error: COMMAND_RESERVED },
    });
    const created = await t.call('POST', '/api/commands', { name: 'resumir', template: 'x' });
    expect((await t.call('PATCH', `/api/commands/${created.body.id}`, { name: 'compactar' })).status).toBe(400);
  });

  it('answers 409 while a run or a plan is active, 404 for unknown conversations, 400 for options', async () => {
    const t = await setup();
    await t.send('olá');
    await t.orchestrator.start(t.store.getSession('s')!, '[esperar] longo');
    expect((await t.call('POST', '/api/sessions/s/compact', {})).status).toBe(409);
    t.provider.release();
    await t.idle();
    expect((await t.call('POST', '/api/sessions/nope/compact', {})).status).toBe(404);
    expect((await t.call('GET', '/api/sessions/nope/compactions')).status).toBe(404);
    expect((await t.call('POST', '/api/sessions/s/compact', { force: true })).status).toBe(400);
    const now = new Date().toISOString();
    t.store.putPlan({
      id: 'pl',
      sessionId: 's',
      runId: 'x',
      title: 'P',
      status: 'executing',
      requirements: '',
      design: '',
      tasks: [],
      markdown: '',
      createdAt: now,
      updatedAt: now,
    });
    expect(await t.call('POST', '/api/sessions/s/compact', {})).toMatchObject({
      status: 409,
      body: { error: 'Um plano está em execução nesta conversa' },
    });
  });

  it('a failed summary keeps everything as it was and shows the error', async () => {
    const t = await setup();
    await t.send('olá');
    const native = t.store.getSession('s')!.nativeSessionId;
    t.provider.state.failSummary = true;
    const { body } = await t.call('POST', '/api/sessions/s/compact', {});
    await t.idle();
    expect(t.store.getRun(body.runId)).toMatchObject({ status: 'failed', error: 'modelo indisponível' });
    expect(t.store.listCompactions('s')).toEqual([]);
    expect(t.store.getSession('s')!.nativeSessionId).toBe(native);
    expect(
      t.store.listEvents('s').some((e) => e.type === 'error' && e.text.includes('Não foi possível compactar')),
    ).toBe(true);
  });

  it('a queued /compactar cannot steer a turn', async () => {
    const t = await setup();
    await t.orchestrator.start(t.store.getSession('s')!, '[esperar] longo');
    const { item } = await t.orchestrator.enqueue('s', '/compactar');
    await expect(t.orchestrator.steerQueued('s', item!.id)).rejects.toMatchObject({ status: 409 });
    t.provider.release();
    await t.idle();
  });
});

describe('automatic compaction', () => {
  it('never runs while the setting is off, whatever the size', async () => {
    const t = await setup();
    t.provider.state.inputTokens = 10 ** 7;
    await t.send('um');
    await t.send('dois');
    expect(t.provider.inputs.filter((i) => i.prompt.startsWith(COMPACTION_PROMPT_MARKER))).toEqual([]);
    expect(t.store.listCompactions('s')).toEqual([]);
  });

  it('compacts before the next message once the last run passed the threshold', async () => {
    const t = await setup({ autoCompact: true, autoCompactTokens: 1000 });
    await t.send('um');
    expect(t.provider.inputs).toHaveLength(1); // below the threshold: one call
    t.provider.state.inputTokens = 5000;
    await t.send('dois');
    expect(t.provider.inputs).toHaveLength(2);
    t.provider.state.inputTokens = 10;
    const { runId } = await t.send('três');
    const [summaryCall, messageCall] = t.provider.inputs.slice(-2);
    expect(summaryCall.prompt.startsWith(COMPACTION_PROMPT_MARKER)).toBe(true);
    expect(summaryCall.prompt).toContain('dois');
    expect(summaryCall.prompt).not.toContain('três'); // the new message is not summarised
    expect(messageCall.summary).toBe('## Objetivo\nResumo de teste');
    expect(messageCall.history).toEqual([]); // everything before "três" is in the summary
    expect(messageCall.prompt).toContain('três');
    expect(messageCall.nativeSessionId).toBeUndefined();
    const [stored] = t.store.listCompactions('s');
    expect(stored).toMatchObject({ runId, auto: true });
    // The boundary is the last message before the new turn.
    const messages = t.store.listMessages('s');
    expect(stored.upToMessageId).toBe(messages[3].id);
    const texts = t.store
      .listEvents('s')
      .filter((e) => e.runId === runId)
      .map((e) => e.text);
    expect(texts[0]).toBe(COMPACTING_TEXT);
    expect(texts[1]).toMatch(/Conversa compactada antes desta mensagem: a última execução usou 5000 tokens/);
    // Right after a summary the threshold resets: the next message does not compact again.
    await t.send('quatro');
    expect(t.provider.inputs.filter((i) => i.prompt.startsWith(COMPACTION_PROMPT_MARKER))).toHaveLength(1);
  });

  it('if the summary fails, the message still runs with the full history and the failure is noted', async () => {
    const t = await setup({ autoCompact: true, autoCompactTokens: 1000 });
    t.provider.state.inputTokens = 5000;
    await t.send('um');
    t.provider.state.failSummary = true;
    const { runId } = await t.send('dois');
    const last = t.provider.inputs.at(-1)!;
    expect(last.prompt.startsWith(COMPACTION_PROMPT_MARKER)).toBe(false);
    expect(last.summary).toBeUndefined();
    expect(last.history.map((m) => m.content)).toEqual(['um', 'resposta']);
    expect(last.nativeSessionId).toBe('n1');
    expect(t.store.getRun(runId)!.status).toBe('completed');
    expect(t.store.listCompactions('s')).toEqual([]);
    expect(
      t.store
        .listEvents('s')
        .some((e) => e.runId === runId && e.type === 'error' && e.text.includes('a mensagem seguiu sem compactar')),
    ).toBe(true);
  });

  it('validates the settings', async () => {
    const t = await setup();
    expect((await t.call('PATCH', '/api/settings', { autoCompact: 'sim' })).status).toBe(400);
    expect((await t.call('PATCH', '/api/settings', { autoCompactTokens: 10 })).status).toBe(400);
    expect((await t.call('PATCH', '/api/settings', { autoCompactTokens: 1.5 })).status).toBe(400);
    const ok = await t.call('PATCH', '/api/settings', { autoCompact: true, autoCompactTokens: 200_000 });
    expect(ok.body).toMatchObject({ autoCompact: true, autoCompactTokens: 200_000 });
  });
});

describe('migration 8', () => {
  it('upgrades a version 6 database and cascades compactions with the conversation', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 6),
    );
    expect(userVersion(db)).toBe(6);
    db.exec(`INSERT INTO sessions VALUES('s',NULL,'{}'); INSERT INTO plans VALUES('p','s','{}');`);
    const result = migrate(db, dir);
    expect(result).toMatchObject({ from: 6, to: 14, applied: [8, 9, 10, 11, 12, 13, 14] });
    expect(result.backupPath).toBeTruthy();
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 1 });
    db.exec(`PRAGMA foreign_keys=ON; INSERT INTO compactions VALUES('c','s','{}');`);
    expect(() => db.exec(`INSERT INTO compactions VALUES('x','missing','{}')`)).toThrow();
    db.exec('DELETE FROM sessions;');
    expect(db.prepare('SELECT COUNT(*) AS n FROM compactions').get()).toEqual({ n: 0 });
    db.close();
  });
});
