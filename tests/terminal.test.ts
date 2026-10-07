import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRegistry } from '../shared/contracts.js';
import {
  APP_CSP,
  appendOutput,
  detectDevServerUrls,
  emptyOutput,
  outputText,
  stripAnsi,
  validatePreviewUrl,
  type TerminalCommand,
  type TerminalEvent,
} from '../shared/terminal.js';
import { TerminalRunSchema, parseBody } from '../shared/schemas.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { TerminalBusyError, TerminalService, terminalEnv, type TerminalWrapper } from '../server/terminal.js';
import { startServer, type RunningServer } from '../server/runtime.js';
import { subframeNavigationAllowed } from '../desktop/policy.js';
import { applyTerminalEvent } from '../src/hooks/useTerminal.js';
import { historyKey, loadHistory, recordHistory } from '../src/terminal-history.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
/** Runs the command directly (no sandbox), for flows that do not test isolation. */
const direct: TerminalWrapper = async (command, args) => ({ command, args });
const service = (options: ConstructorParameters<typeof TerminalService>[0] = {}) => {
  const terminal = new TerminalService({ wrap: direct, flushMs: 5, ...options });
  cleanup.push(() => terminal.shutdown());
  return terminal;
};
const tempDir = (root = tmpdir()) => {
  const dir = realpathSync(mkdtempSync(join(root, 'adelic-terminal-')));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
async function until(terminal: TerminalService, id: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const command = terminal.get(id)!;
    if (command.status !== 'running') return command;
    if (Date.now() > deadline) throw new Error(`command still running: ${command.command}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const base = { projectId: 'p1', sandbox: 'read-only' as const, timeoutMs: 60_000 };

// bwrap may exist but be unable to create namespaces (some containers); those tests then skip.
const bwrapWorks =
  existsSync('/usr/bin/bwrap') &&
  spawnSync(
    '/usr/bin/bwrap',
    ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--', '/bin/true'],
    { timeout: 10_000, stdio: 'ignore' },
  ).status === 0;

describe.skipIf(!bwrapWorks)('terminal commands in the agents’ bubblewrap sandbox', () => {
  // /var/tmp stays read-only inside the sandbox (unlike /tmp, which is a private tmpfs), so a
  // folder next to the project is a real "outside the project" target.
  const roots = () => {
    const root = tempDir('/var/tmp');
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(project);
    mkdirSync(outside);
    return { project, outside };
  };
  const real = () => {
    const terminal = new TerminalService({ flushMs: 5 });
    cleanup.push(() => terminal.shutdown());
    return terminal;
  };

  it('runs echo and false with their exit codes, output and duration', async () => {
    const terminal = real();
    const { project } = roots();
    const ok = await terminal.start({ ...base, cwd: project, command: 'echo olá; pwd; echo erro >&2' });
    const done = await until(terminal, ok.id);
    expect(done).toMatchObject({ status: 'exited', exitCode: 0, sandbox: 'read-only' });
    expect(outputText(done.output)).toBe(`olá\n${project}\nerro\n`);
    expect(done.output.chunks.at(-1)).toEqual({ stream: 'stderr', text: 'erro\n' });
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    const failed = await until(terminal, (await terminal.start({ ...base, cwd: project, command: 'false' })).id);
    expect(failed).toMatchObject({ status: 'exited', exitCode: 1 });
  });

  it('stops a sleep and kills it on timeout', async () => {
    const terminal = real();
    const { project } = roots();
    const sleeping = await terminal.start({ ...base, cwd: project, command: 'sleep 30 & sleep 31; echo fim' });
    const startedAt = Date.now();
    const stopped = await terminal.stop(sleeping.id);
    expect(stopped).toMatchObject({ status: 'stopped', exitCode: null });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(spawnSync('pgrep', ['-f', 'sleep 3[01]$']).status).toBe(1);
    const slow = await terminal.start({ ...base, cwd: project, command: 'sleep 30', timeoutMs: 300 });
    expect(await until(terminal, slow.id)).toMatchObject({ status: 'timeout', exitCode: null });
  });

  it('writes only inside the project under workspace-write, and nowhere under read-only', async () => {
    const terminal = real();
    const { project, outside } = roots();
    const probe = `touch dentro.txt && echo DENTRO; touch ${outside}/fora.txt && echo FORA; true`;
    const write = await until(
      terminal,
      (await terminal.start({ ...base, sandbox: 'workspace-write', cwd: project, command: probe })).id,
    );
    expect(outputText(write.output)).toContain('DENTRO');
    expect(outputText(write.output)).not.toContain('FORA');
    expect(existsSync(join(project, 'dentro.txt'))).toBe(true);
    expect(existsSync(join(outside, 'fora.txt'))).toBe(false);
    rmSync(join(project, 'dentro.txt'));

    const readOnly = await until(terminal, (await terminal.start({ ...base, cwd: project, command: probe })).id);
    expect(outputText(readOnly.output)).not.toMatch(/DENTRO|FORA/);
    expect(existsSync(join(project, 'dentro.txt'))).toBe(false);
    expect(existsSync(join(outside, 'fora.txt'))).toBe(false);
  });
});

describe('terminal service', () => {
  it('fails clearly when the sandbox cannot be built', async () => {
    const terminal = service({
      wrap: async () => {
        throw new Error('Política de filesystem indisponível: bubblewrap não está instalado.');
      },
    });
    const result = await terminal.start({ ...base, cwd: '/', command: 'echo x' });
    expect(result).toMatchObject({ status: 'failed', exitCode: null, error: expect.stringContaining('bubblewrap') });
    expect(terminal.running('p1')).toBe(0);
  });

  it('keeps only the last bytes of a long output, also in the streamed events', async () => {
    const terminal = service({ outputLimit: 1000 });
    const events: TerminalEvent[] = [];
    terminal.subscribe('p1', (event) => events.push(event));
    const cwd = tempDir();
    const started = await terminal.start({
      ...base,
      cwd,
      command: 'i=0; while [ $i -lt 3000 ]; do echo linha-$i; i=$((i+1)); done',
    });
    const done = await until(terminal, started.id);
    expect(done.output.bytes).toBeLessThanOrEqual(1000);
    expect(done.output.truncated).toBe(true);
    expect(outputText(done.output).endsWith('linha-2999\n')).toBe(true);
    const streamed = events.flatMap((event) => (event.type === 'output' ? event.chunks : []));
    expect(streamed.reduce((sum, chunk) => sum + chunk.text.length, 0)).toBeLessThan(40_000);
    expect(events.some((event) => event.type === 'output' && event.truncated)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'command', command: { status: 'exited', exitCode: 0 } });
  });

  it('allows at most 3 running commands per project, independently of other projects', async () => {
    const terminal = service();
    const cwd = tempDir();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await terminal.start({ ...base, cwd, command: 'sleep 30' })).id);
    await expect(terminal.start({ ...base, cwd, command: 'sleep 30' })).rejects.toBeInstanceOf(TerminalBusyError);
    const other = await terminal.start({ ...base, projectId: 'p2', cwd, command: 'true' });
    expect(other.status).toBe('running');
    await terminal.stop(ids[0]);
    expect(terminal.running('p1')).toBe(2);
    expect((await terminal.start({ ...base, cwd, command: 'true' })).status).toBe('running');
  });

  it('keeps a bounded list of finished commands and refuses work after shutdown', async () => {
    const terminal = service({ keepFinished: 2 });
    const cwd = tempDir();
    for (let i = 0; i < 4; i++)
      await until(terminal, (await terminal.start({ ...base, cwd, command: `echo ${i}` })).id);
    expect(terminal.list('p1').map((c) => outputText(c.output))).toEqual(['2\n', '3\n']);
    await terminal.shutdown();
    await expect(terminal.start({ ...base, cwd, command: 'true' })).rejects.toMatchObject({ status: 503 });
    expect(await terminal.stop('missing')).toBeUndefined();
  });

  it('does not pass Adelic credentials or shell init hooks to the command', () => {
    const env = terminalEnv({
      PATH: '/usr/bin',
      ADELIC_REMOTE_TOKEN: 'segredo',
      ADELIC_MEMORY_TOKEN: 'segredo',
      BASH_ENV: '/tmp/x',
      ENV: '/tmp/y',
      'BASH_FUNC_ls%%': '() { rm -rf /; }',
    });
    expect(env).toEqual({ PATH: '/usr/bin', TERM: 'dumb', NO_COLOR: '1' });
  });
});

describe('terminal API', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });
  async function setup() {
    const dir = tempDir();
    const store = new Store(dir);
    cleanup.push(() => store.close());
    const providers: ProviderRegistry = {
      list: async () => [],
      run: async () => ({ text: '', stopReason: 'completed' }),
      approve: async () => {},
      shutdown: async () => {},
    } as unknown as ProviderRegistry;
    const terminal = service();
    const { app } = createBackend(store, providers, undefined, undefined, undefined, terminal);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const project = join(dir, 'projeto');
    mkdirSync(project);
    const created = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P', path: project, memoryWorkspace: 'w', memoryProject: 'p' }),
    });
    const { id } = (await created.json()) as { id: string };
    const post = (path: string, body: unknown) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { url, id, post, project };
  }

  it('runs, reports, streams and stops commands, with the narrow frame-src CSP on every response', async () => {
    const { url, id, post, project } = await setup();
    const state = await fetch(`${url}/api/projects/${id}/terminal`);
    expect(state.headers.get('content-security-policy')).toBe(APP_CSP);
    expect(APP_CSP).toBe('frame-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*');
    expect(await state.json()).toMatchObject({
      enabled: true,
      remote: false,
      sandbox: 'read-only',
      maxRunning: 3,
      commands: [],
    });

    const events = await fetch(`${url}/api/projects/${id}/terminal/events`);
    const reader = events.body!.getReader();
    const run = await post(`/api/projects/${id}/terminal`, { command: 'echo olá' });
    expect(run.status).toBe(202);
    const { id: commandId } = (await run.json()) as { id: string };
    let streamed = '';
    while (!streamed.includes('"status":"exited"')) streamed += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(streamed).toContain('"type":"snapshot"');
    expect(streamed).toContain('olá');

    const done = (await (await fetch(`${url}/api/terminal/${commandId}`)).json()) as TerminalCommand;
    expect(done).toMatchObject({ status: 'exited', exitCode: 0, cwd: project, command: 'echo olá' });
    expect(outputText(done.output)).toBe('olá\n');

    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          (await (await post(`/api/projects/${id}/terminal`, { command: 'sleep 30', timeoutSec: 60 })).json()) as {
            id: string;
          }
        ).id,
      );
    const busy = await post(`/api/projects/${id}/terminal`, { command: 'sleep 30' });
    expect(busy.status).toBe(409);
    expect((await post(`/api/terminal/${ids[0]}/stop`, { force: true })).status).toBe(400);
    const stopped = await post(`/api/terminal/${ids[0]}/stop`, {});
    expect(await stopped.json()).toMatchObject({ status: 'stopped' });
    for (const other of ids.slice(1)) await post(`/api/terminal/${other}/stop`, {});
  });

  it('validates the request and unknown ids', async () => {
    const { url, id, post } = await setup();
    expect((await post(`/api/projects/${id}/terminal`, { command: '   ' })).status).toBe(400);
    expect((await post(`/api/projects/${id}/terminal`, { command: 'true', timeoutSec: 5 })).status).toBe(400);
    expect((await post(`/api/projects/${id}/terminal`, { command: 'true', extra: 1 })).status).toBe(400);
    expect((await post('/api/projects/nope/terminal', { command: 'true' })).status).toBe(404);
    expect((await fetch(`${url}/api/projects/nope/terminal`)).status).toBe(404);
    expect((await fetch(`${url}/api/terminal/nope`)).status).toBe(404);
    expect((await post('/api/terminal/nope/stop', {})).status).toBe(404);
    expect(parseBody(TerminalRunSchema, { command: 'x', timeoutSec: 3600 }, '').ok).toBe(true);
    expect(parseBody(TerminalRunSchema, { command: 'x', timeoutSec: 3601 }, '').ok).toBe(false);
  });
});

describe('terminal over remote access', () => {
  const TOKEN = 'c'.repeat(40);
  function call(url: string, init: { method?: string; body?: unknown } = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          method: init.method ?? 'GET',
          localAddress: u.hostname === '127.0.0.2' ? '127.0.0.2' : undefined,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(u.hostname === '127.0.0.2' ? { authorization: `Bearer ${TOKEN}` } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('is disabled for remote clients until enabled on this computer', async () => {
    const dir = tempDir();
    const server: RunningServer = await startServer({
      port: 0,
      dataDir: dir,
      remote: { bind: '127.0.0.2', port: 0 as never, token: TOKEN },
    });
    cleanup.push(() => server.close());
    const remote = server.remoteUrl!;
    const project = tempDir();
    const created = await call(`${server.url}/api/projects`, {
      method: 'POST',
      body: { name: 'P', path: project, memoryWorkspace: 'w', memoryProject: 'p' },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    const state = JSON.parse((await call(`${remote}/api/projects/${id}/terminal`)).body);
    expect(state).toMatchObject({ enabled: false, remote: true, commands: [] });
    expect(state.reason).toContain('Permitir terminal pelo acesso remoto');
    const refused = await call(`${remote}/api/projects/${id}/terminal`, { method: 'POST', body: { command: 'id' } });
    expect(refused.status).toBe(403);
    expect((await call(`${remote}/api/projects/${id}/terminal/events`)).status).toBe(403);
    expect((await call(`${remote}/api/terminal/x`)).status).toBe(403);
    expect((await call(`${remote}/api/terminal/x/stop`, { method: 'POST', body: {} })).status).toBe(403);
    // The opt-in cannot be granted remotely.
    expect((await call(`${remote}/api/settings`, { method: 'PATCH', body: { terminalRemote: true } })).status).toBe(
      403,
    );

    expect((await call(`${server.url}/api/settings`, { method: 'PATCH', body: { terminalRemote: true } })).status).toBe(
      200,
    );
    expect(JSON.parse((await call(`${remote}/api/projects/${id}/terminal`)).body)).toMatchObject({
      enabled: true,
      remote: true,
    });
    const run = await call(`${remote}/api/projects/${id}/terminal`, { method: 'POST', body: { command: 'true' } });
    expect(run.status).toBe(202);
  });
});

describe('preview URLs', () => {
  it('accepts only loopback http(s) URLs', () => {
    for (const [input, url] of [
      ['http://localhost:5173/', 'http://localhost:5173/'],
      ['localhost:5173', 'http://localhost:5173/'],
      ['https://127.0.0.1:8443/app?x=1#a', 'https://127.0.0.1:8443/app?x=1#a'],
      ['HTTP://LOCALHOST:3000', 'http://localhost:3000/'],
      ['http://[::1]:4000/', 'http://[::1]:4000/'],
      ['127.0.0.1', 'http://127.0.0.1/'],
    ])
      expect(validatePreviewUrl(input)).toMatchObject({ ok: true, url });
    expect(validatePreviewUrl('http://[::1]:4000/')).toMatchObject({ frameable: false });
    expect(validatePreviewUrl('http://localhost:4000/')).toMatchObject({ frameable: true });
  });

  it('rejects other hosts, userinfo tricks, other schemes and the app itself', () => {
    const rejected = (input: string, message: RegExp) =>
      expect(validatePreviewUrl(input, 'http://127.0.0.1:4317')).toMatchObject({
        ok: false,
        message: expect.stringMatching(message),
      });
    rejected('http://127.0.0.1.evil.com/', /locais/);
    rejected('http://localhost.evil.com:5173/', /locais/);
    rejected('http://evil.com/', /locais/);
    rejected('http://127.0.0.2:5173/', /locais/);
    rejected('http://0.0.0.0:5173/', /locais/);
    rejected('http://localhost:80@evil.com/', /usuário ou senha/);
    rejected('http://evil.com@localhost:5173/', /usuário ou senha/);
    rejected('http://user:pass@127.0.0.1:5173/', /usuário ou senha/);
    rejected('javascript:alert(1)', /http/);
    rejected('file:///etc/passwd', /http/);
    rejected('ws://localhost:5173/', /http/);
    rejected('data:text/html,oi', /http/);
    rejected('não é url', /inválido/);
    rejected('', /Informe/);
    rejected('http://127.0.0.1:4317/', /próprio Adelic/);
    rejected('http://localhost:4317/chat', /próprio Adelic/);
    expect(validatePreviewUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:4317').ok).toBe(true);
    expect(validatePreviewUrl('http://127.0.0.1:5173/', 'nao-e-url').ok).toBe(true);
  });

  it('lets the desktop preview frame load loopback dev servers only', () => {
    const app = 'http://127.0.0.1:4317';
    expect(subframeNavigationAllowed('http://localhost:5173/', app)).toBe(true);
    expect(subframeNavigationAllowed('http://127.0.0.1:4317/api/attachments/x', app)).toBe(true);
    expect(subframeNavigationAllowed('https://example.com/', app)).toBe(false);
    expect(subframeNavigationAllowed('http://127.0.0.1.evil.com/', app)).toBe(false);
    expect(subframeNavigationAllowed('file:///etc/passwd', app)).toBe(false);
    expect(subframeNavigationAllowed('http://localhost:5173/', '')).toBe(false);
  });

  it('detects dev-server URLs printed in the output', () => {
    const output = [
      '\u001b[32m  ➜  Local:\u001b[39m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m',
      '  ➜  Network: http://192.168.0.10:5173/',
      'Listening on http://0.0.0.0:3000.',
      'Ready at http://127.0.0.1:8000/docs, http://localhost:5173/',
      'see https://example.com/ and http://127.0.0.1.evil.com/',
    ].join('\n');
    expect(detectDevServerUrls(output)).toEqual([
      'http://127.0.0.1:3000/',
      'http://127.0.0.1:8000/docs',
      'http://localhost:5173/',
    ]);
    expect(detectDevServerUrls('nada aqui')).toEqual([]);
    expect(stripAnsi('\u001b[1mok\u001b[0m\u001b]0;título\u0007')).toBe('ok');
  });
});

describe('terminal output buffer', () => {
  it('merges same-stream chunks and drops the oldest bytes past the limit', () => {
    const output = emptyOutput();
    appendOutput(output, 'stdout', 'abc', 8);
    appendOutput(output, 'stdout', 'def', 8);
    appendOutput(output, 'stderr', '', 8);
    expect(output).toEqual({ chunks: [{ stream: 'stdout', text: 'abcdef' }], bytes: 6, truncated: false });
    appendOutput(output, 'stderr', 'ghij', 8);
    expect(output).toEqual({
      chunks: [
        { stream: 'stdout', text: 'cdef' },
        { stream: 'stderr', text: 'ghij' },
      ],
      bytes: 8,
      truncated: true,
    });
    appendOutput(output, 'stdout', 'klmnopqrst', 8);
    expect(output).toEqual({ chunks: [{ stream: 'stdout', text: 'mnopqrst' }], bytes: 8, truncated: true });
  });

  it('counts bytes, not characters, and never keeps half a character', () => {
    const output = appendOutput(emptyOutput(), 'stdout', 'ééé', 5);
    expect(output.bytes).toBeLessThanOrEqual(5);
    expect(outputText(output)).toBe('éé');
  });
});

describe('terminal UI state', () => {
  const info = {
    id: 'a',
    projectId: 'p',
    command: 'ls',
    cwd: '/',
    sandbox: 'read-only' as const,
    exitCode: null,
    startedAt: '',
    timeoutSec: 600,
  };
  it('applies snapshot, command and output events', () => {
    let commands = applyTerminalEvent([], { type: 'command', command: { ...info, status: 'running' } });
    commands = applyTerminalEvent(commands, { type: 'output', id: 'a', chunks: [{ stream: 'stdout', text: 'x' }] });
    commands = applyTerminalEvent(commands, { type: 'output', id: 'other', chunks: [{ stream: 'stdout', text: 'y' }] });
    commands = applyTerminalEvent(commands, {
      type: 'output',
      id: 'a',
      chunks: [{ stream: 'stderr', text: 'z' }],
      truncated: true,
    });
    commands = applyTerminalEvent(commands, { type: 'command', command: { ...info, status: 'exited', exitCode: 0 } });
    expect(commands).toEqual([
      {
        ...info,
        status: 'exited',
        exitCode: 0,
        output: {
          chunks: [
            { stream: 'stdout', text: 'x' },
            { stream: 'stderr', text: 'z' },
          ],
          bytes: 2,
          truncated: true,
        },
      },
    ]);
    expect(applyTerminalEvent(commands, { type: 'snapshot', commands: [] })).toEqual([]);
  });

  it('keeps the last 50 commands per project, text only', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    for (let i = 0; i < 55; i++) recordHistory('p', `cmd ${i}`, storage);
    recordHistory('p', 'cmd 10', storage);
    recordHistory('p', '   ', storage);
    const history = loadHistory('p', storage);
    expect(history).toHaveLength(50);
    expect(history.at(-1)).toBe('cmd 10');
    expect(history.filter((c) => c === 'cmd 10')).toHaveLength(1);
    expect(loadHistory('other', storage)).toEqual([]);
    data.set(historyKey('p'), '{"not":"a list"}');
    expect(loadHistory('p', storage)).toEqual([]);
    data.set(historyKey('p'), 'not json');
    expect(loadHistory('p', storage)).toEqual([]);
    expect(recordHistory('p', 'ok', null)).toEqual(['ok']);
  });
});
