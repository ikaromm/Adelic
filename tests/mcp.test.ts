import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRegistry, RunInput } from '../shared/contracts.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { mcpServerView, projectMcpReport, resolveMcpCommand, runMcpServers } from '../server/mcp.js';
import { CreateMcpServerSchema, PatchMcpServerSchema, ProjectMcpSchema, parseBody } from '../shared/schemas.js';
import { MCP_MESSAGES, MCP_SECRET_MASK, mcpFieldsError, mcpLines, type McpServerRecord } from '../shared/mcp.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-mcp-'));
  dirs.push(dir);
  return dir;
}
/** An executable fixture inside its own folder (never directly in /tmp). */
function fakeBinary(name = 'fake-mcp') {
  const dir = join(tempDir(), 'bin');
  mkdirSync(dir);
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n');
  chmodSync(file, 0o755);
  return file;
}
const SECRET = 'segredo-literal-123';

function setup() {
  const dir = tempDir();
  const store = new Store(dir);
  const inputs: RunInput[] = [];
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
          models: [{ id: 'm1', name: 'm1', isDefault: true, efforts: ['low', 'high'] }],
          defaultModel: 'm1',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    },
    async run(input, emit) {
      inputs.push(input);
      emit({ type: 'delta', text: 'ok' });
      return { text: 'ok', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers);
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  return { store, server, orchestrator, inputs, dir };
}
async function base(server: Server) {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function call(url: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: url },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : undefined };
}

describe('MCP catalog schemas', () => {
  const valid = { name: 'docs', command: '/usr/bin/true' };
  it('accepts a minimal stdio entry and refuses remote transports', () => {
    expect(parseBody(CreateMcpServerSchema, valid, 'x').ok).toBe(true);
    for (const body of [
      { ...valid, transport: 'http' },
      { ...valid, url: 'https://example.invalid/mcp' },
      { ...valid, bearer_token_env_var: 'TOKEN' },
    ])
      expect(parseBody(CreateMcpServerSchema, body, 'x')).toEqual({ ok: false, message: MCP_MESSAGES.transport });
  });
  it('enforces names, argument and environment limits', () => {
    const bad = (body: Record<string, unknown>) => parseBody(CreateMcpServerSchema, { ...valid, ...body }, 'fallback');
    expect(bad({ name: 'Docs!' })).toEqual({ ok: false, message: MCP_MESSAGES.name });
    expect(bad({ args: Array.from({ length: 21 }, () => 'a') })).toEqual({ ok: false, message: MCP_MESSAGES.args });
    expect(bad({ args: ['x'.repeat(501)] })).toEqual({ ok: false, message: MCP_MESSAGES.args });
    expect(bad({ args: Array.from({ length: 20 }, () => 'x'.repeat(500)) }).ok).toBe(true);
    expect(bad({ env: [{ name: '1BAD', from: 'adelic-env' }] })).toEqual({ ok: false, message: MCP_MESSAGES.env });
    expect(
      bad({
        env: [
          { name: 'A', from: 'adelic-env' },
          { name: 'A', from: 'literal', value: 'x' },
        ],
      }),
    ).toEqual({ ok: false, message: MCP_MESSAGES.env });
    // A pass-through variable carries only a name, never a value.
    expect(bad({ env: [{ name: 'A', from: 'adelic-env', value: 'x' }] })).toEqual({
      ok: false,
      message: MCP_MESSAGES.env,
    });
    expect(bad({ tools: [] })).toEqual({ ok: false, message: MCP_MESSAGES.tools });
    expect(bad({ tools: ['a', 'a'] })).toEqual({ ok: false, message: MCP_MESSAGES.tools });
    expect(parseBody(PatchMcpServerSchema, { tools: null }, 'x')).toMatchObject({ ok: true, data: { tools: null } });
    expect(parseBody(ProjectMcpSchema, { enabled: ['a', 'a'] }, 'x').ok).toBe(false);
    expect(parseBody(ProjectMcpSchema, {}, 'x').ok).toBe(false);
  });
  it('form validation mirrors the API and splits list fields', () => {
    const fields = { name: 'ok', description: '', command: 'node', args: [], env: [], tools: [] };
    expect(mcpFieldsError(fields)).toBe('');
    expect(mcpFieldsError({ ...fields, name: 'NO' })).toBe(MCP_MESSAGES.name);
    expect(mcpFieldsError({ ...fields, command: ' ' })).toBe(MCP_MESSAGES.command);
    expect(mcpFieldsError({ ...fields, description: 'x'.repeat(301) })).toBe(MCP_MESSAGES.description);
    expect(mcpFieldsError({ ...fields, args: ['x'.repeat(501)] })).toBe(MCP_MESSAGES.args);
    expect(mcpFieldsError({ ...fields, env: [{ name: 'A', from: 'literal' }] })).toBe(MCP_MESSAGES.literal);
    expect(mcpFieldsError({ ...fields, env: [{ name: 'A', from: 'literal', stored: true }] })).toBe('');
    expect(mcpFieldsError({ ...fields, env: [{ name: 'A B', from: 'adelic-env' }] })).toBe(MCP_MESSAGES.env);
    expect(mcpFieldsError({ ...fields, tools: ['a b'] })).toBe(MCP_MESSAGES.tools);
    expect(mcpLines(' a \n\n b\n')).toEqual(['a', 'b']);
  });
});

