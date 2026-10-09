import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { CodexProvider } from '../server/providers/codex';
import { createLocalExecutor, preflightLocalExecutor } from '../server/local-executor';
import { KiroProvider } from '../server/providers/kiro';
import {
  boundedRemoteResult,
  executorContextInstructions,
  REMOTE_TOOL_SPECS,
  remoteApprovalDetail,
  remoteToolDescription,
  remoteToolError,
  remoteToolFailure,
  validateRemoteArguments,
} from '../server/providers/remote-tools';
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
  it('preserves complete bounded JSON results and returns actionable recovery for oversized values', () => {
    const page = { content: 'á😀"\\'.repeat(7000), offset: 0, nextOffset: 28000, truncated: true, revision: 'rev-1' };
    const serialized = boundedRemoteResult(page);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(JSON.parse(serialized)).toEqual(page);
    const oversized = JSON.parse(boundedRemoteResult({ content: 'x'.repeat(1000) }, 100)) as {
      error: string;
      resultBytes: number;
      maxResultBytes: number;
      recovery: string;
    };
    expect(oversized).toMatchObject({
      error: 'tool result exceeds model transport limit',
      resultBytes: expect.any(Number),
      maxResultBytes: 100,
    });
    expect(oversized.resultBytes).toBeGreaterThan(100);
    expect(oversized.recovery).toContain('nextOffset');
  });

  it('paginates through the local factory, Codex provider and model transport across fresh runners', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-local-provider-pages-'));
    dirs.push(directory);
    const workspace = path.join(directory, 'workspace');
    await mkdir(workspace);
    const source = 'á😀'.repeat(40_000);
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(128 * 1024);
    await writeFile(path.join(workspace, 'large.txt'), source, 'utf8');
    const preflight = await preflightLocalExecutor(workspace);
    expect(preflight.ready, JSON.stringify(preflight.issues)).toBe(true);
    const runtime = await createLocalExecutor(workspace, 'workspace-write');
    const requestLog = path.join(directory, 'model-results.jsonl');
    const fake = path.join(directory, 'codex.mjs');
    await writeFile(
      fake,
      `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const log=${JSON.stringify(requestLog)};
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
const append=(value)=>fs.appendFileSync(log,JSON.stringify(value)+'\\n');
let nextId=701; let thread='page-thread'; let offset=0; let revision;
const ask=()=>send({jsonrpc:'2.0',id:nextId++,method:'item/tool/call',params:{threadId:thread,turnId:'page-turn',callId:'page-'+offset,tool:'adelic_remote_read_file',arguments:{path:'large.txt',offset,limit:49152,...(revision?{revision}:{})}}});
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});
 else if(m.method==='config/read')send({jsonrpc:'2.0',id:m.id,result:{config:{mcp_servers:{}}}});
 else if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:thread}}});
 else if(m.method==='turn/start'){
  send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'page-turn'}}});
  send({jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id:'page-turn'}}});
  ask();
 } else if(Number.isInteger(m.id)&&m.id>=701){
  const text=m.result?.contentItems?.[0]?.text;
  let page;
  try { page=JSON.parse(text); } catch { append({invalid:text}); return; }
  append(page);
  offset=page.nextOffset; revision=page.revision;
  if(page.truncated) ask();
  else send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:'page-turn',status:'completed'}}});
 }
});
`,
      { mode: 0o700 },
    );
    const provider = new CodexProvider(
      async () => fake,
      undefined,
      undefined,
      undefined,
      async (command, args) => ({ command, args }),
    );
    const approvals: string[] = [];
    try {
      const resultPromise = provider.run(
        input(workspace, runtime),
        (event) => {
          if (event.type === 'approval') {
            approvals.push(event.approval.id);
            void provider.approve(event.approval.id, 'approve');
          }
        },
        new AbortController().signal,
      );
      await expect(resultPromise).resolves.toMatchObject({ stopReason: 'completed' });
      const pages = (await readFile(requestLog, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              content: string;
              offset: number;
              nextOffset: number;
              totalBytes: number;
              truncated: boolean;
              revision: string;
            },
        );
      expect(approvals.length).toBeGreaterThan(1);
      expect(pages.length).toBeGreaterThan(2);
      expect(pages.map((page) => page.offset)).toEqual(expect.arrayContaining([0, 49152, 98304]));
      expect(pages.at(-1)?.truncated).toBe(false);
      expect(pages.map((page) => page.content).join('')).toBe(source);
      expect(pages.every((page) => page.totalBytes === Buffer.byteLength(source, 'utf8'))).toBe(true);
      expect(pages.every((page) => page.revision.length > 0)).toBe(true);

      const firstPage = (await runtime.call(
        'read_file',
        { path: 'large.txt', offset: 0, limit: 49_152 },
        new AbortController().signal,
      )) as { nextOffset: number; revision: string };
      await writeFile(path.join(workspace, 'large.txt'), source.replaceAll('á', 'ç'), 'utf8');
      await expect(
        runtime.call(
          'read_file',
          { path: 'large.txt', offset: firstPage.nextOffset, limit: 49_152, revision: firstPage.revision },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ category: 'conflict', message: 'file changed while reading' });
      const prefix = 'contexto-á😀\n'.repeat(15_000);
      const oldText = 'EDITAR-ß🧪-único';
      const suffix = '\nfinal-ç🚀'.repeat(15_000);
      const largeEdit = oldText + prefix + suffix;
      expect(Buffer.byteLength(largeEdit, 'utf8')).toBeGreaterThan(128 * 1024);
      await writeFile(path.join(workspace, 'large-edit.txt'), largeEdit, 'utf8');
      const editPage = (await runtime.call(
        'read_file',
        { path: 'large-edit.txt', offset: 0, limit: 49_152 },
        new AbortController().signal,
      )) as { revision: string; truncated: boolean; content: string };
      expect(editPage.truncated).toBe(true);
      expect(editPage.content).toContain(oldText);
      await expect(
        runtime.call(
          'replace_text',
          { path: 'large-edit.txt', oldText, newText: 'corrigido-ø🚀', expectedRevision: editPage.revision },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ matches: 1 });
      expect(await readFile(path.join(workspace, 'large-edit.txt'), 'utf8')).toBe('corrigido-ø🚀' + prefix + suffix);
      await expect(
        runtime.call(
          'replace_text',
          { path: 'large-edit.txt', oldText: 'corrigido-ø🚀', newText: 'stale', expectedRevision: editPage.revision },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ category: 'conflict', message: 'file changed before edit' });
      await writeFile(path.join(workspace, 'legacy-edit.txt'), 'antes-á😀-legacy', 'utf8');
      await runtime.call('read_file', { path: 'legacy-edit.txt' }, new AbortController().signal);
      await expect(
        runtime.call(
          'replace_text',
          { path: 'legacy-edit.txt', oldText: 'antes-á😀', newText: 'depois-ø🚀' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ matches: 1 });
      expect(await readFile(path.join(workspace, 'legacy-edit.txt'), 'utf8')).toBe('depois-ø🚀-legacy');
    } finally {
      await runtime.close();
      await provider.shutdown();
    }
  });
  it('derives executor guidance from provider, runtime and effective sandbox permissions', () => {
    const base = {
      executorContext: { git: 'available' as const, checks: ['npm test', 'npm test'] },
      approvalMode: 'manual' as const,
      plan: { level: 'deep' as const, reason: 'test', tools: true, memory: false, contextBudget: 100 },
    };
    const codexWrite = executorContextInstructions({
      ...base,
      providerId: 'codex',
      sandbox: 'workspace-write',
      remote: { label: 'local', root: '/p', executionKind: 'isolated-local', call: async () => undefined },
    });
    expect(codexWrite).toContain('workspace-write');
    expect(codexWrite).toContain('ferramentas nativas Codex em read-only');
    expect(codexWrite).toContain('Modo de aprovação efetivo: manual');
    expect(codexWrite).toContain('Git do checkout principal não é herdada');
    expect(codexWrite).toContain('/var/tmp são scratch privados');
    expect(codexWrite).not.toContain('npm test, npm test');
    const codexReadOnly = executorContextInstructions({
      ...base,
      providerId: 'codex',
      sandbox: 'read-only',
      remote: { label: 'ssh', root: '/p', executionKind: 'ssh', call: async () => undefined },
    });
    expect(codexReadOnly).toContain('somente leitura');
    expect(codexReadOnly).toContain('ferramentas nativas Codex em read-only');
    const kiroWrite = executorContextInstructions({
      ...base,
      providerId: 'kiro',
      sandbox: 'workspace-write',
      remote: { label: 'ssh', root: '/p', executionKind: 'ssh', call: async () => undefined },
    });
    expect(kiroWrite).toContain('workspace-write');
    expect(kiroWrite).not.toContain('nativas Codex');
    const kiroReadOnly = executorContextInstructions({
      ...base,
      providerId: 'kiro',
      sandbox: 'read-only',
      remote: { label: 'ssh', root: '/p', executionKind: 'ssh', call: async () => undefined },
    });
    expect(kiroReadOnly).toContain('somente leitura');
    expect(kiroReadOnly).not.toContain('nativas Codex');
    const localOnly = executorContextInstructions({ ...base, providerId: 'opencode', sandbox: 'read-only' });
    expect(localOnly).toContain('Não há executor');
    expect(localOnly).not.toContain('workspace-write configurado');
    expect(localOnly).not.toContain('Codex nativo');
    expect(
      executorContextInstructions({
        ...base,
        executorContext: { git: 'unavailable', checks: [] },
        providerId: 'claude',
        sandbox: 'workspace-write',
      }),
    ).toContain('não execute comandos Git');
    expect(
      executorContextInstructions({
        ...base,
        executorContext: { git: 'unknown', checks: [] },
        providerId: 'claude',
        sandbox: 'workspace-write',
      }),
    ).toContain('não foi verificada');
    const noTools = executorContextInstructions({
      ...base,
      plan: { ...base.plan, tools: false },
      providerId: 'codex',
      sandbox: 'workspace-write',
      remote: { label: 'ssh', root: '/p', executionKind: 'ssh', call: async () => undefined },
    });
    expect(noTools).toContain('ferramentas estão desativadas');
    expect(noTools).not.toContain('workspace-write: operações mutantes');
    expect(noTools).not.toContain('ferramentas nativas Codex em read-only');
    const diagnose = REMOTE_TOOL_SPECS.find((tool) => tool.remoteName === 'diagnose')!;
    expect(validateRemoteArguments(diagnose, {})).toEqual({});
    expect(validateRemoteArguments(diagnose, { command: 'install' })).toBeUndefined();
  });

  it('explains HTTP 409 and read-only policy refusals without suggesting argument retries', () => {
    const refusal = remoteToolError(Object.assign(new Error('read-only policy'), { status: 409 }));
    expect(refusal).toContain('política somente leitura');
    expect(refusal).not.toContain('corrija os argumentos');
    const localRefusal = remoteToolError(new Error('A ferramenta de escrita está desativada no modo somente leitura.'));
    expect(localRefusal).toContain('operação não é permitida');
    expect(localRefusal).not.toContain('Argumentos inválidos');
    const httpRefusal = remoteToolError(Object.assign(new Error('conflict'), { status: 409 }));
    expect(httpRefusal).toContain('política do executor');
    expect(httpRefusal).not.toContain('tente novamente');
  });

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
    const readFile = REMOTE_TOOL_SPECS.find((tool) => tool.remoteName === 'read_file')!;
    expect(validateRemoteArguments(readFile, { path: 'server/orchestrator.ts' })).toEqual({
      path: 'server/orchestrator.ts',
    });
    const page = { path: 'server/orchestrator.ts', offset: 48_000, limit: 49_152 };
    expect(validateRemoteArguments(readFile, page)).toEqual(page);
    expect(validateRemoteArguments(readFile, { ...page, offset: -1 })).toBeUndefined();
    expect(validateRemoteArguments(readFile, { ...page, limit: 49_153 })).toBeUndefined();
    expect(validateRemoteArguments(readFile, { ...page, fullPath: '/outside' })).toBeUndefined();
    const replace = REMOTE_TOOL_SPECS.find((tool) => tool.remoteName === 'replace_text')!;
    const revision = '1:2:300000:400000:500000';
    expect(
      validateRemoteArguments(replace, {
        path: 'large.txt',
        oldText: 'antes',
        newText: 'depois',
        expectedRevision: revision,
      }),
    ).toEqual({ path: 'large.txt', oldText: 'antes', newText: 'depois', expectedRevision: revision });
    expect(
      validateRemoteArguments(replace, {
        path: 'large.txt',
        oldText: 'antes',
        newText: 'depois',
        readRevision: revision,
      }),
    ).toEqual({ path: 'large.txt', oldText: 'antes', newText: 'depois', readRevision: revision });
    expect(
      validateRemoteArguments(replace, {
        path: 'large.txt',
        oldText: 'antes',
        newText: 'depois',
        expectedRevision: revision,
        readRevision: 'stale',
      }),
    ).toBeUndefined();
    expect(validateRemoteArguments(replace, { path: 'README.md', oldText: 'before', newText: 'after' })).toEqual({
      path: 'README.md',
      oldText: 'before',
      newText: 'after',
    });
    expect(validateRemoteArguments(replace, { path: 'README.md', oldText: '', newText: 'after' })).toBeUndefined();
    expect(
      validateRemoteArguments(replace, {
        path: 'README.md',
        oldText: '😀'.repeat(32 * 1024 + 1),
        newText: 'after',
      }),
    ).toBeUndefined();
    expect(remoteApprovalDetail(runtime, write, args)).toContain(
      'Host: build-host (builder@example.test)\nDiretório remoto: /srv/work/adelic\nFerramenta: write_file\nArgumentos: {"path":"README.md","content":"remote change"}',
    );
    const largeArgs = { path: 'src/large.ts', content: 'line\n'.repeat(25_000) };
    expect(validateRemoteArguments(write, largeArgs)).toEqual(largeArgs);
    expect(remoteApprovalDetail(runtime, write, largeArgs)).toContain(JSON.stringify(largeArgs));
    expect(remoteToolDescription(runtime, write, args)).toBe(
      'write_file: README.md\nHost build-host (builder@example.test): /srv/work/adelic',
    );
    expect(remoteToolFailure({ error: 'tool result exceeds model transport limit' })).toContain(
      'nextOffset e revision',
    );
    expect(remoteToolFailure({ exitCode: 7, stdout: 'PRIVATE', stderr: 'PRIVATE' })).toBe('Falhou (código 7)');
    expect(remoteToolFailure({ exitCode: 0, stdout: '', stderr: '' })).toBeUndefined();
    const longFailure = remoteToolDescription(
      { ...runtime, label: 'host'.repeat(200), root: '/root/'.repeat(100) },
      REMOTE_TOOL_SPECS[0]!,
      { command: 'command '.repeat(100) },
      'Falhou (código 17)',
    );
    expect(longFailure).toContain('Falhou (código 17)');
    expect(longFailure.length).toBeLessThanOrEqual(280);
    const connectionFailure = remoteToolError(
      Object.assign(new Error('ssh ECONNRESET PRIVATE'), { code: 'ECONNRESET' }),
    );
    expect(connectionFailure).toContain('ECONNRESET');
    expect(connectionFailure).toContain('confira host, porta e executor');
    expect(connectionFailure).not.toContain('PRIVATE');
    expect(remoteToolError(Object.assign(new Error('secret command'), { code: 'ENOENT' }))).toContain(
      'ferramenta instalada',
    );
    expect(remoteToolError(Object.assign(new Error('path'), { code: 'EACCES' }))).toContain('Permissão negada');
    expect(remoteToolError(Object.assign(new Error('opaque raw credential'), { category: 'not_found' }))).toContain(
      'Não encontrado',
    );
    expect(
      remoteToolError(Object.assign(new Error('file exceeds read limit'), { category: 'invalid_request' })),
    ).toContain('offset/limit');
    expect(
      remoteToolError(Object.assign(new Error('oldText must match exactly once'), { category: 'conflict' })),
    ).toContain('trecho único');
    expect(
      remoteToolError(Object.assign(new Error('opaque raw credential'), { category: 'invalid_request' })),
    ).toContain('Argumentos inválidos');
    expect(
      remoteToolError(Object.assign(new Error('opaque raw credential'), { category: 'invalid_request' })),
    ).not.toContain('opaque raw credential');
    expect(
      remoteToolError(Object.assign(new Error('opaque raw credential'), { category: 'secret-category' })),
    ).not.toContain('opaque raw credential');
    expect(remoteToolError(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }))).toContain('aumente timeoutMs');
    expect(remoteToolError(Object.assign(new Error('rate limited'), { status: 429 }))).toContain('aguarde');
    expect(remoteToolError(Object.assign(new Error('private detail'), { code: 'PRIVATE_SECRET_123' }))).not.toContain(
      'PRIVATE_SECRET_123',
    );
    expect(remoteToolError(new Error('unavailable'))).not.toContain('causa retornada');
    const visibleFailure = remoteToolDescription(runtime, write, args, connectionFailure);
    expect(visibleFailure).toContain('confira host, porta e executor');
    expect(visibleFailure.length).toBeLessThanOrEqual(280);
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
    const approvals: { id: string; command?: string }[] = [];
    const events: { type: string; name?: string; status?: string; toolCallId?: string; description?: string }[] = [];
    try {
      const resultPromise = provider.run(
        input(process.cwd(), runtime),
        (event) => {
          if (event.type === 'approval') approvals.push({ id: event.approval.id, command: event.approval.command });
          if (event.type === 'tool')
            events.push({
              type: event.type,
              name: event.name,
              status: event.status,
              toolCallId: event.toolCallId,
              description: event.description,
            });
        },
        new AbortController().signal,
      );
      for (let i = 0; i < 200 && approvals.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(approvals).toHaveLength(1);
      await provider.approve(approvals[0]!.id, 'deny');
      await expect(resultPromise).resolves.toMatchObject({ stopReason: 'completed' });
      expect(remoteCalls).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({
          name: 'exec',
          status: 'pending',
          toolCallId: 'call-remote',
          description: expect.stringMatching(/^exec: uname -a\nHost fixture-host:/),
        }),
        expect.objectContaining({
          name: 'exec',
          status: 'denied',
          toolCallId: 'call-remote',
          description: expect.stringMatching(/^exec: uname -a\nHost fixture-host:/),
        }),
      ]);
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
      expect(approvals[0]).toMatchObject({ command: 'uname -a' });
      expect(events).toContainEqual(
        expect.objectContaining({ name: 'exec', status: 'pending', toolCallId: 'call-remote' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ name: 'exec', status: 'denied', toolCallId: 'call-remote' }),
      );
      expect(JSON.stringify(requests)).not.toContain('should-not-run');
    } finally {
      await provider.shutdown();
    }
  });

  it('keeps Kiro native tools unavailable and shows approved bridge calls as running', async () => {
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
const append=(m,done)=>{const s=net.createConnection(telemetry,()=>s.end(JSON.stringify(m)+'\\n',done));};
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
   let data=''; socket.on('data',(chunk)=>{data+=chunk.toString();if(data.includes('\\n')){append({bridgeResult:JSON.parse(data.slice(0,data.indexOf('\\n')))},()=>send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}}));socket.end();}});
  }
  return;
 }
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{agentCapabilities:{promptCapabilities:{image:false}}}});
 else if(m.method==='session/new'){
  servers=m.params.mcpServers; const agent=JSON.parse(fs.readFileSync(process.env.KIRO_HOME+'/agents/adelic-runtime.json','utf8'));
  append({agent,session:m.params});
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
    let releaseRemote!: () => void;
    let remoteCallStarted!: () => void;
    const enteredRemoteCall = new Promise<void>((resolve) => (remoteCallStarted = resolve));
    const runtime: RemoteRuntime = {
      label: 'fixture-host',
      root: '/remote/project',
      call: async (tool, args) => {
        remoteCalls.push({ tool, args });
        return new Promise((resolve) => {
          releaseRemote = () => resolve('remote result');
          remoteCallStarted();
        });
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
    const toolEvents: { name: string; status: string; description: string; toolCallId?: string }[] = [];
    try {
      const resultPromise = provider.run(
        {
          ...input(cwd, runtime),
          providerId: 'kiro',
          sandbox: 'workspace-write',
        },
        (event) => {
          if (event.type === 'approval') approvals.push(event.approval.id);
          if (event.type === 'tool') toolEvents.push(event);
        },
        new AbortController().signal,
      );
      for (let i = 0; i < 300 && approvals.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(approvals).toHaveLength(1);
      const approval = provider.approve(approvals[0]!, 'approve');
      await enteredRemoteCall;
      expect(toolEvents[0]?.toolCallId).toBeTruthy();
      expect(toolEvents.map((event) => [event.status, event.toolCallId])).toEqual([
        ['pending', toolEvents[0]?.toolCallId],
        ['running', toolEvents[0]?.toolCallId],
      ]);
      releaseRemote();
      await approval;
      await expect(resultPromise).resolves.toMatchObject({ stopReason: 'completed' });
      expect(remoteCalls).toEqual([{ tool: 'exec', args: { command: `touch ${hostileFile}` } }]);
      expect(toolEvents).toHaveLength(3);
      expect(toolEvents.map((event) => [event.status, event.toolCallId])).toEqual([
        ['pending', expect.any(String)],
        ['running', toolEvents[0]?.toolCallId],
        ['completed', toolEvents[0]?.toolCallId],
      ]);
      expect(toolEvents[0]?.description).toMatch(/^exec: touch .*\nHost fixture-host:/);
      const agent = rows.find((row) => row.agent)?.agent as
        | {
            tools: string[];
            allowedTools: string[];
            mcpServers: Record<string, { env: Record<string, string> }>;
          }
        | undefined;
      const session = rows.find((row) => row.agent)?.session as
        { mcpServers: { name: string; env: { name: string; value: string }[] }[] } | undefined;
      expect(agent?.tools).toEqual(expect.arrayContaining(['@adelic_remote/exec']));
      expect(agent?.tools).not.toEqual(expect.arrayContaining(['execute_bash', 'fs_read', 'fs_write', 'code']));
      expect(agent?.allowedTools).toEqual(agent?.tools);
      expect(agent?.mcpServers.adelic_remote.env.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(session?.mcpServers).toContainEqual(
        expect.objectContaining({
          name: 'adelic_remote',
          env: expect.arrayContaining([{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]),
        }),
      );
      expect(rows.find((row) => row.permissionDecision)?.permissionDecision).toMatchObject({
        outcome: { outcome: 'cancelled' },
      });
      expect(rows.find((row) => row.hostileFilesystemResponse)?.hostileFilesystemResponse).toMatchObject({
        code: -32601,
      });
      expect(rows.find((row) => row.localWrite)?.localWrite).toBe('blocked');
      await vi.waitFor(() =>
        expect(rows.find((row) => row.bridgeResult)?.bridgeResult).toMatchObject({ ok: true, text: 'remote result' }),
      );
      await expect(readFile(hostileFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseRemote?.();
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
const append=(m)=>new Promise((resolve,reject)=>{
 const s=net.createConnection(telemetry);
 let response='';
 s.once('error',reject);
 s.on('data',(chunk)=>{response+=chunk.toString();if(response.includes('\\n'))resolve();});
 s.once('connect',()=>s.end(JSON.stringify(m)+'\\n'));
});
readline.createInterface({input:process.stdin}).on('line',async (line)=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{agentCapabilities:{promptCapabilities:{image:false}}}});
 else if(m.method==='session/new'){
  const agent=JSON.parse(fs.readFileSync(process.env.KIRO_HOME+'/agents/adelic-runtime.json','utf8'));
  await append({agent,session:m.params});
  send({jsonrpc:'2.0',id:m.id,result:{sessionId:'no-tools-session'}});
 }
 else if(m.method==='session/prompt'){
  await append({prompt:m.params});
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
        if (newline >= 0) {
          rows.push(JSON.parse(data.slice(0, newline)) as Record<string, unknown>);
          socket.end('ok\n');
        }
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
      const promptRow = rows.find((item) => item.prompt);
      expect(promptRow).toBeDefined();
      expect((promptRow?.prompt as { prompt?: unknown }).prompt).not.toContain('[PROJETO REMOTO]');
      expect(remoteCalls).toEqual([]);
    } finally {
      await provider.shutdown();
      await new Promise<void>((resolve) => telemetry.close(() => resolve()));
      if (prior === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior;
    }
  });

  it('auto-approves fixed SSH and isolated local tools only in an automatic run', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-remote-automatic-'));
    dirs.push(directory);
    const fake = path.join(directory, 'codex.mjs');
    await writeFile(
      fake,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const thread='remote-automatic-thread';
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});
 else if(m.method==='config/read')send({jsonrpc:'2.0',id:m.id,result:{config:{mcp_servers:{}}}});
 else if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:thread}}});
 else if(m.method==='turn/start'){
  send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',id:701,method:'item/tool/call',params:{threadId:thread,turnId:'turn-1',callId:'exec-call',tool:'adelic_remote_exec',arguments:{command:'npm test'}}});
 }
 else if(m.id===701)send({jsonrpc:'2.0',id:702,method:'item/tool/call',params:{threadId:thread,turnId:'turn-1',callId:'write-call',tool:'adelic_remote_write_file',arguments:{path:'README.md',content:'updated remotely'}}});
 else if(m.id===702)send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status:'completed'}}});
});
`,
    );
    await chmod(fake, 0o700);
    const calls: { tool: string; args: unknown }[] = [];
    const toolEvents: { name: string; description: string; status: string; toolCallId?: string }[] = [];
    const runtime: RemoteRuntime = {
      label: 'explicit-build-host',
      root: '/srv/work/project',
      executionKind: 'ssh',
      call: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === 'exec') return { exitCode: 7, stdout: 'PRIVATE OUTPUT', stderr: 'PRIVATE STDERR' };
        return 'completed';
      },
    };
    const runAutomatic = async (executor: RemoteRuntime) => {
      const provider = new CodexProvider(
        async () => fake,
        undefined,
        undefined,
        undefined,
        async (command, args) => ({ command, args }),
      );
      const approvals: { status: string; decision?: unknown; detail: string }[] = [];
      try {
        await expect(
          provider.run(
            { ...input(process.cwd(), executor), approvalMode: 'automatic' },
            (event) => {
              if (event.type === 'tool') toolEvents.push(event);
              if (event.type === 'approval')
                approvals.push({
                  status: event.approval.status,
                  decision: event.approval.decision,
                  detail: event.approval.detail,
                });
            },
            new AbortController().signal,
          ),
        ).resolves.toMatchObject({ stopReason: 'completed' });
        return approvals;
      } finally {
        await provider.shutdown();
      }
    };
    const sshApprovals = await runAutomatic(runtime);
    const localApprovals = await runAutomatic({
      label: 'Local isolado',
      root: '/workspace',
      executionKind: 'isolated-local',
      call: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === 'exec') return { exitCode: 7, stdout: 'PRIVATE OUTPUT', stderr: 'PRIVATE STDERR' };
        return 'completed';
      },
    });
    expect(calls.map(({ tool }) => tool)).toEqual(['exec', 'write_file', 'exec', 'write_file']);
    expect(toolEvents.filter((event) => event.name === 'exec')).toEqual([
      expect.objectContaining({
        status: 'running',
        toolCallId: 'exec-call',
        description: expect.stringMatching(/^exec: npm test\nHost explicit-build-host:/),
      }),
      expect.objectContaining({
        status: 'failed',
        toolCallId: 'exec-call',
        description: expect.stringContaining('Falhou (código 7)'),
      }),
      expect.objectContaining({
        status: 'running',
        toolCallId: 'exec-call',
        description: expect.stringMatching(/^exec: npm test\nExecutor local isolado:/),
      }),
      expect.objectContaining({
        status: 'failed',
        toolCallId: 'exec-call',
        description: expect.stringContaining('Falhou (código 7)'),
      }),
    ]);
    expect(toolEvents.every((event) => !event.description.includes('PRIVATE'))).toBe(true);
    expect(sshApprovals).toHaveLength(2);
    expect(sshApprovals.every((item) => item.status === 'approved')).toBe(true);
    expect(
      sshApprovals.every((item) => (item.decision as { rule: string }).rule === 'explicit-remote-project-opt-in'),
    ).toBe(true);
    expect(localApprovals).toHaveLength(2);
    expect(localApprovals.every((item) => item.status === 'approved')).toBe(true);
    expect(localApprovals.every((item) => (item.decision as { rule: string }).rule === 'isolated-local-executor')).toBe(
      true,
    );
    expect(
      [...sshApprovals, ...localApprovals].every(({ detail }) => detail.includes('[redigidos no registro automático]')),
    ).toBe(true);
    expect([...sshApprovals, ...localApprovals].every(({ detail }) => !detail.includes('updated remotely'))).toBe(true);
  });

  it('shows a manual remote tool as running while the approved call is still pending', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-remote-approved-running-'));
    dirs.push(directory);
    const fake = path.join(directory, 'codex.mjs');
    await writeFile(
      fake,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const thread='approved-running-thread';
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});
 else if(m.method==='config/read')send({jsonrpc:'2.0',id:m.id,result:{config:{mcp_servers:{}}}});
 else if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:thread}}});
 else if(m.method==='turn/start'){
  send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',id:701,method:'item/tool/call',params:{threadId:thread,turnId:'turn-1',callId:'manual-call',tool:'adelic_remote_exec',arguments:{command:'find src -type f'}}});
 }
 else if(m.id===701)send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status:'completed'}}});
});
`,
    );
    await chmod(fake, 0o700);
    let release!: () => void;
    let callStarted!: () => void;
    const enteredCall = new Promise<void>((resolve) => (callStarted = resolve));
    const runtime: RemoteRuntime = {
      label: 'slow-host',
      root: '/remote/project',
      call: async () =>
        new Promise((resolve) => {
          release = () => resolve({ exitCode: 0, stdout: 'done', stderr: '' });
          callStarted();
        }),
    };
    const provider = new CodexProvider(
      async () => fake,
      undefined,
      undefined,
      undefined,
      async (command, args) => ({ command, args }),
    );
    const approvals: string[] = [];
    const tools: { status: string; toolCallId?: string }[] = [];
    try {
      const result = provider.run(
        input(process.cwd(), runtime),
        (event) => {
          if (event.type === 'approval') approvals.push(event.approval.id);
          if (event.type === 'tool') tools.push(event);
        },
        new AbortController().signal,
      );
      for (let i = 0; i < 200 && approvals.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(approvals).toHaveLength(1);
      const approved = provider.approve(approvals[0]!, 'approve');
      await enteredCall;
      expect(tools.map(({ status, toolCallId }) => [status, toolCallId])).toEqual([
        ['pending', 'manual-call'],
        ['running', 'manual-call'],
      ]);
      release();
      await approved;
      await expect(result).resolves.toMatchObject({ stopReason: 'completed' });
      expect(tools.at(-1)).toMatchObject({ status: 'completed', toolCallId: 'manual-call' });
    } finally {
      release?.();
      await provider.shutdown();
    }
  });

  it('denies blocked remote commands before approval or execution in Codex and Kiro', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-remote-blocked-'));
    dirs.push(directory);
    const fakeCodex = path.join(directory, 'codex.mjs');
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const thread='blocked-thread';
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});
 else if(m.method==='config/read')send({jsonrpc:'2.0',id:m.id,result:{config:{mcp_servers:{}}}});
 else if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:thread}}});
 else if(m.method==='turn/start'){
  send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',method:'turn/started',params:{threadId:thread,turn:{id:'turn-1'}}});
  send({jsonrpc:'2.0',id:701,method:'item/tool/call',params:{threadId:thread,turnId:'turn-1',callId:'blocked-call',tool:'adelic_remote_exec',arguments:{command:'rm -rf *'}}});
 }
 else if(m.id===701)send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status:'completed'}}});
});
`,
    );
    const fakeKiro = path.join(directory, 'kiro.mjs');
    await writeFile(
      fakeKiro,
      `#!/usr/bin/env node
