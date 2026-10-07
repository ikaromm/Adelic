import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRegistry, RunEvent, Session } from '../shared/contracts.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import * as serverAreas from '../server/i18n/messages/index.js';
import { LocalizedError, errorKey, httpError, isServerKey, localize, serverCatalogs, tr } from '../server/i18n.js';
import { error, errorText, failure, message } from '../server/http/common.js';
import { CheckpointError } from '../server/checkpoints.js';
import { decodeUpload } from '../server/attachments.js';
import { NO_TASKS } from '../server/plans.js';
import {
  ApprovalDecisionSchema,
  GitStageSchema,
  HOOKS_MESSAGES,
  PatchSessionSchema,
  RemoteAccountSchema,
  SendMessageSchema,
  SettingsPatchSchema,
  TerminalRunSchema,
  AUTOMATION_MESSAGES,
  CreateAutomationSchema,
  parseBody,
  vmsg,
} from '../shared/schemas.js';
import { COMMAND_MESSAGES, COMMAND_RESERVED } from '../shared/commands.js';
import { MCP_MESSAGES, MCP_MESSAGE_KEYS } from '../shared/mcp.js';
import validation, { validationText } from '../shared/validation-messages.js';
import events, { checkHeadlineKey, eventFields, eventText as sharedEventText } from '../shared/event-text.js';
import { checkHeadline } from '../shared/hooks.js';
import { COMPACTING_TEXT, COMPACT_INVALID } from '../shared/compaction.js';
import { AUTOMATION_GLOBAL_OFF } from '../shared/automations.js';
import { VOICE_BUSY, VOICE_DISABLED, VOICE_REMOTE_REFUSAL, VOICE_TOO_LARGE } from '../shared/voice.js';
import { limitReachedMessage } from '../shared/spend-limits.js';
import { spendLimitError } from '../server/usage.js';
import { checkEngine } from '../server/voice.js';
import { eventText } from '../src/i18n/eventText';
import { TERMINAL_INTERNET_DISABLED, TERMINAL_REMOTE_DISABLED } from '../server/http/terminal.js';
import type { Response } from 'express';

type Catalog = { 'pt-BR': Record<string, string>; en: Record<string, string> };
const PLACEHOLDER = /\{(\w+)\}/g;
const placeholders = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();

// ---- Catalogs ----------------------------------------------------------------------------

const EXPECTED_AREAS = [
  'attachments',
  'automations',
  'checkpoints',
  'commands',
  'compaction',
  'diagnostics',
  'git',
  'graphify',
  'handoff',
  'mcp',
  'memory',
  'orchestrator',
  'plans',
  'projects',
  'sessions',
  'settings',
  'spend',
  'terminal',
  'update',
  'validation',
  'voice',
  'worktrees',
];

describe('server catalog areas', () => {
  const areas = Object.entries(serverAreas as unknown as Record<string, Catalog>);

  it('registers every area converted for the server, in alphabetical order', () => {
    const names = areas.map(([name]) => name);
    for (const area of EXPECTED_AREAS) expect(names, area).toContain(area);
    expect([...names].sort()).toEqual(names);
  });

  it.each(areas)('area %s: identical pt-BR/en keys, placeholders and namespace', (area, catalog) => {
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog['pt-BR']).sort());
    for (const [key, pt] of Object.entries(catalog['pt-BR'])) {
      expect(key.startsWith(`${area}.`), key).toBe(true);
      expect(pt.trim(), key).not.toBe('');
      expect(catalog.en[key].trim(), key).not.toBe('');
      expect(placeholders(catalog.en[key]), key).toEqual(placeholders(pt));
    }
  });

  it('the event catalog (shared/event-text.ts) has identical keys and placeholders', () => {
    const catalog = events as Catalog;
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog['pt-BR']).sort());
    for (const [key, pt] of Object.entries(catalog['pt-BR'])) {
      expect(key.startsWith('event.'), key).toBe(true);
      expect(placeholders(catalog.en[key]), key).toEqual(placeholders(pt));
    }
  });

  it('English differs from pt-BR for sentences (catches untranslated copies)', () => {
    const same = Object.keys(serverCatalogs['pt-BR']).filter(
      (key) =>
        serverCatalogs['pt-BR'][key] === serverCatalogs.en[key] &&
        /[a-zà-ú]{4,} [a-zà-ú]{3,}/i.test(serverCatalogs['pt-BR'][key]),
    );
    expect(same).toEqual([]);
  });

  it('recognises plural bases as keys', () => {
    expect(isServerKey('checkpoints.conflicts')).toBe(true);
    expect(isServerKey('checkpoints.conflicts.one')).toBe(true);
    expect(isServerKey('checkpoints.conflictz')).toBe(false);
    expect(tr('en', 'checkpoints.conflicts', { count: 1 })).toBe(
      'One file was changed after this run; nothing was undone.',
    );
    expect(tr('pt-BR', 'checkpoints.conflicts', { count: 3 })).toBe(
      '3 arquivos foram alterados depois desta execução; nada foi desfeito.',
    );
  });
});

