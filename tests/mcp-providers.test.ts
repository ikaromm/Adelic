import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider, codexMcpConfig } from '../server/providers/codex';
import { KiroProvider, kiroForeignMcp, kiroMcpServers } from '../server/providers/kiro';
import { bubblewrap, mcpCommandBindings } from '../server/providers/sandbox';
import type { Approval, ProviderEvent, RunInput } from '../shared/contracts';
import type { RunMcpServer } from '../shared/mcp';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(base = os.tmpdir()) {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'adelic-mcp-prov-'));
  dirs.push(dir);
  return dir;
}
const SECRET = 'valor-literal-secreto';
/** One JSON-RPC line logged by a fixture; fields are read loosely by the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON is untyped by nature
type Loose = Record<string, any>;
interface Logged {
  argv?: string[];
  method?: string;
  id?: number;
  params: Loose;
  result: Loose;
}
// An existing executable: providers refuse a missing MCP command before starting.
const docs: RunMcpServer = {
  name: 'docs',
  command: '/usr/bin/true',
  args: ['--stdio'],
  env: { API_KEY: SECRET },
  passEnv: ['DOCS_HOME'],
  tools: ['search'],
};
function input(cwd: string, overrides: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    providerId: 'codex',
    cwd,
    prompt: 'oi',
    history: [],
    plan: { level: 'deep', reason: 'test', tools: true, memory: false, effort: 'low', contextBudget: 80 },
    sandbox: 'read-only',
    ...overrides,
  };
}

/**
 * Fake Codex app-server. `FAKE_HOST_MCP` is what config/read reports; `FAKE_THREAD_MCP` is
 * what mcpServerStatus/list reports for the thread (defaults to the servers configured on
 * thread/start). `FAKE_ELICIT` makes the turn ask for an MCP approval.
 */
