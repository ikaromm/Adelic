import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider, codexMcpConfig } from '../server/providers/codex';
import { RunEvidenceStore } from '../server/run-evidence';
import { delegatedEvidenceInputIdentity } from '../server/orchestrator';
import { cleanupSkillsMcpSnapshots, isSkillsMcpServer, skillsMcpRunServer } from '../server/mcp';
import { Store } from '../server/store';
import { KiroProvider, kiroForeignMcp, kiroMcpServers } from '../server/providers/kiro';
import { bubblewrap, mcpCommandBindings } from '../server/providers/sandbox';
import type { Approval, ProviderEvent, RunEvent, RunInput } from '../shared/contracts';
import type { RunMcpServer } from '../shared/mcp';
import { toolActionDescription, toolActionStatus } from '../src/run-activity';

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
  evidenceDispatch?: { status: number | null; stdout: string; stderr: string };
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
import { spawnSync } from 'node:child_process';
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
    if(process.env.FAKE_CALL_EVIDENCE){
      const c=configured['adelic-run-evidence'];
      const wire=[{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_run_evidence',arguments:{}}}].map(x=>JSON.stringify(x)).join('\\n')+'\\n';
      const result=spawnSync(c.command,c.args,{encoding:'utf8',input:wire,env:{...process.env,...c.env}});
      fs.appendFileSync(log,JSON.stringify({evidenceDispatch:{status:result.status,stdout:result.stdout,stderr:result.stderr}})+'\\n');
    }
    if(process.env.FAKE_ELICIT){ send({jsonrpc:'2.0',id:900,method:'mcpServer/elicitation/request',params:{threadId:process.env.FAKE_ELICIT_THREAD||'t1',turnId:'u1',serverName:process.env.FAKE_ELICIT_SERVER||process.env.FAKE_ELICIT,mode:process.env.FAKE_ELICIT_MODE||'form',_meta:null,message:'Allow the server to run its tool?',requestedSchema:{type:'object',properties:{}}}}); return; }
    if(process.env.FAKE_MCP_ITEM){ const item=JSON.parse(process.env.FAKE_MCP_ITEM); send({jsonrpc:'2.0',method:'item/started',params:{threadId:'t1',item}}); send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'t1',item}}); }
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

  it('passes only the run evidence MCP to the isolated remote profile with configured automatic approval', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const runEvidence = new RunEvidenceStore(dir);
    const runId = '123e4567-e89b-12d3-a456-426614174000';
    await runEvidence.put({
      runId,
      sessionId: 'session-empty',
      capturedAt: new Date().toISOString(),
      source: { state: 'unchanged' },
      environment: [],
      artifacts: { status: 'available', files: [] },
      checks: [],
      outcome: { status: 'completed' },
    });
    const evidence = runEvidence.mcpServer(runId);
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    const codex = provider(fake.file);
    try {
      await expect(
        codex.run(
          input(dir, { runId, evidenceRunId: runId, approvalMode: 'automatic', remote, mcpServers: [docs, evidence] }),
          () => undefined,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ stopReason: 'completed' });
    } finally {
      await codex.shutdown();
    }
    const start = (await fake.read()).find((item) => item.method === 'thread/start')!;
    expect(Object.keys(start.params.config.mcp_servers)).toEqual(['adelic-run-evidence']);
    expect(start.params.config.mcp_servers['adelic-run-evidence']).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining([expect.stringContaining('get_run_evidence')]),
      env: {
        ADELIC_RUN_EVIDENCE_FILE: evidence.env.ADELIC_RUN_EVIDENCE_FILE,
        ADELIC_RUN_EVIDENCE_LOG_DIR: evidence.env.ADELIC_RUN_EVIDENCE_LOG_DIR,
      },
      enabled_tools: ['get_run_evidence'],
      default_tools_approval_mode: 'auto',
    });
    expect(start.params.sandbox).toBe('read-only');
  });

  it('dispatches an allowed evidence read through the isolated read-only automatic provider transport', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const runEvidence = new RunEvidenceStore(dir);
    const runId = '123e4567-e89b-12d3-a456-426614174001';
    await runEvidence.put({
      runId,
      sessionId: 'session-dispatch',
      capturedAt: new Date().toISOString(),
      source: { state: 'changed', marker: 'usable-evidence-response' },
      environment: [{ marker: 'observed-environment' }],
      artifacts: { status: 'available', files: [{ path: 'src/real.ts', status: 'modified' }] },
      checks: [],
      outcome: { status: 'completed' },
    });
    const evidence = runEvidence.mcpServer(runId);
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    await withEnv({ FAKE_HOST_MCP: '{}', FAKE_CALL_EVIDENCE: '1' }, async () => {
      const codex = provider(fake.file);
      try {
        await expect(
          codex.run(
            input(dir, {
              runId,
              evidenceRunId: runId,
              approvalMode: 'automatic',
              remote,
              mcpServers: [docs, evidence],
            }),
            () => undefined,
            new AbortController().signal,
          ),
        ).resolves.toMatchObject({ stopReason: 'completed' });
      } finally {
        await codex.shutdown();
      }
    });

    const log = await fake.read();
    const start = log.find((item) => item.method === 'thread/start')!;
    expect(Object.keys(start.params.config.mcp_servers)).toEqual(['adelic-run-evidence']);
    expect(start.params.config.mcp_servers['adelic-run-evidence']).toMatchObject({
      enabled_tools: ['get_run_evidence'],
      default_tools_approval_mode: 'auto',
    });
    expect(start.params.sandbox).toBe('read-only');
    const dispatch = log.find((item) => item.evidenceDispatch)?.evidenceDispatch;
    expect(dispatch).toBeDefined();
    if (!dispatch) throw new Error('evidence dispatch not captured');
    expect(dispatch.status).toBe(0);
    const response = JSON.parse(dispatch.stdout.trim().split('\n').at(-1)!).result;
    expect(response).toMatchObject({ isError: false });
    const usable = JSON.parse(response.content[0].text);
    expect(usable).toMatchObject({
      runId,
      source: { marker: 'usable-evidence-response' },
      artifacts: { files: [{ path: 'src/real.ts', status: 'modified' }] },
      outcome: { status: 'completed' },
    });
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
      'the builtin codex_apps server Adelic did not approve',
      JSON.stringify([{ name: 'codex_apps', runtimeStatus: 'connected', pluginId: null, tools: {} }]),
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
          await codex.run(
            input(dir, { mcpServers: [docs], approvalMode: 'automatic' }),
            (e) => events.push(e),
            new AbortController().signal,
          );
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

  it('authorizes only the active integrated evidence elicitation according to the run approval mode', async () => {
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    for (const [mode, decision, expectedAction] of [
      ['automatic', undefined, 'accept'],
      ['manual', 'approve', 'accept'],
      ['manual', 'deny', 'decline'],
    ] as const) {
      const dir = await tempDir();
      const fake = await fakeCodex(dir);
      const evidenceStore = new RunEvidenceStore(dir);
      await evidenceStore.put({
        runId: '123e4567-e89b-12d3-a456-426614174010',
        sessionId: 'session-elicitation',
        capturedAt: new Date().toISOString(),
        source: { state: 'unchanged' },
        environment: [],
        artifacts: { status: 'available', files: [] },
        checks: [],
        outcome: { status: 'completed' },
      });
      const evidence = evidenceStore.mcpServer('123e4567-e89b-12d3-a456-426614174010');
      const approvals: Approval[] = [];
      await withEnv({ FAKE_HOST_MCP: '{}', FAKE_ELICIT: 'adelic-run-evidence' }, async () => {
        const codex = provider(fake.file);
        try {
          const running = codex.run(
            input(dir, {
              runId: '123e4567-e89b-12d3-a456-426614174010:223e4567-e89b-12d3-a456-426614174010',
              evidenceRunId: '123e4567-e89b-12d3-a456-426614174010',
              remote,
              mcpServers: [evidence],
              approvalMode: mode,
            }),
            (event) => {
              if (event.type === 'approval') approvals.push(event.approval);
            },
            new AbortController().signal,
          );
          if (mode === 'manual') {
            for (let i = 0; i < 200 && !approvals.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
            expect(approvals[0]).toMatchObject({
              status: 'pending',
              title: 'Permitir servidor MCP adelic-run-evidence',
            });
            await codex.approve(approvals[0]!.id, decision!);
          }
          await running;
          await codex.shutdown();
        } finally {
          await codex.shutdown();
        }
      });
      const response = (await fake.read()).find((item) => item.id === 900 && !item.method);
      expect(response?.result).toEqual({
        action: expectedAction,
        content: expectedAction === 'accept' ? {} : null,
        _meta: null,
      });
      if (mode === 'automatic') expect(approvals).toContainEqual(expect.objectContaining({ status: 'approved' }));
    }
  });

  it('authorizes producer-generated reviewer and synthesis identities against the root evidence store', async () => {
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    for (const [role, rootRunId, taskId] of [
      ['reviewer', '123e4567-e89b-12d3-a456-426614174020', '223e4567-e89b-12d3-a456-426614174020'],
      ['synthesis', '123e4567-e89b-12d3-a456-426614174021', '223e4567-e89b-12d3-a456-426614174021'],
    ] as const) {
      const dir = await tempDir();
      const fake = await fakeCodex(dir);
      const evidenceStore = new RunEvidenceStore(dir);
      await evidenceStore.put({
        runId: rootRunId,
        sessionId: `session-${role}`,
        capturedAt: new Date().toISOString(),
        source: { state: 'unchanged' },
        environment: [],
        artifacts: { status: 'available', files: [] },
        checks: [],
        outcome: { status: 'completed' },
      });
      const identity = delegatedEvidenceInputIdentity(rootRunId, taskId);
      expect(identity).toEqual({ runId: `${rootRunId}:${taskId}`, evidenceRunId: rootRunId });
      const evidence = evidenceStore.mcpServer(rootRunId);
      await withEnv({ FAKE_HOST_MCP: '{}', FAKE_ELICIT: 'adelic-run-evidence' }, async () => {
        const codex = provider(fake.file);
        try {
          await expect(
            codex.run(
              input(dir, {
                ...identity,
                remote,
                mcpServers: [evidence],
                approvalMode: 'automatic',
              }),
              () => undefined,
              new AbortController().signal,
            ),
          ).resolves.toMatchObject({ stopReason: 'completed' });
        } finally {
          await codex.shutdown();
        }
      });
      const response = (await fake.read()).find((item) => item.id === 900 && !item.method);
      expect(response?.result).toEqual({ action: 'accept', content: {}, _meta: null });
      expect(path.basename(evidence.env.ADELIC_RUN_EVIDENCE_FILE!)).toBe(`${rootRunId}.json`);
      expect(path.basename(evidence.env.ADELIC_RUN_EVIDENCE_LOG_DIR!)).toBe(rootRunId);
    }
  });

  it('authorizes automatic producer-generated reviewer and synthesis evidence with and without check logs', async () => {
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    for (const [role, rootRunId, taskId] of [
      ['reviewer', '123e4567-e89b-12d3-a456-426614174040', '223e4567-e89b-12d3-a456-426614174040'],
      ['synthesis', '123e4567-e89b-12d3-a456-426614174041', '223e4567-e89b-12d3-a456-426614174041'],
    ] as const) {
      for (const withCheckLog of [false, true]) {
        const dir = await tempDir();
        const fake = await fakeCodex(dir);
        const evidenceStore = new RunEvidenceStore(dir);
        const eventId = '323e4567-e89b-12d3-a456-426614174040';
        let operationalLog: { status: 'available' | 'truncated' | 'unavailable'; bytes?: number } | undefined;
        if (withCheckLog) {
          const log = await evidenceStore.beginCheckLog(rootRunId, eventId);
          log.write(Buffer.from('typecheck succeeded\\n'));
          operationalLog = await log.finish();
        }
        await evidenceStore.put({
          runId: rootRunId,
          sessionId: `session-${role}`,
          capturedAt: new Date().toISOString(),
          source: { state: 'unchanged' },
          environment: [],
          artifacts: { status: 'available', files: [] },
          checks: withCheckLog
            ? [
                {
                  eventId,
                  name: 'typecheck',
                  status: 'passed',
                  exitCode: 0,
                  command: 'npm run typecheck',
                  operationalLog,
                  source: { kind: 'fixture' },
                  environment: [],
                },
              ]
            : [],
          outcome: { status: 'completed' },
        });
        const identity = delegatedEvidenceInputIdentity(rootRunId, taskId);
        const evidence = evidenceStore.mcpServer(rootRunId);
        await withEnv({ FAKE_HOST_MCP: '{}', FAKE_CALL_EVIDENCE: '1' }, async () => {
          const codex = provider(fake.file);
          try {
            await expect(
              codex.run(
                input(dir, {
                  ...identity,
                  remote,
                  mcpServers: [evidence],
                  approvalMode: 'automatic',
                }),
                () => undefined,
                new AbortController().signal,
              ),
            ).resolves.toMatchObject({ stopReason: 'completed' });
          } finally {
            await codex.shutdown();
          }
        });

        const log = await fake.read();
        const methods = log.filter((item) => item.method).map((item) => item.method);
        expect(methods).toEqual(
          expect.arrayContaining(['initialize', 'thread/start', 'mcpServerStatus/list', 'turn/start']),
        );
        expect(log.find((item) => item.method === 'thread/start')?.params.config.mcp_servers).toHaveProperty(
          'adelic-run-evidence',
        );
        const dispatch = log.find((item) => item.evidenceDispatch)?.evidenceDispatch;
        expect(dispatch?.status).toBe(0);
        const response = JSON.parse(dispatch!.stdout.trim().split(/\r?\n/).at(-1)!).result;
        expect(response.isError).toBe(false);
        const result = JSON.parse(response.content[0].text);
        expect(result.runId).toBe(rootRunId);
        if (withCheckLog) {
          expect(result.checks).toEqual([expect.objectContaining({ eventId, name: 'typecheck', status: 'passed' })]);
          const checkArgs = JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'get_run_evidence', arguments: { checkEventId: eventId } },
          });
          const evidenceTool = evidence.command;
          const evidenceToolArgs = evidence.args;
          const checkRead = await new Promise<{ stdout: string; status: number | null }>((resolve, reject) => {
            const child = spawn(evidenceTool, evidenceToolArgs, {
              env: { ...process.env, ...evidence.env },
              stdio: ['pipe', 'pipe', 'ignore'],
            });
            let stdout = '';
            child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
            child.once('error', reject);
            child.once('close', (status) => resolve({ stdout, status }));
            child.stdin.end(
              [
                JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
                JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'notifications/initialized' }),
                checkArgs,
              ].join('\n') + '\n',
            );
          });
          expect(checkRead.status).toBe(0);
          expect(JSON.parse(checkRead.stdout.trim().split(/\r?\n/).at(-1)!).result.content[0].text).toContain(
            'typecheck succeeded',
          );
        } else {
          expect(result.checks).toEqual([]);
        }
        expect(methods).not.toContain('mcpServer/elicitation/request');
      }
    }
  });

  it.each(['manual', 'auto-safe'] as const)(
    'sends apps disabled on the native deep-tools thread in %s mode',
    async (approvalMode) => {
      const dir = await tempDir();
      const fake = await fakeCodex(dir);
      await withEnv({ FAKE_HOST_MCP: '{}' }, async () => {
        const codex = provider(fake.file);
        try {
          await expect(
            codex.run(input(dir, { approvalMode }), () => undefined, new AbortController().signal),
          ).resolves.toMatchObject({ stopReason: 'completed' });
        } finally {
          await codex.shutdown();
        }
      });
      const log = await fake.read();
      const start = log.find((item) => item.method === 'thread/start')!;
      expect(start.params.config.features).toMatchObject({
        apps: false,
        guardian_approval: false,
        shell_snapshot: false,
      });
      expect(start.params.config.features).not.toHaveProperty('codex_apps');
      expect(log.map((item) => item.method)).toContain('turn/start');
    },
  );

  it('authorizes producer-generated evidence for native local reviewer and synthesis approval modes', async () => {
    for (const [role, mode, rootRunId, taskId] of [
      ['reviewer', 'manual', '123e4567-e89b-12d3-a456-426614174030', '223e4567-e89b-12d3-a456-426614174030'],
      ['synthesis', 'auto-safe', '123e4567-e89b-12d3-a456-426614174031', '223e4567-e89b-12d3-a456-426614174031'],
    ] as const) {
      const dir = await tempDir();
      const fake = await fakeCodex(dir);
      const evidenceStore = new RunEvidenceStore(dir);
      await evidenceStore.put({
        runId: rootRunId,
        sessionId: `session-${role}`,
        capturedAt: new Date().toISOString(),
        source: { state: 'unchanged' },
        environment: [],
        artifacts: { status: 'available', files: [] },
        checks: [],
        outcome: { status: 'completed' },
      });
      const identity = delegatedEvidenceInputIdentity(rootRunId, taskId);
      const approvals: Approval[] = [];
      await withEnv({ FAKE_HOST_MCP: '{}', FAKE_ELICIT: 'adelic-run-evidence' }, async () => {
        const codex = provider(fake.file);
        try {
          const running = codex.run(
            input(dir, {
              ...identity,
              mcpServers: [evidenceStore.mcpServer(rootRunId)],
              approvalMode: mode,
            }),
            (event) => {
              if (event.type === 'approval') approvals.push(event.approval);
            },
            new AbortController().signal,
          );
          for (let i = 0; i < 200 && !approvals.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
          expect(approvals[0]).toMatchObject({ status: 'pending', title: 'Permitir servidor MCP adelic-run-evidence' });
          await codex.approve(approvals[0]!.id, 'approve');
          await expect(running).resolves.toMatchObject({ stopReason: 'completed' });
        } finally {
          await codex.shutdown();
        }
      });
      const log = await fake.read();
      expect(log.some((item) => item.method === 'initialize')).toBe(true);
      expect(log.some((item) => item.method === 'thread/start')).toBe(true);
      expect(log.find((item) => item.method === 'thread/start')?.params.config.mcp_servers).toHaveProperty(
        'adelic-run-evidence',
      );
      expect(log.find((item) => item.id === 900 && !item.method)?.result).toEqual({
        action: 'accept',
        content: {},
        _meta: null,
      });
    }
  });

  it.each([
    ['unapproved server', { FAKE_ELICIT_SERVER: 'foreign' }],
    ['URL elicitation', { FAKE_ELICIT_MODE: 'url' }],
    ['inactive thread', { FAKE_ELICIT_THREAD: 'not-the-active-thread' }],
  ])('declines remote elicitation for %s with a valid evidence owner', async (_label, overrides) => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const evidenceStore = new RunEvidenceStore(dir);
    const runId = '123e4567-e89b-12d3-a456-426614174011';
    const taskId = '223e4567-e89b-12d3-a456-426614174011';
    await evidenceStore.put({
      runId,
      sessionId: 'session-negative',
      capturedAt: new Date().toISOString(),
      source: { state: 'unchanged' },
      environment: [],
      artifacts: { status: 'available', files: [] },
      checks: [],
      outcome: { status: 'completed' },
    });
    const evidence = evidenceStore.mcpServer(runId);
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    await withEnv({ FAKE_HOST_MCP: '{}', FAKE_ELICIT: 'adelic-run-evidence', ...overrides }, async () => {
      const codex = provider(fake.file);
      try {
        await codex.run(
          input(dir, {
            runId: `${runId}:${taskId}`,
            evidenceRunId: runId,
            remote,
            mcpServers: [evidence],
          }),
          () => undefined,
          new AbortController().signal,
        );
      } finally {
        await codex.shutdown();
      }
    });
    expect((await fake.read()).find((item) => item.id === 900 && !item.method)?.result).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });
  });

  it('rejects evidence from a remote SSH runtime before starting Codex', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const evidenceStore = new RunEvidenceStore(dir);
    const runId = '123e4567-e89b-12d3-a456-426614174032';
    await evidenceStore.put({
      runId,
      sessionId: 'session-ssh-negative',
      capturedAt: new Date().toISOString(),
      source: { state: 'unchanged' },
      environment: [],
      artifacts: { status: 'available', files: [] },
      checks: [],
      outcome: { status: 'completed' },
    });
    const codex = provider(fake.file);
    try {
      await expect(
        codex.run(
          input(dir, {
            runId,
            evidenceRunId: runId,
            remote: { label: 'SSH', root: '/workspace', executionKind: 'ssh', call: async () => ({ ok: true }) },
            mcpServers: [evidenceStore.mcpServer(runId)],
          }),
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/inválido ou incompatível/);
    } finally {
      await codex.shutdown();
    }
    expect((await fake.read()).some((item) => item.method === 'initialize')).toBe(false);
  });

  it('rejects a foreign evidence capability before starting Codex', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const evidenceStore = new RunEvidenceStore(dir);
    const runId = '123e4567-e89b-12d3-a456-426614174013';
    const foreignRunId = '123e4567-e89b-12d3-a456-426614174014';
    const taskId = '223e4567-e89b-12d3-a456-426614174013';
    for (const owner of [runId, foreignRunId]) {
      await evidenceStore.put({
        runId: owner,
        sessionId: `session-${owner}`,
        capturedAt: new Date().toISOString(),
        source: { state: 'unchanged' },
        environment: [],
        artifacts: { status: 'available', files: [] },
        checks: [],
        outcome: { status: 'completed' },
      });
    }
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    const foreignEvidence = evidenceStore.mcpServer(foreignRunId);
    const codex = provider(fake.file);
    try {
      await expect(
        codex.run(
          input(dir, {
            runId: `${runId}:${taskId}`,
            evidenceRunId: runId,
            remote,
            mcpServers: [foreignEvidence],
          }),
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/inválido ou incompatível/);
    } finally {
      await codex.shutdown();
    }
    const log = await fake.read();
    expect(log.some((item) => item.method === 'thread/start')).toBe(false);
    expect(log.some((item) => item.evidenceDispatch)).toBe(false);
  });

  it('rejects an incompatible evidence owner before starting Codex', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const evidenceStore = new RunEvidenceStore(dir);
    const ownerRunId = '123e4567-e89b-12d3-a456-426614174015';
    const otherRunId = '123e4567-e89b-12d3-a456-426614174016';
    await evidenceStore.put({
      runId: ownerRunId,
      sessionId: 'session-owner',
      capturedAt: new Date().toISOString(),
      source: { state: 'unchanged' },
      environment: [],
      artifacts: { status: 'available', files: [] },
      checks: [],
      outcome: { status: 'completed' },
    });
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    const codex = provider(fake.file);
    try {
      await expect(
        codex.run(
          input(dir, {
            runId: otherRunId,
            evidenceRunId: ownerRunId,
            remote,
            mcpServers: [evidenceStore.mcpServer(ownerRunId)],
          }),
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/inválido ou incompatível/);
    } finally {
      await codex.shutdown();
    }
    const log = await fake.read();
    expect(log.some((item) => item.method === 'thread/start')).toBe(false);
    expect(log.some((item) => item.evidenceDispatch)).toBe(false);
  });

  it('rejects an incompatible evidence owner in automatic mode before configuring the reader', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const evidenceStore = new RunEvidenceStore(dir);
    const ownerRunId = '123e4567-e89b-12d3-a456-426614174017';
    const taskId = '223e4567-e89b-12d3-a456-426614174017';
    await evidenceStore.put({
      runId: ownerRunId,
      sessionId: 'session-automatic-negative',
      capturedAt: new Date().toISOString(),
      source: { state: 'unchanged' },
      environment: [],
      artifacts: { status: 'available', files: [] },
      checks: [],
      outcome: { status: 'completed' },
    });
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    await withEnv({ FAKE_HOST_MCP: '{}' }, async () => {
      const codex = provider(fake.file);
      try {
        await expect(
          codex.run(
            input(dir, {
              runId: `123e4567-e89b-12d3-a456-426614174018:${taskId}`,
              evidenceRunId: ownerRunId,
              remote,
              mcpServers: [evidenceStore.mcpServer(ownerRunId)],
              approvalMode: 'automatic',
            }),
            () => undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow(/inválido ou incompatível/);
      } finally {
        await codex.shutdown();
      }
    });
    const log = await fake.read();
    expect(log.some((item) => item.method === 'thread/start')).toBe(false);
    expect(log.some((item) => item.evidenceDispatch)).toBe(false);
    expect(log.some((item) => item.id === 900)).toBe(false);
    expect(log.some((item) => item.method === 'turn/start')).toBe(false);
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
  it('surfaces only bounded runtime-reported MCP diagnostics and does not infer success', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const events: ProviderEvent[] = [];
    const runtimeItem = {
      id: 'call-1',
      type: 'mcpToolCall',
      server: 'docs',
      tool: 'search',
      status: 'failed',
      error: {
        message: `transport reset; token=${SECRET} https://user:${SECRET}@example.test {"token":"fixture-secret-123","password":"fixture-pass-456"} password="two word secret" ${'x'.repeat(300)}`,
      },
      arguments: { private: SECRET },
      result: { private: SECRET },
    };
    await withEnv({ FAKE_HOST_MCP: '{}', FAKE_MCP_ITEM: JSON.stringify(runtimeItem) }, async () => {
      const codex = provider(fake.file);
      try {
        await codex.run(
          input(dir, { mcpServers: [docs] }),
          (event) => events.push(event),
          new AbortController().signal,
        );
      } finally {
        await codex.shutdown();
      }
    });
    const completed = events.filter((event) => event.type === 'tool').at(-1);
    expect(completed).toMatchObject({ type: 'tool', name: 'mcpToolCall', status: 'failed' });
    if (completed?.type !== 'tool') throw new Error('MCP tool event missing');
    expect(completed.description).toContain('Servidor: docs');
    expect(completed.description).toContain('Ferramenta: search');
    expect(completed.description).toContain('Estado: failed');
    expect(completed.description).toContain('Erro: transport reset; token=[redigido]');
    expect(completed.description.length).toBeLessThanOrEqual(4 * 160 + 80);
    expect(completed.description).not.toContain(SECRET);
    expect(completed.description).not.toContain('fixture-secret-123');
    expect(completed.description).not.toContain('fixture-pass-456');
    expect(completed.description).not.toContain('two word secret');
    expect(completed.description).not.toContain('private');

    // Traverse the same runtime-derived ProviderEvent through the UI presentation adapter.
    // The fixture sends item/started + item/completed notifications with the Codex app-server
    // item shape; this guards against regressing to a generic mcpToolCall label in the UI.
    const presented = toolActionDescription({
      id: 'mcp-runtime-call',
      runId: 'run-1',
      sessionId: 'session-1',
      type: 'tool',
      toolName: completed.name,
      status: completed.status,
      text: completed.description,
      createdAt: new Date(0).toISOString(),
    } satisfies RunEvent);
    expect(presented).toContain('Servidor: docs');
    expect(presented).toContain('Ferramenta: search');
    expect(presented).toContain('Estado reportado: failed');
    expect(presented).toContain('Erro reportado: transport reset; token=[redigido]');
    expect(presented).not.toContain(SECRET);
    expect(
      toolActionStatus({
        id: 'mcp-runtime-call',
        runId: 'run-1',
        sessionId: 'session-1',
        type: 'tool',
        toolName: completed.name,
        status: completed.status,
        text: completed.description,
        createdAt: new Date(0).toISOString(),
      } satisfies RunEvent),
    ).toBe('failed');

    const unknownDir = await tempDir();
    const unknownFake = await fakeCodex(unknownDir);
    const unknownEvents: ProviderEvent[] = [];
    await withEnv(
      { FAKE_HOST_MCP: '{}', FAKE_MCP_ITEM: JSON.stringify({ id: 'call-2', type: 'mcpToolCall' }) },
      async () => {
        const codex = provider(unknownFake.file);
        try {
          await codex.run(
            input(unknownDir, { mcpServers: [docs] }),
            (event) => unknownEvents.push(event),
            new AbortController().signal,
          );
        } finally {
          await codex.shutdown();
        }
      },
    );
    const unknown = unknownEvents.filter((event) => event.type === 'tool').at(-1);
    expect(unknown).toMatchObject({ type: 'tool', status: 'unknown' });
    if (unknown?.type !== 'tool') throw new Error('MCP tool event missing');
    expect(unknown.description).toContain('Servidor: não informado');
    expect(unknown.description).toContain('Ferramenta: não informada');
    expect(unknown.description).toContain('Estado: não informado');
    expect(unknown.description).toContain('Erro: não reportado');
    const unknownPresentation = {
      id: 'mcp-runtime-unknown',
      runId: 'run-1',
      sessionId: 'session-1',
      type: 'tool' as const,
      toolName: unknown.name,
      status: unknown.status,
      text: unknown.description,
      createdAt: new Date(0).toISOString(),
    } satisfies RunEvent;
    expect(toolActionDescription(unknownPresentation)).toContain('Estado reportado: não informado');
    expect(toolActionDescription(unknownPresentation)).toContain('Erro reportado: não reportado');
    expect(toolActionStatus(unknownPresentation)).toBe('unknown');
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
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');let sessionMcp=[];
readline.createInterface({input:process.stdin}).on('line',(line)=>{const m=JSON.parse(line);if(!m.method)return;
if(process.env.FAKE_KIRO_NO_LOG!=='1')fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,params:m.params})+'\\n');
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new'){sessionMcp=m.params.mcpServers;send({jsonrpc:'2.0',id:m.id,result:{sessionId:'k1'}});}
else if(m.method==='_kiro.dev/commands/execute'){const r=${reported};send({jsonrpc:'2.0',id:m.id,result:r===null?undefined:{success:true,data:{servers:r}}});}
else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'k1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:process.env.FAKE_KIRO_ECHO_MCP==='1'?JSON.stringify(sessionMcp):'ok'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});}});
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

  it.skipIf(!existsSync('/usr/bin/bwrap'))(
    'retains only the built-in skills reader in isolated-local Kiro',
    async () => {
      const dir = await tempDir(base);
      const fake = await fakeKiro(dir, `[{name:'adelic-skills'}]`);
      const store = new Store(dir);
      const skills = skillsMcpRunServer('worker', store);
      store.close();
      const remote = {
        label: 'Local isolado',
        root: '/workspace',
        executionKind: 'isolated-local' as const,
        call: async () => ({ ok: true }),
      };
      let runResultText = '';
      await withEnv({ ADELIC_KIRO_BIN: fake.script, FAKE_KIRO_NO_LOG: '1', FAKE_KIRO_ECHO_MCP: '1' }, async () => {
        const kiro = new KiroProvider();
        try {
          runResultText = (
            await kiro.run({ ...kiroInput(dir, [docs, skills]), remote }, () => undefined, new AbortController().signal)
          ).text;
        } finally {
          await kiro.shutdown();
        }
      });
      // The fixture emits the session payload in its protocol response instead of writing
      // kiro.jsonl into the deliberately read-only project mount.
      const session = JSON.parse(runResultText) as {
        name: string;
        command: string;
        args: string[];
        env: { name: string; value: string }[];
      }[];
      const skillsEntry = session.find((entry) => entry.name === 'adelic-skills');
      expect(skillsEntry).toEqual({
        name: 'adelic-skills',
        command: skills.command,
        args: skills.args,
        env: Object.entries(skills.env).map(([name, value]) => ({ name, value })),
      });
      // Kiro’s isolated remote bridge is injected by the provider; arbitrary project MCPs
      // must still be absent while the builtin gets the role-filtered snapshot binding.
      expect(session.map((entry) => entry.name)).not.toContain('docs');
      expect(session.map((entry) => entry.name).filter((name) => name !== 'adelic_remote')).toEqual(['adelic-skills']);
      // Provider attempts do not own the snapshot: orchestration may retry/fallback with it.
      expect(existsSync(skills.env.ADELIC_SKILLS_SNAPSHOT!)).toBe(true);
      cleanupSkillsMcpSnapshots([skills]);
      expect(existsSync(skills.env.ADELIC_SKILLS_SNAPSHOT!)).toBe(false);
    },
  );
});

describe('sandbox binding of MCP commands', () => {
  it('binds the command directory read-only only when /tmp hides it', async () => {
    // Use real /tmp rather than the executor's /var/tmp scratch root: bubblewrap hides /tmp.
    const workspace = await tempDir('/tmp');
    const tools = await tempDir('/tmp');
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
      const workspace = await tempDir('/tmp');
      const tools = await tempDir('/tmp');
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

describe('internal skills MCP execution capability', () => {
  it('allows only the exact built-in skills server through Codex isolated-local, not project MCPs', async () => {
    const dir = await tempDir();
    const fake = await fakeCodex(dir);
    const store = new Store(dir);
    const skills = skillsMcpRunServer('reviewer', store);
    store.close();
    expect(isSkillsMcpServer(skills)).toBe(true);
    expect(isSkillsMcpServer({ ...skills, command: '/usr/bin/true' })).toBe(false);
    const remote = {
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local' as const,
      call: async () => ({ ok: true }),
    };
    const codex = provider(fake.file);
    try {
      const retryInput = input(dir, { remote, mcpServers: [docs, skills] });
      await expect(codex.run(retryInput, () => undefined, new AbortController().signal)).resolves.toMatchObject({
        stopReason: 'completed',
      });
      expect(existsSync(skills.env.ADELIC_SKILLS_SNAPSHOT!)).toBe(true);
      // Simulate the next attempt/fallback using the exact same valid capability.
      await expect(codex.run(retryInput, () => undefined, new AbortController().signal)).resolves.toMatchObject({
        stopReason: 'completed',
      });
      expect(existsSync(skills.env.ADELIC_SKILLS_SNAPSHOT!)).toBe(true);
      const thread = (await fake.read()).find((item) => item.method === 'thread/start');
      expect(Object.keys(thread?.params.config.mcp_servers ?? {})).toEqual(['adelic-skills']);
      expect(thread?.params.config.mcp_servers['adelic-skills'].env.ADELIC_SKILL_ROLE).toBe('reviewer');
      expect(thread?.params.config.mcp_servers['adelic-skills'].enabled_tools).toBeUndefined();
    } finally {
      await codex.shutdown();
    }
    expect(existsSync(skills.env.ADELIC_SKILLS_SNAPSHOT!)).toBe(true);
    cleanupSkillsMcpSnapshots([skills]);
    expect(existsSync(skills.env.ADELIC_SKILLS_SNAPSHOT!)).toBe(false);
  });
});