// ---- pt-BR stays byte-identical ---------------------------------------------------------

describe('pt-BR texts are unchanged', () => {
  it('keeps the historical constants', () => {
    expect(NO_TASKS).toBe('Não encontrei tarefas; edite o plano');
    expect(COMMAND_RESERVED).toBe('Nome reservado para uma ação embutida do Adelic');
    expect(COMMAND_MESSAGES.mode).toBe('mode deve ser fast, balanced ou deep');
    expect(COMMAND_MESSAGES.template).toBe('Modelo obrigatório (até 8000 caracteres)');
    expect(MCP_MESSAGES.projectLimit).toBe('Até 20 servidores MCP por projeto, sem repetição');
    expect(MCP_MESSAGES.notFound).toBe('Servidor MCP não encontrado');
    expect(AUTOMATION_MESSAGES.projectId).toBe('projectId obrigatório: automações rodam sempre num projeto');
    expect(HOOKS_MESSAGES.autoFix).toBe('autoFix deve ser booleano');
    expect(TERMINAL_REMOTE_DISABLED).toContain('Ative "Permitir terminal pelo acesso remoto" em Configurações');
    expect(TERMINAL_INTERNET_DISABLED).toContain('Tailscale Funnel');
    // Shared constants that now also live in catalogs keep the same text there.
    expect(tr('pt-BR', 'compaction.invalid')).toBe(COMPACT_INVALID);
    expect(tr('pt-BR', 'automations.globalOff')).toBe(AUTOMATION_GLOBAL_OFF);
    expect(tr('pt-BR', 'voice.busy')).toBe(VOICE_BUSY);
    expect(tr('pt-BR', 'voice.tooLarge')).toBe(VOICE_TOO_LARGE);
    expect(tr('pt-BR', 'voice.disabled')).toBe(VOICE_DISABLED);
    expect(tr('pt-BR', 'voice.remoteRefusal')).toBe(VOICE_REMOTE_REFUSAL);
    expect(sharedEventText('event.compacting')).toBe(COMPACTING_TEXT);
  });

  it('LocalizedError and localize() keep pt-BR in .message and translate per request', () => {
    const e = httpError(409, 'orchestrator.runInProgress');
    expect(e.message).toBe('Há uma execução em andamento nesta conversa; aguarde ou cancele antes');
    expect(e.status).toBe(409);
    expect(message(e)).toBe(e.message);
    expect(message(e, 'en')).toBe('A run is in progress in this conversation; wait or cancel it first');
    const c = localize(new CheckpointError('', 410), 'checkpoints.repoGone');
    expect([c.message, c.status, errorKey(c)?.key]).toEqual([
      'O repositório do checkpoint não existe mais',
      410,
      'checkpoints.repoGone',
    ]);
    expect(CheckpointError.of('checkpoints.invalidPath', { path: 'a/b' }, 422).message).toBe(
      'Caminho inválido no checkpoint: a/b',
    );
    // Plain errors pass through in any locale.
    expect(message(new Error('git: fatal'), 'en')).toBe('git: fatal');
    expect(errorKey(new Error('x'))).toBeUndefined();
  });
});