import readline from 'node:readline';
import net from 'node:net';
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
let servers=[];
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{agentCapabilities:{promptCapabilities:{image:false}}}});
 else if(m.method==='session/new'){servers=m.params.mcpServers;send({jsonrpc:'2.0',id:m.id,result:{sessionId:'blocked-session'}});}
 else if(m.method==='_kiro.dev/commands/execute')send({jsonrpc:'2.0',id:m.id,result:{data:{servers:servers.map((item)=>({name:item.name}))}}});
 else if(m.method==='session/prompt'){
  const bridge=servers.find((item)=>item.name==='adelic_remote');
  const socketPath=bridge.env.find((item)=>item.name==='ADELIC_REMOTE_SOCKET').value;
  const socket=net.createConnection(socketPath,()=>socket.write(JSON.stringify({id:'blocked-call',tool:'exec',args:{command:'rm -rf *'}})+'\\n'));
  let data='';socket.on('data',(chunk)=>{data+=chunk.toString();if(data.includes('\\n')){send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});socket.end();}});
 }
});
`,
    );
    await Promise.all([chmod(fakeCodex, 0o700), chmod(fakeKiro, 0o700)]);
    const priorKiro = process.env.ADELIC_KIRO_BIN;
    process.env.ADELIC_KIRO_BIN = fakeKiro;
    const calls: unknown[] = [];
    const runtime: RemoteRuntime = {
      label: 'blocked-host',
      root: '/remote/project',
      executionKind: 'ssh',
      call: async (...args) => {
        calls.push(args);
        return 'must not execute';
      },
    };
    const scenarios = [
      { provider: 'codex' as const, mode: 'automatic' as const },
      { provider: 'codex' as const, mode: 'manual' as const },
      { provider: 'kiro' as const, mode: 'automatic' as const },
      { provider: 'kiro' as const, mode: 'manual' as const },
    ];
    try {
      for (const scenario of scenarios) {
        const approvals: Record<string, unknown>[] = [];
        const tools: Record<string, unknown>[] = [];
        const provider =
          scenario.provider === 'codex'
            ? new CodexProvider(
                async () => fakeCodex,
                undefined,
                undefined,
                undefined,
                async (command, args) => ({ command, args }),
              )
            : new KiroProvider();
        try {
          await expect(
            provider.run(
              {
                ...input(directory, runtime),
                providerId: scenario.provider,
                approvalMode: scenario.mode,
                blockedCommands: ['rm *'],
              },
              (event) => {
                if (event.type === 'approval') approvals.push(event.approval as unknown as Record<string, unknown>);
                if (event.type === 'tool') tools.push(event as unknown as Record<string, unknown>);
              },
              new AbortController().signal,
            ),
          ).resolves.toMatchObject({ stopReason: 'completed' });
          expect(approvals).toHaveLength(1);
          expect(approvals[0]).toMatchObject({
            status: 'denied',
            command: 'rm -rf *',
            blocked: 'rm *',
            decision: { source: 'project-rule', rule: 'blocked-command' },
          });
          expect(tools).toContainEqual(expect.objectContaining({ name: 'exec', status: 'denied' }));
        } finally {
          await provider.shutdown();
        }
      }
      expect(calls).toEqual([]);
    } finally {
      if (priorKiro === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = priorKiro;
    }
  });
});
