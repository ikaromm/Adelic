import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider } from '../server/providers/codex';
import { JsonRpcProcess } from '../server/providers/process';
import { boundedPrompt } from '../server/providers/common';
import { CommandScope, runCommand } from '../server/providers/command';
import type { RunInput } from '../shared/contracts';

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function runInput(prompt: string): RunInput {
  return { runId: 'run-1', sessionId: 'session-1', providerId: 'codex', cwd: process.cwd(), prompt, history: [], plan: { level: 'fast', reason: 'direct', tools: false, memory: false, effort: 'low', contextBudget: 80 }, sandbox: 'read-only' };
}

describe('provider runtime helpers', () => {
  it('bounds prior conversation to newest text and always preserves the current prompt', () => {
    const input = runInput('current user request');
    input.history = [
      { id: '1', sessionId: input.sessionId, role: 'user', content: 'older message that must be omitted', createdAt: '' },
      { id: '2', sessionId: input.sessionId, role: 'assistant', content: 'recent', createdAt: '' },
    ];
    input.plan.contextBudget = 6;
    const prompt = boundedPrompt(input);
    expect(prompt).toContain('recent');
    expect(prompt).not.toContain('older message');
    expect(prompt).toContain('current user request');

    input.plan.contextBudget = 0;
    input.memoryContext = 'private context';
    expect(boundedPrompt(input)).not.toContain('private context');
  });

  it('escalates a timed-out command and returns without waiting for a SIGTERM-ignoring child', async () => {
    const started = Date.now();
    const result = await runCommand(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], 60);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waits for a SIGTERM-ignoring JSON-RPC child to be killed before shutdown resolves', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-provider-kill-'));
    temporaryDirectories.push(directory);
    const pidPath = path.join(directory, 'pid');
    const script = path.join(directory, 'ignore-term.mjs');
    await writeFile(script, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`);
    await chmod(script, 0o755);
    const rpc = new JsonRpcProcess(script, [], directory, () => undefined);
    let pidText = '';
    for (let attempt = 0; attempt < 50 && !pidText; attempt++) {
      try { pidText = await readFile(pidPath, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    expect(pidText).toMatch(/^\d+$/);
    const pid = Number(pidText);
    const started = Date.now();
    await rpc.kill();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('aborts and awaits provider status commands during scope shutdown', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-command-shutdown-'));
    temporaryDirectories.push(directory);
    const pidPath = path.join(directory, 'pid');
    const script = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const commands = new CommandScope();
    const pending = commands.run(process.execPath, ['-e', script], 10_000);
    let pidText = '';
    for (let attempt = 0; attempt < 50 && !pidText; attempt++) {
      try { pidText = await readFile(pidPath, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    expect(pidText).toMatch(/^\d+$/);
    const pid = Number(pidText);
    const started = Date.now();
    await commands.shutdown();
    await expect(pending).resolves.toMatchObject({ code: null, timedOut: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(commands.run(process.execPath, ['-e', 'process.exit(88)'])).resolves.toMatchObject({ code: null });
  });
});

describe('Codex app-server JSON-RPC lifecycle', () => {
  async function fakeServer(options: { scenario?: string; argsLog?: string; approvalLog?: string; discoveryPidLog?: string } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-provider-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'fake-codex.mjs');
    await writeFile(file, `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
if (process.argv[2] === 'login' && process.argv[3] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
${options.discoveryPidLog ? `if (process.argv[2] === 'app-server') fs.writeFileSync(${JSON.stringify(options.discoveryPidLog)}, String(process.pid));` : ''}
${options.argsLog ? `fs.appendFileSync(${JSON.stringify(options.argsLog)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}) + '\\n');` : ''}
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let turnId = 'turn-1';
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 700 && !message.method) {
    ${options.approvalLog ? `fs.writeFileSync(${JSON.stringify(options.approvalLog)}, JSON.stringify(message));` : ''}
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
  }

  else if (message.id === 999 && !message.method) { ${options.approvalLog ? `fs.writeFileSync(${JSON.stringify(options.approvalLog)}, JSON.stringify(message));` : ''} }
  if (message.method === 'initialize') { if (process.env.FAKE_SCENARIO !== 'abort-init' && process.env.FAKE_SCENARIO !== 'info-pending-init') send({ jsonrpc: '2.0', id: message.id, result: {} }); }
  else if (message.method === 'thread/start') send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } });
  else if (message.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: turnId } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turnId } } });
    if (process.env.FAKE_SCENARIO === 'approval') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId, itemId: 'item-1', cwd: process.cwd(), permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: process.cwd() + '/README.md' } }] } } } });
      return;
    }
    if (process.env.FAKE_SCENARIO === 'unknown-request') {
      send({ jsonrpc: '2.0', id: 999, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId, itemId: 'item-2', questions: [] } });
      setTimeout(() => send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } }), 40);
      return;
    }
    if (process.env.FAKE_SCENARIO === 'crash-after-start') { setTimeout(() => process.exit(0), 20); return; }
    if (message.params.input[0].text.includes('wait for cancellation')) return;
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'fake streamed answer' } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
  } else if (message.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'interrupted' } } });
  }
});
`);
    await chmod(file, 0o755);
    return file;
  }

  it.each([
    ['Logged in using ChatGPT', 'Autenticação da conta ChatGPT confirmada; plano ou assinatura não verificados.'],
    ['Logged in using API key', 'Autenticação por chave de API confirmada; isso não verifica assinatura ChatGPT.'],
  ])('reports the actual Codex authentication type for `%s`', async (status, detail) => {
    const provider = new CodexProvider(
      async () => '/unused/fake-codex',
      async () => ({ code: 0, stdout: status, stderr: '', timedOut: false }),
      async () => [],
    );
    const info = await provider.info();
    expect(info).toMatchObject({ installed: true, available: true, status: 'ready' });
    expect(info.detail).toContain(detail);
    await provider.shutdown();
  });

  it('awaits and reaps model discovery when shutdown interrupts info()', async () => {
    const priorScenario = process.env.FAKE_SCENARIO;
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-discovery-shutdown-'));
    temporaryDirectories.push(directory);
    const pidLog = path.join(directory, 'discovery.pid');
    process.env.FAKE_SCENARIO = 'info-pending-init';
    const binary = await fakeServer({ discoveryPidLog: pidLog });
    const provider = new CodexProvider(async () => binary);
    try {
      const infoPromise = provider.info();
      let pidText = '';
      for (let attempt = 0; attempt < 100 && !pidText; attempt++) {
        try { pidText = await readFile(pidLog, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      expect(pidText).toMatch(/^\d+$/);
      const pid = Number(pidText);
      await provider.shutdown();
      await expect(infoPromise).resolves.toMatchObject({ available: false, status: 'error', detail: 'Codex provider is shutting down.' });
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(provider.info()).resolves.toMatchObject({ available: false, status: 'error' });
    } finally {
      await provider.shutdown();
      if (priorScenario === undefined) delete process.env.FAKE_SCENARIO; else process.env.FAKE_SCENARIO = priorScenario;
    }
  });

  it('initializes once, streams deltas, and maps completed status', async () => {
    const binary = await fakeServer();
    const provider = new CodexProvider(async () => binary);
    const events: string[] = [];
    const result = await provider.run(runInput('answer directly'), (event) => { if (event.type === 'delta') events.push(event.text); }, new AbortController().signal);
    expect(result).toMatchObject({ text: 'fake streamed answer', nativeSessionId: 'thread-1', stopReason: 'completed' });
    expect(events).toEqual(['fake streamed answer']);
    await provider.shutdown();
  });

  it('sends turn/interrupt with the native turn id when the caller aborts', async () => {
    const binary = await fakeServer();
    const provider = new CodexProvider(async () => binary);
    const controller = new AbortController();
    const running = provider.run(runInput('wait for cancellation'), () => undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
    await provider.shutdown();
  });

  it('settles a turn when the app-server exits after turn/start', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'crash-after-start';
    const binary = await fakeServer();
    const provider = new CodexProvider(async () => binary);
    try {
      await expect(provider.run(runInput('answer directly'), () => undefined, new AbortController().signal)).rejects.toThrow(/encerrou antes de concluir/);
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO; else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('aborts during initialize without starting a thread or turn', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'abort-init';
    const binary = await fakeServer();
    const provider = new CodexProvider(async () => binary);
    const controller = new AbortController();
    try {
      const running = provider.run(runInput('must not start'), () => undefined, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.abort();
      await expect(running).rejects.toThrow(/abort|cancel/i);
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO; else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('isolates project servers and disables configured MCPs, including inline TOML and quoted tables', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-config-'));
    temporaryDirectories.push(directory);
    const codexHome = path.join(directory, 'codex-home');
    const projectA = path.join(directory, 'project-a');
    const projectB = path.join(directory, 'project-b');
    const argsLog = path.join(directory, 'args.jsonl');
    await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(path.join(projectA, '.codex'), { recursive: true }), mkdir(path.join(projectB, '.codex'), { recursive: true })]);
    await writeFile(path.join(codexHome, 'config.toml'), 'mcp_servers = { global_inline = { command = "sh", args = ["-c", "touch /tmp/adelic-must-not-run"] } }\n');
    await writeFile(path.join(projectA, '.codex/config.toml'), '[mcp_servers."quoted name"] # comment\ncommand = "sh"\nargs = ["-c", "touch /tmp/adelic-must-not-run"]\n');
    await writeFile(path.join(projectB, '.codex/config.toml'), 'mcp_servers = { second_inline = { command = "sh", args = ["-c", "touch /tmp/adelic-must-not-run"] } }\n');
    const binary = await fakeServer({ argsLog });
    const provider = new CodexProvider(async () => binary);
    const priorHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      await provider.run({ ...runInput('first'), cwd: projectA }, () => undefined, new AbortController().signal);
      await provider.run({ ...runInput('second'), runId: 'run-2', cwd: projectB }, () => undefined, new AbortController().signal);
    } finally {
      await provider.shutdown();
      if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
    }
    const launches = (await readFile(argsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    const byCwd = new Map(launches.map((launch) => [launch.cwd, launch.args]));
    expect(byCwd.size).toBe(2);
    for (const args of byCwd.values()) {
      expect(args).toContain('mcp_servers.global_inline.enabled=false');
      expect(args).toContain('--disable');
      expect(args).toContain('shell_tool');
      expect(args).toContain('hooks');
    }
    expect(byCwd.get(projectA)).toContain('mcp_servers."quoted name".enabled=false');
    expect(byCwd.get(projectB)).toContain('mcp_servers.second_inline.enabled=false');
  });

  it('answers a permissions request with the schema permissions constrained to the selected workspace', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'approval';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-approval-'));
    temporaryDirectories.push(directory);
    const approvalLog = path.join(directory, 'approval.json');
    const binary = await fakeServer({ approvalLog });
    const provider = new CodexProvider(async () => binary);
    const input = { ...runInput('change readme'), runId: 'approval-run', cwd: directory, sandbox: 'workspace-write' as const, plan: { ...runInput('change readme').plan, level: 'deep' as const, tools: true } };
    let resolveApproval!: (id: string) => void;
    const approvalEvent = new Promise<string>((resolve) => { resolveApproval = resolve; });
    try {
      const running = provider.run(input, (event) => { if (event.type === 'approval') resolveApproval(event.approval.id); }, new AbortController().signal);
      const id = await approvalEvent;
      await provider.approve(id, 'approve');
      await expect(running).resolves.toMatchObject({ stopReason: 'completed' });
      const response = JSON.parse(await readFile(approvalLog, 'utf8')) as { result: { permissions: { fileSystem: { entries: { access: string; path: { path: string } }[] } }; scope: string } };
      expect(response.result.scope).toBe('turn');
      expect(response.result.permissions.fileSystem.entries).toEqual([{ access: 'write', path: { type: 'path', path: `${directory}/README.md` } }]);
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO; else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('responds with a JSON-RPC error to unknown server requests instead of leaving them pending', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'unknown-request';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-unknown-'));
    temporaryDirectories.push(directory);
    const approvalLog = path.join(directory, 'response.json');
    const binary = await fakeServer({ approvalLog });
    const provider = new CodexProvider(async () => binary);
    try {
      await expect(provider.run({ ...runInput('question'), cwd: directory }, () => undefined, new AbortController().signal)).resolves.toMatchObject({ stopReason: 'completed' });
      await expect.poll(async () => JSON.parse(await readFile(approvalLog, 'utf8'))).toMatchObject({ error: { code: -32601, message: 'Unsupported Codex app-server request' } });
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO; else process.env.FAKE_SCENARIO = prior;
    }
  });
});