// ---- zod validation messages ------------------------------------------------------------

describe('validation messages (parseBody with a locale)', () => {
  it('keeps the pt-BR message by default and translates with a locale', () => {
    const bad = { content: '' };
    expect(parseBody(SendMessageSchema, bad, 'x')).toEqual({
      ok: false,
      message: 'content obrigatório (máximo 32000 caracteres)',
    });
    expect(parseBody(SendMessageSchema, bad, 'x', 'en')).toEqual({
      ok: false,
      message: 'content is required (at most 32000 characters)',
    });
    expect(parseBody(PatchSessionSchema, { planFirst: 'yes' }, 'x', 'en')).toMatchObject({
      message: 'planFirst must be a boolean',
    });
    expect(parseBody(PatchSessionSchema, { mode: 'turbo' }, 'x')).toMatchObject({ message: 'mode inválido' });
    expect(parseBody(PatchSessionSchema, { mode: 'turbo' }, 'x', 'en')).toMatchObject({ message: 'Invalid mode' });
    expect(parseBody(ApprovalDecisionSchema, { decision: 'maybe' }, 'x', 'en')).toMatchObject({
      message: 'decision must be approve or deny',
    });
    expect(parseBody(SettingsPatchSchema, { language: 'fr' }, 'x')).toMatchObject({
      message: 'language deve ser auto, pt-BR ou en',
    });
    expect(parseBody(SettingsPatchSchema, { autoCompactTokens: 1 }, 'x', 'en')).toMatchObject({
      message: 'autoCompactTokens must be an integer between 1000 and 2000000',
    });
    expect(parseBody(TerminalRunSchema, { command: '' }, 'x', 'en')).toMatchObject({
      message: 'command is required (at most 8000 characters)',
    });
    expect(parseBody(RemoteAccountSchema, { username: 'A', password: 'x' }, 'x', 'en')).toMatchObject({
      message: 'username: 3 to 64 characters, only lowercase letters, digits, dot, hyphen and underscore',
    });
    expect(parseBody(CreateAutomationSchema, {}, 'x', 'en')).toMatchObject({
      message: 'Name is required (up to 80 characters)',
    });
    // zod's own refine (GitStageSchema) carries the key too.
    expect(parseBody(GitStageSchema, {}, 'x')).toMatchObject({ message: 'Informe paths ou all: true' });
    expect(parseBody(GitStageSchema, {}, 'x', 'en')).toMatchObject({ message: 'Provide paths or all: true' });
  });

  it('translates fallbacks that are validation keys or vmsg() and returns other fallbacks as is', () => {
    expect(parseBody(ApprovalDecisionSchema, 'not an object', 'validation.projectFields', 'en')).toMatchObject({
      message: 'Invalid project fields',
    });
    const fallback = vmsg('validation.requiredField', { field: 'messageId' });
    expect(fallback.text).toBe('messageId obrigatório');
    expect(parseBody(ApprovalDecisionSchema, 'nope', fallback)).toMatchObject({ message: 'messageId obrigatório' });
    expect(parseBody(ApprovalDecisionSchema, 'nope', fallback, 'en')).toMatchObject({
      message: 'messageId is required',
    });
    // A server key goes through untouched: error() translates it.
    expect(parseBody(ApprovalDecisionSchema, 'nope', 'sessions.invalid', 'en')).toMatchObject({
      message: 'sessions.invalid',
    });
    expect(parseBody(ApprovalDecisionSchema, 'nope', 'Texto livre')).toMatchObject({ message: 'Texto livre' });
  });

  it('every validation key is a valid template in both languages', () => {
    for (const key of Object.keys(validation['pt-BR']) as (keyof (typeof validation)['pt-BR'])[]) {
      expect(validationText(key).length, key).toBeGreaterThan(0);
      expect(validationText(key, undefined, 'en').length, key).toBeGreaterThan(0);
    }
    expect(MCP_MESSAGE_KEYS.args.text).toBe('Até 20 argumentos, cada um com até 500 caracteres');
  });
});

// ---- Run activity events ----------------------------------------------------------------

