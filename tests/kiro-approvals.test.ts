// Kiro ACP auto-approval (docs/specs/safe-command-approvals.md#kiro): a fake ACP agent sends the
// Kiro 2.23 permission payload; safe shell commands get allow_once, the rest stay pending and
// project blocked commands are denied before any automatic decision.
import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KiroProvider, kiroEnvironment, kiroShellCommand, kiroShellNeutral } from '../server/providers/kiro';
import type { Approval, RunInput } from '../shared/contracts';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const permission = (command: string) => ({
  toolCallId: `tc-${command}`,
  title: `Running: ${command}`,
  rawInput: { command, __tool_use_purpose: 'test' },
});
const OPTIONS = [
  { kind: 'allow_once', optionId: 'once', name: 'Yes' },
  { kind: 'allow_always', optionId: 'always', name: 'Always' },
  { kind: 'reject_once', optionId: 'reject', name: 'No' },
];

describe('Kiro permission payload', () => {
  it('extracts the command only from an unambiguous shell tool call', () => {
    expect(kiroShellCommand({ toolCall: permission('ls -la') })).toBe('ls -la');
    expect(kiroShellCommand({ toolCall: { ...permission('ls'), kind: 'execute' } })).toBe('ls');
    expect(kiroShellCommand({ toolCall: { ...permission('ls'), kind: 'edit' } })).toBeUndefined();
    expect(kiroShellCommand({ toolCall: { ...permission('ls'), title: 'Writing: x' } })).toBeUndefined();
    expect(
      kiroShellCommand({ toolCall: { ...permission('ls'), rawInput: { command: 'ls', working_dir: '/' } } }),
    ).toBeUndefined();
    expect(kiroShellCommand({ toolCall: { title: 'Running: ls', rawInput: { command: 1 } } })).toBeUndefined();
    expect(kiroShellCommand({})).toBeUndefined();
  });
  it('auto-approves only under a bash/sh shell without Kiro shell overrides', () => {
    expect(kiroShellNeutral({ SHELL: '/usr/bin/bash' })).toBe(true);
    expect(kiroShellNeutral({})).toBe(true);
    expect(kiroShellNeutral({ SHELL: '/usr/bin/zsh' })).toBe(false);
    expect(kiroShellNeutral({ SHELL: '/bin/bash', KIRO_CHAT_SHELL: '/bin/zsh' })).toBe(false);
  });
  it('neutralizes inherited shell startup hooks', () => {
    const env = kiroEnvironment(
      { PATH: '/usr/bin', BASH_ENV: '/tmp/x', 'BASH_FUNC_ls%%': '() { rm; }', SHELLOPTS: 'x' },
      '/h',
    );
    expect(env).toMatchObject({ PATH: '/usr/bin', BASH_ENV: '/dev/null', ENV: '/dev/null', KIRO_HOME: '/h' });
    expect(env['BASH_FUNC_ls%%']).toBeUndefined();
    expect(env.SHELLOPTS).toBeUndefined();
  });
});