async function fakeCodex(dir: string) {
  const log = path.join(dir, 'requests.jsonl');
  const file = path.join(dir, 'fake-codex.mjs');
  await writeFile(
    file,
    `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const log=${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
let configured={};
readline.createInterface({input:process.stdin}).on('line',(line)=>{
  const m=JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify({ method: m.method, id: m.id, params: m.params, result: m.result }) + '\\n');
  if(!m.method){ if(m.id===900){ send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'t1',turn:{id:'u1',status:'completed'}}}); } return; }
  if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{}});
  else if(m.method==='config/read') send({jsonrpc:'2.0',id:m.id,result:{config:{mcp_servers:JSON.parse(process.env.FAKE_HOST_MCP||'{}')}}});
  else if(m.method==='thread/start'){ configured=m.params.config?.mcp_servers||{}; send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'t1'}}}); }
  else if(m.method==='mcpServerStatus/list'){
    if(process.env.FAKE_THREAD_MCP==='garbage'){ send({jsonrpc:'2.0',id:m.id,result:{oops:true}}); return; }
    const data=process.env.FAKE_THREAD_MCP?JSON.parse(process.env.FAKE_THREAD_MCP):Object.entries(configured).map(([name,c])=>({name,runtimeStatus:'connected',pluginId:null,tools:Object.fromEntries((c.enabled_tools||['search']).map(t=>[t,{name:t}]))}));
    send({jsonrpc:'2.0',id:m.id,result:{data,nextCursor:null}});
  }
  else if(m.method==='turn/start'){
    send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'u1'}}});
    if(process.env.FAKE_ELICIT){ send({jsonrpc:'2.0',id:900,method:'mcpServer/elicitation/request',params:{threadId:'t1',turnId:'u1',serverName:process.env.FAKE_ELICIT,mode:'form',_meta:null,message:'Run tool search?',requestedSchema:{type:'object',properties:{}}}}); return; }
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'t1',turn:{id:'u1',status:'completed'}}});
  }
});
`,
  );
  await chmod(file, 0o755);
  const read = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Logged);
  return { file, read };
}
function provider(binary: string) {
  return new CodexProvider(
    async () => binary,
    async () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false }),
    async () => [],
    undefined,
    async (command, args) => ({ command, args }),
  );
}
async function withEnv<T>(env: Record<string, string | undefined>, work: () => Promise<T>) {
  const prior = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Codex MCP configuration', () => {
  it('maps approved servers to thread config with prompt approvals and an allowlist', () => {
    expect(codexMcpConfig([docs])).toEqual({
      docs: {
        command: '/usr/bin/true',
        args: ['--stdio'],
        env: { API_KEY: SECRET },
        env_vars: ['DOCS_HOME'],
        enabled_tools: ['search'],
        enabled: true,
        required: false,
        default_tools_approval_mode: 'prompt',
        startup_timeout_sec: 20,
      },
    });
    expect(codexMcpConfig([{ ...docs, env: {}, passEnv: [], tools: undefined }]).docs).not.toHaveProperty('env');
  });

  it('configures exactly the enabled servers on thread/start, never in argv, and verifies the thread', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const events: ProviderEvent[] = [];
    const other: RunMcpServer = { name: 'other', command: '/usr/bin/true', args: [], env: {}, passEnv: [] };
    await withEnv({ FAKE_HOST_MCP: JSON.stringify({ hostoff: { enabled: false } }) }, async () => {
      const codex = provider(fake.file);
      try {
        await expect(
          codex.run(input(dir, { mcpServers: [docs, other] }), (e) => events.push(e), new AbortController().signal),
        ).resolves.toMatchObject({ stopReason: 'completed' });
      } finally {
        await codex.shutdown();
      }
    });
    const log = await fake.read();
    const argv = log.find((item) => item.argv && item.argv[0] === 'app-server')!.argv!;
    expect(argv.join(' ')).not.toMatch(/mcp_servers|docs|other|\/usr\/bin\/true/);
    expect(JSON.stringify(log.filter((item) => item.argv))).not.toContain(SECRET);
    const start = log.find((item) => item.method === 'thread/start')!;
    expect(Object.keys(start.params.config.mcp_servers)).toEqual(['docs', 'other']);
    expect(start.params.config.mcp_servers.docs.default_tools_approval_mode).toBe('prompt');
    expect(start.params.approvalPolicy).toBe('untrusted');
    const status = log.find((item) => item.method === 'mcpServerStatus/list')!;
    expect(status.params).toMatchObject({ threadId: 't1' });
    const order = log.filter((item) => item.method).map((item) => item.method);
    expect(order.indexOf('mcpServerStatus/list')).toBeLessThan(order.indexOf('turn/start'));
    expect(events).toContainEqual({ type: 'status', text: 'Servidores MCP do projeto nesta execução: docs, other' });
  });

  it('keeps failing closed on any enabled host MCP server when the project enables none', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    await withEnv({ FAKE_HOST_MCP: JSON.stringify({ docs: { enabled: true } }) }, async () => {
      const codex = provider(fake.file);
      try {
        await expect(codex.run(input(dir), () => undefined, new AbortController().signal)).rejects.toThrow(
          /MCPs personalizados ativos/,
        );
      } finally {
        await codex.shutdown();
      }
    });
    const methods = (await fake.read()).map((item) => item.method);
    expect(methods).not.toContain('thread/start');
    expect(methods).not.toContain('mcpServerStatus/list');
  });

  it.each([
    ['a foreign enabled host server', { foreign: { enabled: true } }],
    ['a host entry named like an approved server, even disabled', { docs: { enabled: false } }],
    ['an unreadable host entry', { foreign: { enabled: 'yes' } }],
  ])('rejects %s before any thread starts', async (_label, host) => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    await withEnv({ FAKE_HOST_MCP: JSON.stringify(host) }, async () => {
      const codex = provider(fake.file);
      try {
        await expect(
          codex.run(input(dir, { mcpServers: [docs] }), () => undefined, new AbortController().signal),
        ).rejects.toThrow(/Execução Codex bloqueada/);
      } finally {
        await codex.shutdown();
      }
    });
    expect((await fake.read()).map((item) => item.method)).not.toContain('thread/start');
  });

  it.each([
    [
      'a server the thread reports but Adelic did not approve',
      JSON.stringify([{ name: 'plugin-x', runtimeStatus: 'connected', pluginId: null, tools: {} }]),
      /não aprovado/,
    ],
    [
      'a plugin-provided server under an approved name',
      JSON.stringify([{ name: 'docs', runtimeStatus: 'connected', pluginId: 'p1', tools: {} }]),
      /plugin/,
    ],
    [
      'a tool outside the allowlist',
      JSON.stringify([{ name: 'docs', runtimeStatus: 'connected', pluginId: null, tools: { search: {}, rm: {} } }]),
      /fora da lista/,
    ],
    ['an unreadable thread report', 'garbage', /ilegível/],
  ])('blocks the turn on %s', async (_label, thread, message) => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    await withEnv({ FAKE_HOST_MCP: '{}', FAKE_THREAD_MCP: thread }, async () => {
      const codex = provider(fake.file);
      try {
        await expect(
          codex.run(input(dir, { mcpServers: [docs] }), () => undefined, new AbortController().signal),
        ).rejects.toThrow(message);
      } finally {
        await codex.shutdown();
      }
    });
    expect((await fake.read()).map((item) => item.method)).not.toContain('turn/start');
  });

  it('ignores disabled host entries and reports approved servers that failed to start', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const events: ProviderEvent[] = [];
    const thread = JSON.stringify([
      { name: 'hostoff', runtimeStatus: 'disabled', pluginId: null, tools: {} },
      { name: 'docs', runtimeStatus: 'failed', pluginId: null, tools: {} },
    ]);
    await withEnv(
      { FAKE_HOST_MCP: JSON.stringify({ hostoff: { enabled: false } }), FAKE_THREAD_MCP: thread },
      async () => {
        const codex = provider(fake.file);
        try {
          await codex.run(input(dir, { mcpServers: [docs] }), (e) => events.push(e), new AbortController().signal);
        } finally {
          await codex.shutdown();
        }
      },
    );
    expect(events).toContainEqual({
      type: 'status',
      text: 'Servidores MCP do projeto nesta execução: docs (falharam ao iniciar: docs)',
    });
  });

  it('does not configure MCP for runs without tools and refuses duplicate names', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    await withEnv({ FAKE_HOST_MCP: '{}' }, async () => {
      const codex = provider(fake.file);
      try {
        await codex.run(
          input(dir, { mcpServers: [docs], plan: { ...input(dir).plan, tools: false } }),
          () => undefined,
          new AbortController().signal,
        );
        await expect(
          codex.run(
            input(dir, { runId: 'r2', mcpServers: [docs, docs] }),
            () => undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow(/repetidos/);
      } finally {
        await codex.shutdown();
      }
    });
    const start = (await fake.read()).find((item) => item.method === 'thread/start')!;
    expect(start.params.config).not.toHaveProperty('mcp_servers');
  });

  it('turns MCP tool approvals into manual approvals and declines unknown servers', async () => {
    for (const [server, decision, expected] of [
      ['docs', 'approve', 'accept'],
      ['docs', 'deny', 'decline'],
      ['foreign', undefined, 'decline'],
    ] as const) {
      const dir = await tempDir();
      const fake = await fakeCodex(dir);
      const approvals: Approval[] = [];
      await withEnv({ FAKE_HOST_MCP: '{}', FAKE_ELICIT: server }, async () => {
        const codex = provider(fake.file);
        try {
          const running = codex.run(
            input(dir, { mcpServers: [docs], approvalMode: 'auto-safe' }),
            (event) => {
              if (event.type === 'approval') approvals.push(event.approval);
            },
            new AbortController().signal,
          );
          if (decision) {
            for (let i = 0; i < 200 && !approvals.length; i++) await new Promise((r) => setTimeout(r, 10));
            expect(approvals[0]).toMatchObject({ status: 'pending', title: 'Permitir servidor MCP docs' });
            await codex.approve(approvals[0]!.id, decision);
          }
          await running;
        } finally {
          await codex.shutdown();
        }
      });
      const answer = (await fake.read()).find((item) => item.id === 900 && !item.method)!;
      expect(answer.result.action).toBe(expected);
      if (!decision) expect(approvals).toEqual([]);
    }
  });
});

