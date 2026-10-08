import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { CodexProvider } from '../server/providers/codex';
import { KiroProvider } from '../server/providers/kiro';
import { REMOTE_TOOL_SPECS, remoteApprovalDetail, validateRemoteArguments } from '../server/providers/remote-tools';
import type { RunInput } from '../shared/contracts';
import type { RemoteRuntime } from '../shared/remote-hosts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function input(cwd: string, remote: RemoteRuntime): RunInput {
  return {
    runId: 'remote-run',
    sessionId: 'remote-session',
    providerId: 'codex',
    cwd,
    prompt: 'Inspect the remote project.',
    history: [],
    plan: { level: 'deep', reason: 'test', tools: true, memory: false, contextBudget: 100 },
    sandbox: 'workspace-write',
    remote,
  };
}

describe('remote provider tools', () => {
  it('accepts only bounded fixed-schema remote arguments and displays complete approval context', () => {
    const runtime: RemoteRuntime = {
      label: 'build-host (builder@example.test)',
      root: '/srv/work/adelic',
      call: async () => undefined,
    };
    const write = REMOTE_TOOL_SPECS.find((tool) => tool.remoteName === 'write_file')!;
    const args = { path: 'README.md', content: 'remote change' };
    expect(validateRemoteArguments(write, args)).toEqual(args);
    expect(validateRemoteArguments(write, { ...args, localPath: '/tmp/secret' })).toBeUndefined();
    expect(validateRemoteArguments(write, { ...args, content: 'x'.repeat(128 * 1024 + 1) })).toBeUndefined();
    expect(validateRemoteArguments(write, { ...args, content: '😀'.repeat(32 * 1024 + 1) })).toBeUndefined();
    expect(remoteApprovalDetail(runtime, write, args)).toContain(
      'Host: build-host (builder@example.test)\nDiretório remoto: /srv/work/adelic\nFerramenta: write_file\nArgumentos: {"path":"README.md","content":"remote change"}',
    );
    const largeArgs = { path: 'src/large.ts', content: 'line\n'.repeat(25_000) };
    expect(validateRemoteArguments(write, largeArgs)).toEqual(largeArgs);
    expect(remoteApprovalDetail(runtime, write, largeArgs)).toContain(JSON.stringify(largeArgs));
  });

  it('does not call the remote executor on denial and rejects a hostile local tool request', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-remote-provider-'));
    dirs.push(directory);
    const requestLog = path.join(directory, 'requests.jsonl');
    const fake = path.join(directory, 'codex.mjs');
    await writeFile(
      fake,
      `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const log=${JSON.stringify(requestLog)};
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const append=(m)=>fs.appendFileSync(log,JSON.stringify(m)+'\\n');
let thread='remote-thread';
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line); append(m);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});
 else if(m.method==='config/read')send({jsonrpc:'2.0',id:m.id,result:{config:{mcp_servers:{}}}});
 else if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:thread}}});
 else if(m.method==='turn/start'){
  send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',id:701,method:'item/tool/call',params:{threadId:thread,turnId:'turn-1',callId:'call-remote',tool:'adelic_remote_exec',arguments:{command:'uname -a'}}});
 }
 else if(m.id===701){
  send({jsonrpc:'2.0',id:702,method:'item/tool/call',params:{threadId:thread,turnId:'turn-1',callId:'call-hostile',tool:'exec',arguments:{command:'touch /tmp/should-not-run'}}});
 }
 else if(m.id===702)send({jsonrpc:'2.0',id:703,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'turn-1',command:'touch /tmp/should-not-run',cwd:process.cwd()}});
 else if(m.id===703)send({jsonrpc:'2.0',id:704,method:'item/fileChange/requestApproval',params:{threadId:thread,turnId:'turn-1',grantRoot:${JSON.stringify(path.join(process.cwd(), 'SHOULD_NOT_WRITE'))}}});
 else if(m.id===704)send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status:'completed'}}});
});
`,
    );
    await chmod(fake, 0o700);
    const remoteCalls: unknown[] = [];
    const runtime: RemoteRuntime = {
      label: 'fixture-host',
      root: '/remote/project',
      call: async (tool, args) => {
        remoteCalls.push({ tool, args });
        return 'remote result';
      },
    };
    const provider = new CodexProvider(
      async () => fake,
      undefined,
      undefined,
      undefined,
      async (command, args) => ({ command, args }),
    );
    const approvals: string[] = [];
    const events: { type: string; name?: string; status?: string }[] = [];
    try {
      const resultPromise = provider.run(
        input(process.cwd(), runtime),
        (event) => {
          if (event.type === 'approval') approvals.push(event.approval.id);
          if (event.type === 'tool') events.push({ type: event.type, name: event.name, status: event.status });
        },
        new AbortController().signal,
      );
      for (let i = 0; i < 200 && approvals.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(approvals).toHaveLength(1);
      await provider.approve(approvals[0]!, 'deny');
      await expect(resultPromise).resolves.toMatchObject({ stopReason: 'completed' });
      expect(remoteCalls).toEqual([]);
      const requests = (await readFile(requestLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const threadStart = requests.find((request) => request.method === 'thread/start')!;
      expect(threadStart.params).toMatchObject({
        sandbox: 'read-only',
        dynamicTools: expect.arrayContaining([expect.objectContaining({ name: 'adelic_remote_exec' })]),
        config: { features: { shell_tool: false, unified_exec: false, code_mode_host: true } },
      });
      expect(requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
        cwd: process.cwd(),
        sandboxPolicy: { type: 'readOnly' },
      });
      const hostileResponse = requests.find((request) => request.id === 702) as {
        result?: { success?: boolean; error?: string; contentItems?: { type: string; text: string }[] };
      };
      expect(hostileResponse.result).toMatchObject({
        success: false,
        error: 'unsupported_or_invalid_remote_tool',
        contentItems: [{ type: 'inputText', text: 'Unsupported or invalid remote tool.' }],
      });
      const localResponse = requests.find((request) => request.id === 703) as {
        result?: { decision?: string };
      };
      expect(localResponse.result).toMatchObject({ decision: 'decline' });
      const localFileResponse = requests.find((request) => request.id === 704) as {
        result?: { decision?: string };
      };
      expect(localFileResponse.result).toMatchObject({ decision: 'decline' });
      const deniedResponse = requests.find((request) => request.id === 701) as {
        result?: { success?: boolean; error?: string; contentItems?: { type: string; text: string }[] };
      };
      expect(deniedResponse.result).toMatchObject({
        success: false,
        error: 'denied_by_user',
        contentItems: [{ type: 'inputText', text: 'Denied by user.' }],
      });
      expect(approvals).toHaveLength(1);
      expect(events).toContainEqual({ type: 'tool', name: 'exec', status: 'pending' });
      expect(events).toContainEqual({ type: 'tool', name: 'exec', status: 'denied' });
      expect(JSON.stringify(requests)).not.toContain('should-not-run');
    } finally {
      await provider.shutdown();
    }
  });

  it('keeps Kiro native tools unavailable and routes bridge calls through local approval', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-remote-kiro-'));
    dirs.push(directory);
    const cwd = path.join(directory, 'workspace');
    await mkdir(cwd);
    const hostileFile = path.join(cwd, 'SHOULD_NOT_EXIST');
    const fake = path.join(cwd, 'kiro.mjs');
    const logSocket = path.join(cwd, 'telemetry.sock');
    await writeFile(
      fake,
      `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import net from 'node:net';
const telemetry=${JSON.stringify(logSocket)};
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const append=(m)=>{const s=net.createConnection(telemetry,()=>s.end(JSON.stringify(m)+'\\n'));};
let session='kiro-remote-session'; let promptId; let servers=[];
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line); append(m);
 if(!m.method){
  if(m.id===51){
   append({permissionDecision:m.result});
   send({jsonrpc:'2.0',id:52,method:'fs/write_text_file',params:{sessionId:session,path:${JSON.stringify(hostileFile)},content:'attack'}});
  }
  else if(m.id===52){
   append({hostileFilesystemResponse:m.error});
   const bridge=servers.find((item)=>item.name==='adelic_remote');
   const socketPath=bridge.env.find((item)=>item.name==='ADELIC_REMOTE_SOCKET').value;
   const socket=net.createConnection(socketPath,()=>socket.write(JSON.stringify({id:'hostile-call',tool:'exec',args:{command:${JSON.stringify(`touch ${hostileFile}`)}}})+'\\n'));
   let data=''; socket.on('data',(chunk)=>{data+=chunk.toString();if(data.includes('\\n')){append({bridgeResult:JSON.parse(data.slice(0,data.indexOf('\\n')))});socket.end();send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});}});
  }
  return;
 }
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{agentCapabilities:{promptCapabilities:{image:false}}}});
 else if(m.method==='session/new'){
  servers=m.params.mcpServers; const agent=JSON.parse(fs.readFileSync(process.env.KIRO_HOME+'/agents/adelic-runtime.json','utf8'));
  append({agent});
  try { fs.writeFileSync(process.cwd()+'/LOCAL_WRITE_SENTINEL','bad'); append({localWrite:'allowed'}); }
  catch { append({localWrite:'blocked'}); }
  send({jsonrpc:'2.0',id:m.id,result:{sessionId:session}});
 }
 else if(m.method==='_kiro.dev/commands/execute')send({jsonrpc:'2.0',id:m.id,result:{data:{servers:servers.map((item)=>({name:item.name}))}}});
 else if(m.method==='session/prompt'){
  promptId=m.id;
   send({jsonrpc:'2.0',id:51,method:'session/request_permission',params:{sessionId:session,title:'Running: local command',toolCall:{kind:'execute',title:'Running: local command',rawInput:{command:${JSON.stringify(`touch ${hostileFile}`)}}},options:[{kind:'allow_once',optionId:'once'}]}});
 }
});
`,
    );
    await chmod(fake, 0o700);
    const prior = process.env.ADELIC_KIRO_BIN;
    process.env.ADELIC_KIRO_BIN = fake;
    const remoteCalls: unknown[] = [];
    const runtime: RemoteRuntime = {
      label: 'fixture-host',
      root: '/remote/project',
      call: async (tool, args) => {
        remoteCalls.push({ tool, args });
        return 'remote result';
      },
    };
    const rows: Record<string, unknown>[] = [];
    const telemetry = net.createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        const newline = data.indexOf('\n');
        if (newline >= 0) {
          try {
            rows.push(JSON.parse(data.slice(0, newline)) as Record<string, unknown>);
          } catch {
            /* malformed fixture telemetry is ignored and fails the assertions below */
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      telemetry.once('error', reject);
      telemetry.listen(logSocket, resolve);
    });
    const provider = new KiroProvider();
    const approvals: string[] = [];
    try {
      const resultPromise = provider.run(
        {
          ...input(cwd, runtime),
          providerId: 'kiro',
          sandbox: 'workspace-write',
        },
        (event) => {
          if (event.type === 'approval') approvals.push(event.approval.id);
        },
        new AbortController().signal,
      );
      for (let i = 0; i < 300 && approvals.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(approvals).toHaveLength(1);
      await provider.approve(approvals[0]!, 'deny');
      await expect(resultPromise).resolves.toMatchObject({ stopReason: 'completed' });
      expect(remoteCalls).toEqual([]);
      const agent = rows.find((row) => row.agent)?.agent as { tools: string[]; allowedTools: string[] } | undefined;
      expect(agent?.tools).toEqual(expect.arrayContaining(['@adelic_remote/exec']));
      expect(agent?.tools).not.toEqual(expect.arrayContaining(['execute_bash', 'fs_read', 'fs_write', 'code']));
      expect(agent?.allowedTools).toEqual(agent?.tools);
      expect(rows.find((row) => row.permissionDecision)?.permissionDecision).toMatchObject({
        outcome: { outcome: 'cancelled' },
      });
      expect(rows.find((row) => row.hostileFilesystemResponse)?.hostileFilesystemResponse).toMatchObject({
        code: -32601,
      });
      expect(rows.find((row) => row.localWrite)?.localWrite).toBe('blocked');
      expect(rows.find((row) => row.bridgeResult)?.bridgeResult).toMatchObject({ ok: false, text: 'Denied by user.' });
      await expect(readFile(hostileFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await provider.shutdown();
      await new Promise<void>((resolve) => telemetry.close(() => resolve()));
      if (prior === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior;
    }
  });

  it('does not configure or mention remote tools when the remote plan disables tools', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-remote-kiro-no-tools-'));
    dirs.push(directory);
    const cwd = path.join(directory, 'workspace');
    await mkdir(cwd);
    const fake = path.join(cwd, 'kiro.mjs');
    const logSocket = path.join(cwd, 'telemetry.sock');
    await writeFile(
      fake,
      `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import net from 'node:net';
const telemetry=${JSON.stringify(logSocket)};
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const append=(m)=>{const s=net.createConnection(telemetry,()=>s.end(JSON.stringify(m)+'\\n'));};
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{agentCapabilities:{promptCapabilities:{image:false}}}});
 else if(m.method==='session/new'){
  const agent=JSON.parse(fs.readFileSync(process.env.KIRO_HOME+'/agents/adelic-runtime.json','utf8'));
  append({agent,session:m.params});
  send({jsonrpc:'2.0',id:m.id,result:{sessionId:'no-tools-session'}});
 }
 else if(m.method==='session/prompt'){
  append({prompt:m.params});
  send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});
 }
});
`,
    );
    await chmod(fake, 0o700);
    const prior = process.env.ADELIC_KIRO_BIN;
    process.env.ADELIC_KIRO_BIN = fake;
    const rows: Record<string, unknown>[] = [];
    const telemetry = net.createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        const newline = data.indexOf('\n');
        if (newline >= 0) rows.push(JSON.parse(data.slice(0, newline)) as Record<string, unknown>);
      });
    });
    await new Promise<void>((resolve, reject) => {
      telemetry.once('error', reject);
      telemetry.listen(logSocket, resolve);
    });
    const remoteCalls: unknown[] = [];
    const runtime: RemoteRuntime = {
      label: 'fixture-host',
      root: '/remote/project',
      call: async (...args) => {
        remoteCalls.push(args);
        return 'unexpected remote call';
      },
    };
    const provider = new KiroProvider();
    try {
      await expect(
        provider.run(
          {
            ...input(cwd, runtime),
            providerId: 'kiro',
            plan: { level: 'deep', reason: 'no tools', tools: false, memory: false, contextBudget: 100 },
          },
          () => undefined,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ stopReason: 'completed' });
      for (let i = 0; i < 50 && rows.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const row = rows.find((item) => item.agent);
      expect(row?.agent).toMatchObject({ tools: [], allowedTools: [], mcpServers: {} });
      expect(row?.session).toMatchObject({ mcpServers: [] });
      expect((rows.find((item) => item.prompt)?.prompt as { prompt?: unknown })?.prompt).not.toContain(
        '[PROJETO REMOTO]',
      );
      expect(remoteCalls).toEqual([]);
    } finally {
      await provider.shutdown();
      await new Promise<void>((resolve) => telemetry.close(() => resolve()));
      if (prior === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior;
    }
  });
});