describe('MCP command resolution', () => {
  it('requires an executable absolute path or resolves a bare name to one at save time', () => {
    const binary = fakeBinary();
    expect(resolveMcpCommand(binary)).toBe(binary);
    expect(resolveMcpCommand('fake-mcp', () => binary)).toBe(binary);
    expect(() => resolveMcpCommand('fake-mcp', () => '')).toThrow(/não encontrado no PATH/);
    expect(() => resolveMcpCommand('fake-mcp', () => 'relative/path')).toThrow(/não encontrado no PATH/);
    expect(() => resolveMcpCommand('./bin/fake-mcp')).toThrow(MCP_MESSAGES.command);
    expect(() => resolveMcpCommand('a;b')).toThrow(MCP_MESSAGES.command);
    const notExec = join(tempDir(), 'plain');
    writeFileSync(notExec, 'x');
    expect(() => resolveMcpCommand(notExec)).toThrow(/sem permissão de execução/);
    expect(resolveMcpCommand('sh')).toMatch(/^\/.*\/sh$/);
  });
});

describe('MCP catalog API', () => {
  it('creates, lists, edits and deletes entries; literal values are write-only', async () => {
    const { server, store } = setup();
    const url = await base(server);
    const binary = fakeBinary();
    expect((await call(url, 'GET', '/api/mcp-servers')).json).toEqual({ servers: [] });
    const created = await call(url, 'POST', '/api/mcp-servers', {
      name: 'docs',
      description: ' Documentação ',
      command: binary,
      args: ['--stdio'],
      env: [
        { name: 'HOME_TOKEN', from: 'adelic-env' },
        { name: 'API_KEY', from: 'literal', value: SECRET },
      ],
      tools: ['search'],
    });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain(SECRET);
    expect(created.json).toMatchObject({
      name: 'docs',
      description: 'Documentação',
      transport: 'stdio',
      command: binary,
      args: ['--stdio'],
      env: [
        { name: 'HOME_TOKEN', from: 'adelic-env' },
        { name: 'API_KEY', from: 'literal', set: true },
      ],
      tools: ['search'],
    });
    const id = created.json.id as string;
    // The value is stored, but no response, list or export returns it.
    expect(store.getMcpServer(id)?.env[1]).toEqual({ name: 'API_KEY', from: 'literal', value: SECRET });
    for (const path of ['/api/mcp-servers', '/api/export'])
      expect((await call(url, 'GET', path)).text).not.toContain(SECRET);
    expect((await call(url, 'POST', '/api/mcp-servers', { name: 'docs', command: binary })).status).toBe(409);
    expect((await call(url, 'POST', '/api/mcp-servers', { name: 'novo', command: 'nao-existe-xyz' })).status).toBe(400);
    expect(
      (
        await call(url, 'POST', '/api/mcp-servers', {
          name: 'novo',
          command: binary,
          env: [{ name: 'K', from: 'literal' }],
        })
      ).json,
    ).toEqual({ error: MCP_MESSAGES.literal });

    // A literal sent without value keeps the stored one; tools: null removes the allowlist.
    const patched = await call(url, 'PATCH', `/api/mcp-servers/${id}`, {
      args: [],
      env: [{ name: 'API_KEY', from: 'literal' }],
      tools: null,
    });
    expect(patched.status).toBe(200);
    expect(patched.text).not.toContain(SECRET);
    expect(patched.json.tools).toBeUndefined();
    expect(store.getMcpServer(id)?.env).toEqual([{ name: 'API_KEY', from: 'literal', value: SECRET }]);
    const renamed = await call(url, 'PATCH', `/api/mcp-servers/${id}`, {
      name: 'docs2',
      env: [{ name: 'API_KEY', from: 'literal', value: 'novo' }],
    });
    expect(renamed.json.name).toBe('docs2');
    expect(store.getMcpServer(id)?.env[0]?.value).toBe('novo');
    expect((await call(url, 'PATCH', '/api/mcp-servers/nope', { name: 'x' })).status).toBe(404);
    expect((await call(url, 'PATCH', `/api/mcp-servers/${id}`, { command: 'rel/x' })).status).toBe(400);

    expect((await call(url, 'DELETE', `/api/mcp-servers/${id}`, {})).status).toBe(204);
    expect((await call(url, 'DELETE', `/api/mcp-servers/${id}`, {})).status).toBe(404);
    // Mutations need a JSON body (origin guard), DELETE included.
    expect((await fetch(`${url}/api/mcp-servers/${id}`, { method: 'DELETE' })).status).toBe(415);
  });

  it('toggles entries per project (default none) and removes deleted entries from projects', async () => {
    const { server, store, dir } = setup();
    const url = await base(server);
    const project = (
      await call(url, 'POST', '/api/projects', { name: 'P', path: dir, memoryWorkspace: 'w', memoryProject: 'p' })
    ).json;
    expect(project.enabledMcp).toBeUndefined();
    const report = await call(url, 'GET', `/api/projects/${project.id}/mcp`);
    expect(report.json.enabled).toEqual([]);
    expect(report.json.providers.find((p: { providerId: string }) => p.providerId === 'codex').servers).toEqual([]);
    const entry = (await call(url, 'POST', '/api/mcp-servers', { name: 'docs', command: fakeBinary() })).json;
    expect((await call(url, 'PUT', `/api/projects/${project.id}/mcp`, { enabled: ['ghost'] })).json).toEqual({
      error: MCP_MESSAGES.unknownIds,
    });
    expect((await call(url, 'PUT', '/api/projects/nope/mcp', { enabled: [] })).status).toBe(404);
    expect((await call(url, 'GET', '/api/projects/nope/mcp')).status).toBe(404);
    const enabled = await call(url, 'PUT', `/api/projects/${project.id}/mcp`, { enabled: [entry.id] });
    expect(enabled.json.project.enabledMcp).toEqual([entry.id]);
    expect(enabled.json.report.providers.map((p: { servers: string[] }) => p.servers)).toEqual([
      ['docs'],
      ['docs'],
      [],
      [],
    ]);
    await call(url, 'DELETE', `/api/mcp-servers/${entry.id}`, {});
    expect(store.getProject(project.id)?.enabledMcp).toEqual([]);
  });
});