describe('Kiro MCP payload', () => {
  it('builds ACP stdio entries with pass-through values resolved from Adelic', () => {
    expect(kiroMcpServers([{ ...docs, tools: undefined }], { DOCS_HOME: '/srv/docs' })).toEqual([
      {
        name: 'docs',
        command: '/usr/bin/true',
        args: ['--stdio'],
        env: [
          { name: 'DOCS_HOME', value: '/srv/docs' },
          { name: 'API_KEY', value: SECRET },
        ],
      },
    ]);
    expect(kiroMcpServers([{ ...docs, tools: undefined }], {})[0]?.env).toEqual([{ name: 'API_KEY', value: SECRET }]);
    expect(kiroForeignMcp({ data: { servers: [{ name: 'docs' }, { name: 'x' }] } }, ['docs'])).toEqual(['x']);
    expect(kiroForeignMcp({ data: { servers: [] } }, ['docs'])).toEqual([]);
    expect(kiroForeignMcp(undefined, ['docs'])).toBeUndefined();
    expect(kiroForeignMcp({ data: { servers: [{}] } }, ['docs'])).toBeUndefined();
  });

  async function fakeKiro(dir: string, reported: string) {
    const log = path.join(dir, 'kiro.jsonl');
    const script = path.join(dir, 'kiro-fixture.mjs');
    await writeFile(
      script,
      `#!/usr/bin/env node
import readline from 'node:readline';import fs from 'node:fs';
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',(line)=>{const m=JSON.parse(line);if(!m.method)return;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,params:m.params})+'\\n');
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'k1'}});
else if(m.method==='_kiro.dev/commands/execute'){const r=${reported};send({jsonrpc:'2.0',id:m.id,result:r===null?undefined:{success:true,data:{servers:r}}});}
else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'k1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});}});
`,
    );
    await chmod(script, 0o755);
    const read = async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Logged & { method: string });
    return { script, read };
  }
  const kiroInput = (dir: string, mcp?: RunMcpServer[]): RunInput => ({
    ...input(dir, { providerId: 'kiro', sandbox: 'workspace-write' }),
    ...(mcp ? { mcpServers: mcp } : {}),
  });
  // Real bubblewrap: the fixture writes its log inside the (writable) workspace, which must not be under /tmp.
  const base = path.join(process.cwd(), '.adelic/test-tmp');

  it.skipIf(!existsSync('/usr/bin/bwrap'))(
    'sends the enabled entries in session/new and verifies the session',
    async () => {
      const dir = await tempDir(base);
      const fake = await fakeKiro(dir, `[{name:'docs'}]`);
      const server: RunMcpServer = { ...docs, command: '/usr/bin/true', tools: undefined };
      await withEnv({ ADELIC_KIRO_BIN: fake.script, DOCS_HOME: '/srv/docs' }, async () => {
        const kiro = new KiroProvider();
        const events: ProviderEvent[] = [];
        try {
          await expect(
            kiro.run(kiroInput(dir, [server]), (e) => events.push(e), new AbortController().signal),
          ).resolves.toMatchObject({ text: 'ok' });
          expect(events).toContainEqual({ type: 'status', text: 'Servidores MCP do projeto nesta execução: docs' });
          // Without enabled entries the list stays empty and no MCP query is made.
          await kiro.run({ ...kiroInput(dir), runId: 'r2' }, () => undefined, new AbortController().signal);
        } finally {
          await kiro.shutdown();
        }
      });
      const log = await fake.read();
      const sessions = log.filter((m) => m.method === 'session/new');
      expect(sessions[0]!.params.mcpServers).toEqual([
        {
          name: 'docs',
          command: '/usr/bin/true',
          args: ['--stdio'],
          env: [
            { name: 'DOCS_HOME', value: '/srv/docs' },
            { name: 'API_KEY', value: SECRET },
          ],
        },
      ]);
      expect(sessions[1]!.params.mcpServers).toEqual([]);
      expect(log.filter((m) => m.method === '_kiro.dev/commands/execute')).toHaveLength(1);
    },
  );

  it.skipIf(!existsSync('/usr/bin/bwrap')).each([
    ['a server from Kiro’s own config', `[{name:'docs'},{name:'from-kiro-config'}]`, /não aprovado/],
    ['no report', 'null', /não informou/],
  ])('blocks the prompt on %s', async (_label, reported, message) => {
    const dir = await tempDir(base);
    const fake = await fakeKiro(dir, reported);
    await withEnv({ ADELIC_KIRO_BIN: fake.script }, async () => {
      const kiro = new KiroProvider();
      try {
        await expect(
          kiro.run(
            kiroInput(dir, [{ ...docs, command: '/usr/bin/true', tools: undefined }]),
            () => undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow(message);
      } finally {
        await kiro.shutdown();
      }
    });
    expect((await fake.read()).map((m) => m.method)).not.toContain('session/prompt');
  });

  it('refuses an allowlist it cannot enforce before starting Kiro', async () => {
    const dir = await tempDir(base);
    const fake = await fakeKiro(dir, '[]');
    await withEnv({ ADELIC_KIRO_BIN: fake.script }, async () => {
      const kiro = new KiroProvider();
      try {
        await expect(kiro.run(kiroInput(dir, [docs]), () => undefined, new AbortController().signal)).rejects.toThrow(
          /lista de ferramentas/,
        );
      } finally {
        await kiro.shutdown();
      }
    });
    expect(await fake.read()).toEqual([]);
  });
});

describe('sandbox binding of MCP commands', () => {
  it('binds the command directory read-only only when /tmp hides it', async () => {
    const workspace = await tempDir();
    const tools = await tempDir();
    await mkdir(path.join(tools, 'bin'));
    const command = path.join(tools, 'bin', 'srv');
    await writeFile(command, '#!/bin/sh\necho MCP_VISIBLE\n');
    await chmod(command, 0o755);
    const alias = path.join(tools, 'alias');
    await symlink(path.join(tools, 'bin'), alias);
    expect(await mcpCommandBindings([], workspace)).toEqual([]);
    expect(await mcpCommandBindings(['/usr/bin/true'], workspace)).toEqual([]);
    const bindings = await mcpCommandBindings([command, path.join(alias, 'srv')], workspace);
    expect(bindings).toEqual([
      { source: path.join(tools, 'bin'), target: path.join(tools, 'bin'), directory: true },
      { source: path.join(tools, 'bin'), target: alias, directory: true },
    ]);
    // A command inside the workspace needs no extra mount (the workspace is already bound).
    const inside = path.join(workspace, 'srv');
    await writeFile(inside, '#!/bin/sh\n');
    await chmod(inside, 0o755);
    expect(await mcpCommandBindings([inside], workspace)).toEqual([]);
    await expect(mcpCommandBindings(['relative/srv'], workspace)).rejects.toThrow(/caminho absoluto/);
    await expect(mcpCommandBindings([path.join(tools, 'missing')], workspace)).rejects.toThrow(/indisponível/);
    await expect(mcpCommandBindings([path.join(tools, 'bin')], workspace)).rejects.toThrow(/indisponível/);
  });

  it('refuses a command placed directly in /tmp instead of binding /tmp', async () => {
    const workspace = await tempDir();
    const loose = path.join('/tmp', `adelic-mcp-loose-${process.pid}`);
    await writeFile(loose, '#!/bin/sh\n');
    await chmod(loose, 0o755);
    try {
      await expect(mcpCommandBindings([loose], workspace)).rejects.toThrow(/direto em \/tmp/);
    } finally {
      await rm(loose, { force: true });
    }
  });

  it.skipIf(!existsSync('/usr/bin/bwrap'))(
    'makes a /tmp command executable inside real bubblewrap',
    async ({ skip }) => {
      const workspace = await tempDir();
      const tools = await tempDir();
      await mkdir(path.join(tools, 'bin'));
      const command = path.join(tools, 'bin', 'srv');
      await writeFile(
        command,
        '#!/bin/sh\necho MCP_VISIBLE\ntouch "$0.write" 2>/dev/null && echo WRITABLE || echo READ_ONLY\n',
      );
      await chmod(command, 0o755);
      const run = async (bindings: Awaited<ReturnType<typeof mcpCommandBindings>>) => {
        const wrapped = await bubblewrap('/bin/sh', ['-c', `"${command}"`], workspace, 'workspace-write', [], bindings);
        return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
          const child = spawn(wrapped.command, wrapped.args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (out += d));
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, out }));
        });
      };
      const hidden = await run([]);
      if (/namespace|Operation not permitted/i.test(hidden.out)) skip(`bubblewrap unavailable: ${hidden.out}`);
      expect(hidden.out).not.toContain('MCP_VISIBLE');
      const visible = await run(await mcpCommandBindings([command], workspace));
      expect(visible.code, visible.out).toBe(0);
      expect(visible.out).toContain('MCP_VISIBLE');
      expect(visible.out).toContain('READ_ONLY');
    },
  );
});