describe('run activity event keys', () => {
  it('eventFields() writes the pt-BR text plus the key; the UI helper translates it', () => {
    const fields = eventFields('event.commandExpandedMode', {
      name: 'revisar',
      source: { key: 'event.commandSource.repo' },
      mode: { key: 'event.mode.deep' },
    });
    expect(fields.text).toBe('Comando /revisar (do repositório) expandido; modo Completo nesta execução');
    const event = { ...fields } as Pick<RunEvent, 'text' | 'textKey' | 'textVars'>;
    expect(eventText(event, 'en')).toBe('Command /revisar (from the repository) expanded; Thorough mode for this run');
    expect(eventText(event, 'pt-BR')).toBe(fields.text);
    const plural = eventFields('event.mentionIncluded', { count: 2, paths: 'a.ts, b.ts' });
    expect(plural.text).toBe('Arquivos mencionados incluídos: a.ts, b.ts');
    expect(eventText(plural, 'en')).toBe('Mentioned files included: a.ts, b.ts');
  });

  it('falls back to the stored text for old events, unknown keys and bad vars', () => {
    expect(eventText({ text: 'Evento antigo' }, 'en')).toBe('Evento antigo');
    expect(eventText({ text: 'x', textKey: 'event.nope' }, 'en')).toBe('x');
    expect(eventText({ text: 'x', textKey: 'event.compactFailed', textVars: { error: { key: 'nope' } } }, 'en')).toBe(
      'x',
    );
  });

  it('check headlines match checkHeadline() in pt-BR for every status', () => {
    const base = { name: 'testes', durationMs: 12_000 };
    const results = [
      { ...base, status: 'running' },
      { ...base, status: 'passed' },
      { ...base, status: 'failed', exitCode: 1 },
      { ...base, status: 'timeout' },
      { ...base, status: 'cancelled' },
      { ...base, status: 'cancelled', detail: 'alterações desfeitas' },
      { ...base, status: 'error' },
      { ...base, status: 'error', detail: 'bwrap ausente' },
    ] as Parameters<typeof checkHeadline>[0][];
    for (const result of results) {
      const { key, vars } = checkHeadlineKey(result);
      expect(sharedEventText(key, vars), result.status).toBe(checkHeadline(result));
    }
    const { key, vars } = checkHeadlineKey({ ...base, status: 'passed' });
    expect(sharedEventText(key, vars, 'en')).toBe('Check: testes passed (12 s)');
  });
});

// ---- Helpers outside routes -------------------------------------------------------------

describe('service errors with keys', () => {
  it('upload checks keep pt-BR and expose their key', () => {
    const empty = decodeUpload('a.txt', 'text/plain', '');
    expect(empty).toMatchObject({ ok: false, message: '“a.txt” está vazio.', key: 'attachments.empty' });
    if (!empty.ok) expect(tr('en', empty.key, empty.vars)).toBe('“a.txt” is empty.');
  });

  it('voice engine refusals keep their shape and pt-BR text', () => {
    expect(checkEngine({ engine: 'soniox' })).toEqual({ ok: false, reason: VOICE_REMOTE_REFUSAL });
    expect(checkEngine({ engine: 'mystery' })).toMatchObject({
      ok: false,
      reason: 'Ditado indisponível: motor do voxtype não reconhecido (mystery)',
      why: { key: 'voice.engineUnknown' },
    });
  });

  it('a spend limit refusal keeps limitReachedMessage() and translates per request', () => {
    const reached = {
      kind: 'daily-tokens' as const,
      label: 'tokens hoje',
      used: 10,
      limit: 5,
      percent: 200,
      usedText: '10',
      limitText: '5',
    };
    const e = spendLimitError({ reached: [reached] } as unknown as Parameters<typeof spendLimitError>[0]);
    expect(e.message).toBe(limitReachedMessage(reached));
    expect(message(e, 'pt-BR')).toBe(limitReachedMessage(reached));
    expect(message(e, 'en')).toBe(
      "Usage limit reached: tokens today (10/5). Adjust it in Settings or use 'Continue anyway'.",
    );
  });

  it('errorText() and error() translate thrown errors by the request locale', () => {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      req: { locale: 'en' },
      status(code: number) {
        sent.status = code;
        return this;
      },
      json(body: unknown) {
        sent.body = body;
        return this;
      },
    } as unknown as Response;
    expect(errorText(res, new LocalizedError('plans.notFound'))).toBe('Plan not found');
    error(res, 404, new LocalizedError('plans.exists', { path: 'a.md' }));
    expect(sent).toEqual({ status: 404, body: { error: 'a.md already exists' } });
    error(res, 500, new Error('raw'));
    expect(sent.body).toEqual({ error: 'raw' });
    failure(res, httpError(409, 'orchestrator.alreadyActive'));
    expect(sent).toEqual({ status: 409, body: { error: 'There is already an active run in this conversation' } });
  });
});