describe('what a run receives', () => {
  const record = (overrides: Partial<McpServerRecord> = {}): McpServerRecord => ({
    id: 'id-1',
    name: 'docs',
    description: '',
    transport: 'stdio',
    command: '/opt/docs/bin/docs',
    args: ['--stdio'],
    env: [
      { name: 'PASS_SET', from: 'adelic-env' },
      { name: 'PASS_UNSET', from: 'adelic-env' },
      { name: 'LIT', from: 'literal', value: SECRET },
    ],
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  });
  it('builds the run entries, skips unset pass-through names and never serves detached conversations', () => {
    const store = new Store(tempDir());
    store.putMcpServer(record());
    store.putMcpServer(record({ id: 'id-2', name: 'other', tools: ['a'] }));
    const project = {
      id: 'p',
      name: 'P',
      path: '/',
      createdAt: '',
      memoryWorkspace: '',
      memoryProject: '',
      enabledMcp: ['id-1'],
    };
    const env = { PASS_SET: 'yes' };
    expect(runMcpServers(store, project, false, env)).toEqual([
      { name: 'docs', command: '/opt/docs/bin/docs', args: ['--stdio'], env: { LIT: SECRET }, passEnv: ['PASS_SET'] },
    ]);
    expect(runMcpServers(store, project, true, env)).toEqual([]);
    expect(runMcpServers(store, { ...project, id: 'detached:s1' }, false, env)).toEqual([]);
    expect(runMcpServers(store, { ...project, enabledMcp: undefined }, false, env)).toEqual([]);
    const both = runMcpServers(store, { ...project, enabledMcp: ['id-2', 'id-1', 'gone'] }, false, env);
    expect(both.map((s) => s.name)).toEqual(['docs', 'other']);
    expect(both[1]?.tools).toEqual(['a']);
    const report = projectMcpReport(store, { ...project, enabledMcp: ['id-1', 'id-2'] }, env);
    expect(report.servers[0]).toMatchObject({ commandFound: false, missingEnv: ['PASS_UNSET'] });
    // Kiro cannot enforce an allowlist received over ACP, so it would block instead.
    expect(report.providers.find((p) => p.providerId === 'kiro')).toMatchObject({ servers: [] });
    expect(JSON.stringify(report)).not.toContain(SECRET);
    expect(JSON.stringify(mcpServerView(record()))).toContain(`"set":true`);
    expect(JSON.stringify(mcpServerView(record()))).not.toContain(SECRET);
    expect(MCP_SECRET_MASK).toBe('••••');
  });

  it('passes enabled servers to project runs with tools only, never to detached conversations', async () => {
    const { server, inputs, dir } = setup();
    const url = await base(server);
    const project = (
      await call(url, 'POST', '/api/projects', { name: 'P', path: dir, memoryWorkspace: 'w', memoryProject: 'p' })
    ).json;
    await call(url, 'PATCH', `/api/projects/${project.id}`, { orchestration: { enabled: false } });
    const entry = (await call(url, 'POST', '/api/mcp-servers', { name: 'docs', command: fakeBinary() })).json;
    await call(url, 'PUT', `/api/projects/${project.id}/mcp`, { enabled: [entry.id] });
    const send = async (projectId: string | null, content: string) => {
      const session = (await call(url, 'POST', '/api/sessions', { projectId, mode: 'fast' })).json;
      const before = inputs.length;
      const sent = await call(url, 'POST', `/api/sessions/${session.id}/messages`, { content });
      expect(sent.status).toBeLessThan(300);
      for (let i = 0; i < 100 && inputs.length === before; i++) await new Promise((r) => setTimeout(r, 20));
      for (let i = 0; i < 100; i++) {
        const detail = (await call(url, 'GET', `/api/sessions/${session.id}`)).json;
        if (!detail.session.activeRunId) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return inputs.at(-1)!;
    };
    const bound = await send(project.id, 'liste os arquivos do projeto');
    expect(bound.plan.tools).toBe(true);
    expect(bound.mcpServers?.map((s) => s.name)).toEqual(['docs']);
    const detached = await send(null, 'liste os arquivos do projeto');
    expect(detached.plan.tools).toBe(true);
    expect(detached.mcpServers).toBeUndefined();
  });
});