describe('Kiro ACP auto-approval', () => {
  it('selects allow_once for safe commands and keeps unsafe, blocked and non-shell requests out of auto', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(path.join(base, 'kiro-auto-'));
    temporary.push(directory);
    await writeFile(path.join(directory, 'package.json'), '{"version":"1.0.0"}\n');
    const script = path.join(directory, 'kiro-fixture.mjs'),
      log = path.join(directory, 'responses.jsonl');
    const requests = [
      { id: 51, toolCall: permission('ls -la') },
      { id: 52, toolCall: permission('rm package.json') },
      { id: 53, toolCall: permission('cat package.json') },
      { id: 54, toolCall: permission("bash -c 'ls'") },
      { id: 55, toolCall: { toolCallId: 'w', title: 'Writing: x.txt', rawInput: { path: 'x.txt', content: 'x' } } },
      { id: 56, toolCall: permission('grep -n version package.json | head -1; ls') },
    ];
    await writeFile(
      script,
      `#!/usr/bin/env node
import readline from 'node:readline';import fs from 'node:fs';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const rl=readline.createInterface({input:process.stdin});
const requests=${JSON.stringify(requests)};let promptId,answered=0;
rl.on('line',line=>{const m=JSON.parse(line);
if(!m.method){if(m.id>=51){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({id:m.id,result:m.result})+'\\n');if(++answered===requests.length)send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});}return;}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'s1'}});
else if(m.method==='session/prompt'){promptId=m.id;for(const r of requests)send({jsonrpc:'2.0',id:r.id,method:'session/request_permission',params:{sessionId:'s1',toolCall:r.toolCall,options:${JSON.stringify(OPTIONS)},_meta:{trustOptions:[]}}});}
else if(m.method==='session/cancel')send({jsonrpc:'2.0',id:m.id,result:{}});
});
`,
    );
    await chmod(script, 0o755);
    const prior = { bin: process.env.ADELIC_KIRO_BIN, shell: process.env.SHELL };
    process.env.ADELIC_KIRO_BIN = script;
    process.env.SHELL = '/bin/bash';
    const provider = new KiroProvider();
    const input: RunInput = {
      runId: 'kiro-auto',
      sessionId: 'session-1',
      providerId: 'kiro',
      cwd: directory,
      prompt: 'x',
      history: [],
      plan: { level: 'fast', reason: 'direct', tools: true, memory: false, effort: 'low', contextBudget: 80 },
      sandbox: 'workspace-write',
      approvalMode: 'auto-safe',
      blockedCommands: ['cat *'],
    };
    try {
      const approvals: Approval[] = [];
      const run = provider.run(
        input,
        (event) => {
          if (event.type !== 'approval') return;
          approvals.push(event.approval);
          if (event.approval.status === 'pending') void provider.approve(event.approval.id, 'deny');
        },
        new AbortController().signal,
      );
      await run;
      const responses = new Map(
        (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { id: number; result: { outcome: { optionId?: string } } })
          .map((r) => [r.id, r.result.outcome.optionId]),
      );
      // Safe commands: allow_once, never allow_always.
      expect(responses.get(51)).toBe('once');
      expect(responses.get(56)).toBe('once');
      // Unsafe, wrapped and non-shell requests were pending and the user denied them.
      for (const id of [52, 54, 55]) expect(responses.get(id)).toBe('reject');
      // Blocked before the classifier could approve the otherwise safe `cat`.
      expect(responses.get(53)).toBe('reject');
      expect([...responses.values()]).not.toContain('always');
      const byCommand = (command: string) => approvals.find((a) => a.command === command);
      expect(byCommand('ls -la')).toMatchObject({ status: 'approved', kind: 'command' });
      expect(byCommand('ls -la')!.detail).toMatch(/Comando de leitura permitido/);
      expect(byCommand('cat package.json')).toMatchObject({ status: 'denied', blocked: 'cat *' });
      expect(byCommand('rm package.json')).toMatchObject({ status: 'pending' });
      expect(approvals.find((a) => a.title.startsWith('Writing'))).toMatchObject({ status: 'pending' });

      const automaticProvider = new KiroProvider();
      try {
        const automaticApprovals: Approval[] = [];
        await automaticProvider.run(
          { ...input, runId: 'kiro-automatic', approvalMode: 'automatic' },
          (event) => {
            if (event.type === 'approval') automaticApprovals.push(event.approval);
          },
          new AbortController().signal,
        );
        const allResponses = (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { id: number; result: { outcome: { optionId?: string } } });
        const autoResponses = new Map(
          allResponses.slice(requests.length).map((r) => [r.id, r.result.outcome.optionId]),
        );
        for (const id of [51, 52, 53, 54, 55, 56]) expect(autoResponses.get(id)).toBe('reject');
        expect(automaticApprovals.filter((approval) => approval.status === 'pending')).toEqual([]);
        expect(automaticApprovals.find((approval) => approval.command === 'rm package.json')).toMatchObject({
          status: 'denied',
          decision: { source: 'project-rule', rule: 'native-runtime-disabled' },
        });
        expect(automaticApprovals.find((approval) => approval.command === 'cat package.json')).toMatchObject({
          status: 'denied',
          blocked: 'cat *',
        });
      } finally {
        await automaticProvider.shutdown();
      }
    } finally {
      if (prior.bin === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior.bin;
      if (prior.shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prior.shell;
      await provider.shutdown();
    }
  });

  it('manual mode keeps every Kiro request pending', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(path.join(base, 'kiro-manual-'));
    temporary.push(directory);
    const script = path.join(directory, 'kiro-fixture.mjs');
    await writeFile(
      script,
      `#!/usr/bin/env node
import readline from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const rl=readline.createInterface({input:process.stdin});let promptId;
rl.on('line',line=>{const m=JSON.parse(line);
if(!m.method){if(m.id===61)send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});return;}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'s1'}});
else if(m.method==='session/prompt'){promptId=m.id;send({jsonrpc:'2.0',id:61,method:'session/request_permission',params:{sessionId:'s1',toolCall:${JSON.stringify(permission('ls'))},options:${JSON.stringify(OPTIONS)}}});}
});
`,
    );
    await chmod(script, 0o755);
    const prior = process.env.ADELIC_KIRO_BIN;
    process.env.ADELIC_KIRO_BIN = script;
    const provider = new KiroProvider();
    try {
      const statuses: string[] = [];
      await provider.run(
        {
          runId: 'kiro-manual',
          sessionId: 'session-1',
          providerId: 'kiro',
          cwd: directory,
          prompt: 'x',
          history: [],
          plan: { level: 'fast', reason: 'direct', tools: true, memory: false, effort: 'low', contextBudget: 80 },
          sandbox: 'workspace-write',
          approvalMode: 'manual',
        },
        (event) => {
          if (event.type !== 'approval') return;
          statuses.push(event.approval.status);
          void provider.approve(event.approval.id, 'approve');
        },
        new AbortController().signal,
      );
      expect(statuses).toEqual(['pending']);
    } finally {
      if (prior === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior;
      await provider.shutdown();
    }
  });
});