// ---- Routes over HTTP -------------------------------------------------------------------

const servers: Server[] = [];
const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-i18n-server-'));
  dirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  const providers: ProviderRegistry = {
    async list() {
      return [
        {
          id: 'codex',
          name: 'stub',
          installed: true,
          available: true,
          status: 'ready' as const,
          detail: 'test',
          models: [{ id: 'm1', name: 'm1', isDefault: true }],
          defaultModel: 'm1',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    },
    async run() {
      return { text: 'ok', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init: RequestInit & { lang?: string } = {}) => {
    const { lang, ...rest } = init;
    const response = await fetch(`${base}${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        origin: base,
        ...(lang ? { 'accept-language': lang } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as { error?: string } };
  };
  return { store, orchestrator, call, base };
}

describe('routes answer in the request language', () => {
  it('not-found answers: English with Accept-Language: en, the same pt-BR as before without it', async () => {
    const { call } = await setup();
    const cases: [string, RequestInit, string, string][] = [
      ['/api/sessions/nope', {}, 'Conversa não encontrada', 'Conversation not found'],
      ['/api/runs/nope/changes', {}, 'Execução não encontrada', 'Run not found'],
      ['/api/tasks/nope', {}, 'Tarefa não encontrada', 'Task not found'],
      ['/api/projects/nope/hooks', {}, 'Projeto não encontrado', 'Project not found'],
      ['/api/automations/nope', { method: 'DELETE', body: '{}' }, 'Automação não encontrada', 'Automation not found'],
      ['/api/commands/nope', { method: 'DELETE', body: '{}' }, 'Comando não encontrado', 'Command not found'],
      [
        '/api/mcp-servers/nope',
        { method: 'DELETE', body: '{}' },
        'Servidor MCP não encontrado',
        'MCP server not found',
      ],
      ['/api/skills/nope', { method: 'PATCH', body: '{}' }, 'Skill não encontrada', 'Skill not found'],
      ['/api/projects/nope/git/status', {}, 'Projeto não encontrado', 'Project not found'],
      ['/api/projects/nope/terminal', {}, 'Projeto não encontrado', 'Project not found'],
      ['/api/projects/nope/graphify', {}, 'Projeto não encontrado', 'Project not found'],
      ['/api/plans/nope/stop', { method: 'POST', body: '{}' }, 'Plano não encontrado', 'Plan not found'],
      [
        '/api/approvals/nope',
        { method: 'POST', body: '{"decision":"approve"}' },
        'Aprovação não encontrada',
        'Approval not found',
      ],
    ];
    for (const [path, init, pt, en] of cases) {
      expect((await call(path, init)).body.error, path).toBe(pt);
      expect((await call(path, { ...init, lang: 'pt-BR' })).body.error, path).toBe(pt);
      expect((await call(path, { ...init, lang: 'en-US,en;q=0.9' })).body.error, path).toBe(en);
    }
  });

  it('zod messages and route checks follow the locale', async () => {
    const { call } = await setup();
    const created = await call('/api/sessions', { method: 'POST', body: '{}' });
    const session = created.body as unknown as Session;
    const send = (lang?: string) =>
      call(`/api/sessions/${session.id}/messages`, { method: 'POST', body: '{"content":""}', lang });
    expect((await send()).body.error).toBe('content obrigatório (máximo 32000 caracteres)');
    expect((await send('en')).body.error).toBe('content is required (at most 32000 characters)');
    const patch = (lang?: string) =>
      call(`/api/sessions/${session.id}`, { method: 'PATCH', body: '{"planFirst":1}', lang });
    expect((await patch()).body.error).toBe('planFirst deve ser booleano');
    expect((await patch('en')).body.error).toBe('planFirst must be a boolean');
    const settings = (lang?: string) => call('/api/settings', { method: 'PATCH', body: '{"language":"fr"}', lang });
    expect((await settings()).body.error).toBe('language deve ser auto, pt-BR ou en');
    expect((await settings('en')).body.error).toBe('language must be auto, pt-BR or en');
    const search = (lang?: string) => call('/api/search', { lang });
    expect((await search()).body.error).toBe('q obrigatório (até 160 caracteres)');
    expect((await search('en')).body.error).toBe('q is required (up to 160 characters)');
    const project = (lang?: string) =>
      call('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'x', path: '/definitely/not/here', memoryWorkspace: 'w', memoryProject: 'p' }),
        lang,
      });
    expect((await project()).body.error).toMatch(/ENOENT|O caminho precisa ser uma pasta existente/);
    const command = (lang?: string) =>
      call('/api/commands', { method: 'POST', body: '{"name":"compactar","template":"t"}', lang });
    expect((await command()).body.error).toBe(COMMAND_RESERVED);
    expect((await command('en')).body.error).toBe('Name reserved for a built-in Adelic action');
    const ids = (lang?: string) => call('/api/projects/nope/mcp', { method: 'PUT', body: '{}', lang });
    expect((await ids('en')).body.error).toBe('Project not found');
  });

  it('orchestrator refusals (LocalizedError) are translated: 409 "Há uma execução em andamento…"', async () => {
    const { store, call } = await setup();
    const created = await call('/api/sessions', { method: 'POST', body: '{}' });
    const session = created.body as unknown as Session;
    store.putSession({ ...store.getSession(session.id)!, activeRunId: 'busy-run' });
    const compact = (lang?: string) =>
      call(`/api/sessions/${session.id}/compact`, { method: 'POST', body: '{}', lang });
    const pt = await compact();
    expect(pt).toEqual({
      status: 409,
      body: { error: 'Há uma execução em andamento nesta conversa; aguarde ou cancele antes' },
    });
    const en = await compact('en');
    expect(en).toEqual({
      status: 409,
      body: { error: 'A run is in progress in this conversation; wait or cancel it first' },
    });
    const patch = await call(`/api/sessions/${session.id}`, { method: 'PATCH', body: '{}', lang: 'en' });
    expect(patch).toEqual({ status: 409, body: { error: 'A running conversation cannot be changed' } });
    const del = await call(`/api/sessions/${session.id}`, { method: 'DELETE', body: '{}', lang: 'en' });
    expect(del.body.error).toBe('Conversation is running');
    const plans = await call(`/api/sessions/${session.id}/messages/nope/edit`, {
      method: 'POST',
      body: '{"content":"x"}',
      lang: 'en',
    });
    expect(plans).toEqual({ status: 404, body: { error: 'Message not found in this conversation' } });
  });

  it('the export headings follow the locale; the messages do not', async () => {
    const { store, call, base } = await setup();
    const created = await call('/api/sessions', { method: 'POST', body: '{}' });
    const session = created.body as unknown as Session;
    const now = new Date().toISOString();
    store.addMessage({ id: 'm1', sessionId: session.id, role: 'user', content: 'Olá', createdAt: now });
    const md = async (lang?: string) =>
      (
        await fetch(`${base}/api/sessions/${session.id}/export`, {
          headers: lang ? { 'accept-language': lang } : {},
        })
      ).text();
    const pt = await md();
    expect(pt).toContain('Exportado do Adelic em');
    expect(pt).toContain('· 1 mensagens');
    expect(pt).toContain('## Você ·');
    const en = await md('en');
    expect(en).toContain('Exported from Adelic on');
    expect(en).toContain('## You ·');
    expect(en).toContain('Olá');
  });
});
