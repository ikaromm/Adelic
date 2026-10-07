import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider } from '../server/providers/codex';
import { kiroToolEvent, KiroProvider, parseKiroDoctorAuth, parseKiroModelCatalog } from '../server/providers/kiro';
import { JsonRpcProcess } from '../server/providers/process';
import { boundedPrompt } from '../server/providers/common';
import { CommandScope, runCommand } from '../server/providers/command';
import { bubblewrap } from '../server/providers/sandbox';
import type { RunInput } from '../shared/contracts';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runInput(prompt: string): RunInput {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    providerId: 'codex',
    cwd: process.cwd(),
    prompt,
    history: [],
    plan: { level: 'fast', reason: 'direct', tools: false, memory: false, effort: 'low', contextBudget: 80 },
    sandbox: 'read-only',
  };
}

// Protocol fixtures deliberately inject a transparent wrapper. Production has
// no such bypass: CodexProvider defaults to the real bubblewrap boundary.
function fixtureCodex(binary: string, dataDir?: string) {
  return new CodexProvider(
    async () => binary,
    undefined,
    undefined,
    dataDir,
    async (command, args) => ({ command, args }),
  );
}

describe('provider runtime helpers', () => {
  it('uses real bubblewrap to allow writes only inside the workspace', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'real-bwrap-'));
    temporaryDirectories.push(fixture);
    const workspace = path.join(fixture, 'workspace');
    const sibling = path.join(fixture, 'sibling');
    await mkdir(workspace);
    await mkdir(sibling);
    await access('/usr/bin/bwrap');
    const wrapped = await bubblewrap(
      '/bin/sh',
      ['-c', `touch inside.txt && touch ${JSON.stringify(path.join(sibling, 'outside.txt'))}`],
      workspace,
      'workspace-write',
    );
    const result = await runCommand(wrapped.command, wrapped.args, 5000);
    expect(result.code).not.toBe(0);
    expect(await readFile(path.join(workspace, 'inside.txt'), 'utf8')).toBe('');
    await expect(readFile(path.join(sibling, 'outside.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps read-only workspaces unwritable while allowing the provider runtime scratch', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'readonly-bwrap-'));
    temporaryDirectories.push(fixture);
    const workspace = path.join(fixture, 'workspace'),
      scratch = path.join(fixture, 'scratch');
    await mkdir(workspace);
    await mkdir(scratch);
    await access('/usr/bin/bwrap');
    const wrapped = await bubblewrap(
      '/usr/bin/env',
      [
        `TMPDIR=${scratch}`,
        '/bin/sh',
        '-c',
        'touch workspace-write 2>/dev/null; test ! -e workspace-write && touch "$TMPDIR/scratch-write"',
      ],
      workspace,
      'read-only',
      [scratch],
    );
    const result = await runCommand(wrapped.command, wrapped.args, 5000);
    expect(result.code).toBe(0);
    await expect(access(path.join(workspace, 'workspace-write'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(scratch, 'scratch-write'), 'utf8')).resolves.toBe('');
  });

  it('protects synthetic credentials and their workspace ancestor with real bubblewrap mounts', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'real-bwrap-auth-'));
    temporaryDirectories.push(fixture);
    await access('/usr/bin/bwrap');
    for (const relativeHome of ['.codex', path.join('nested', '.codex')]) {
      const root = path.join(fixture, relativeHome === '.codex' ? 'workspace-direct' : 'workspace-nested');
      const scratch = path.join(fixture, `scratch-${relativeHome === '.codex' ? 'direct' : 'nested'}`);
      const sibling = path.join(fixture, `outside-${relativeHome === '.codex' ? 'direct' : 'nested'}`);
      const home = path.join(root, relativeHome);
      await mkdir(home, { recursive: true });
      await mkdir(scratch);
      await mkdir(path.join(scratch, 'CODEX_HOME'));
      await mkdir(sibling);
      const original = path.join(home, 'auth.json');
      const placeholder = path.join(scratch, 'CODEX_HOME', 'auth.json');
      const synthetic = '{"fixture":"synthetic-only"}\n';
      await writeFile(original, synthetic);
      await writeFile(placeholder, '{}\n');
      const firstChild = path.join(root, relativeHome.split(path.sep)[0]!);
      const readonly = [
        { source: firstChild, target: firstChild, directory: true },
        { source: original, target: placeholder },
      ];
      const code = [
        `cat ${JSON.stringify(original)} > /dev/null`,
        `cat ${JSON.stringify(placeholder)} > /dev/null`,
        `cmp ${JSON.stringify(original)} ${JSON.stringify(placeholder)} && sha256sum ${JSON.stringify(original)} ${JSON.stringify(placeholder)} > ${JSON.stringify(path.join(scratch, 'auth-hashes'))}`,
        `printf attacked > ${JSON.stringify(original)} 2>/dev/null || true`,
        `rm -f ${JSON.stringify(original)} 2>/dev/null || true`,
        `mv ${JSON.stringify(original)} ${JSON.stringify(original + '.moved')} 2>/dev/null || true`,
        `mv ${JSON.stringify(firstChild)} ${JSON.stringify(firstChild + '.moved')} 2>/dev/null || true`,
        `mkdir -p ${JSON.stringify(firstChild)} 2>/dev/null || true`,
        `printf replacement > ${JSON.stringify(original)} 2>/dev/null || true`,
        `printf attacked > ${JSON.stringify(placeholder)} 2>/dev/null || true`,
        `rm -f ${JSON.stringify(placeholder)} 2>/dev/null || true`,
        `mv ${JSON.stringify(placeholder)} ${JSON.stringify(placeholder + '.moved')} 2>/dev/null || true`,
        'touch ordinary-workspace-write',
        `touch ${JSON.stringify(path.join(scratch, 'scratch-write'))}`,
        `touch ${JSON.stringify(path.join(sibling, 'outside.txt'))} 2>/dev/null || true`,
      ].join('; ');
      const wrapped = await bubblewrap('/bin/sh', ['-c', code], root, 'workspace-write', [scratch], readonly);
      await runCommand(wrapped.command, wrapped.args, 5000);
      expect(await readFile(original, 'utf8')).toBe(synthetic);
      const hashes = (await readFile(path.join(scratch, 'auth-hashes'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => line.split(' ')[0]);
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).toBe(hashes[1]);
      await expect(access(original + '.moved')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(firstChild + '.moved')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(root, 'ordinary-workspace-write'), 'utf8')).resolves.toBe('');
      await expect(readFile(path.join(scratch, 'scratch-write'), 'utf8')).resolves.toBe('');
      await expect(access(path.join(sibling, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('bounds prior conversation to newest text and always preserves the current prompt', () => {
    const input = runInput('current user request');
    input.history = [
      {
        id: '1',
        sessionId: input.sessionId,
        role: 'user',
        content: 'older message that must be omitted',
        createdAt: '',
      },
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
    const result = await runCommand(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      60,
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waits for a SIGTERM-ignoring JSON-RPC child to be killed before shutdown resolves', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-provider-kill-'));
    temporaryDirectories.push(directory);
    const pidPath = path.join(directory, 'pid');
    const script = path.join(directory, 'ignore-term.mjs');
    await writeFile(
      script,
      // Ignore SIGTERM before announcing the pid, or a fast kill can land before the handler exists.
      `#!/usr/bin/env node\nimport fs from 'node:fs';\nprocess.on('SIGTERM', () => {});\nfs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    await chmod(script, 0o755);
    const rpc = new JsonRpcProcess(script, [], directory, () => undefined);
    let pidText = '';
    for (let attempt = 0; attempt < 50 && !pidText; attempt++) {
      try {
        pidText = await readFile(pidPath, 'utf8');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
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
    const script = `import fs from 'node:fs'; process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const commands = new CommandScope();
    const pending = commands.run(process.execPath, ['-e', script], 10_000);
    let pidText = '';
    for (let attempt = 0; attempt < 50 && !pidText; attempt++) {
      try {
        pidText = await readFile(pidPath, 'utf8');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
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

describe('Kiro tool-call lifecycle', () => {
  it('retains command metadata when the completion update contains only ID and status', () => {
    const turn = { toolCalls: new Map<string, { name: string; description: string }>() };
    expect(
      kiroToolEvent(
        turn,
        { toolCallId: 'call-1', kind: 'execute', title: 'npm test -- --runInBand', status: 'pending' },
        'pending',
      ),
    ).toMatchObject({
      toolCallId: 'call-1',
      name: 'execute',
      description: 'npm test -- --runInBand',
      status: 'pending',
    });
    expect(kiroToolEvent(turn, { toolCallId: 'call-1', status: 'completed' }, 'completed')).toMatchObject({
      toolCallId: 'call-1',
      name: 'execute',
      description: 'npm test -- --runInBand',
      status: 'completed',
    });
    const otherTurn = { toolCalls: new Map<string, { name: string; description: string }>() };
    expect(kiroToolEvent(otherTurn, { toolCallId: 'call-1', status: 'running' }, 'running')).toMatchObject({
      name: 'kiro-tool',
      description: 'Ferramenta Kiro',
      status: 'running',
    });
    expect(
      kiroToolEvent(turn, { toolCallId: 'call-1', name: 'identity-from-protocol', kind: 'display-category' }, 'running')
        .name,
    ).toBe('identity-from-protocol');
  });

  it('keeps Kiro ACP permission decisions bound to the requesting process and protocol options', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(path.join(base, 'kiro-acp-fixture-'));
    temporaryDirectories.push(directory);
    const script = path.join(directory, 'kiro-fixture.mjs'),
      log = path.join(directory, 'responses.jsonl');
    await writeFile(
      script,
      `#!/usr/bin/env node
import readline from 'node:readline';import fs from 'node:fs';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const rl=readline.createInterface({input:process.stdin});let sid='reused-session',promptId;
rl.on('line',line=>{const m=JSON.parse(line);if(!m.method){if(m.id===41){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m.result)+'\\n');send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});}return;}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:sid}});
else if(m.method==='session/prompt'){promptId=m.id;send({jsonrpc:'2.0',id:41,method:'session/request_permission',params:{sessionId:sid,toolCallId:'only-id',options:JSON.parse(process.env.KIRO_PERMISSION_OPTIONS||'[{"kind":"allow_always","optionId":"always"},{"kind":"allow_once","optionId":"once"}]')}});}
else if(m.method==='session/cancel')send({jsonrpc:'2.0',id:m.id,result:{}});
});
`,
    );
    await chmod(script, 0o755);
    const prior = process.env.ADELIC_KIRO_BIN,
      priorOptions = process.env.KIRO_PERMISSION_OPTIONS;
    process.env.ADELIC_KIRO_BIN = script;
    process.env.KIRO_PERMISSION_OPTIONS =
      '[{"kind":"allow_always","optionId":"always"},{"kind":"allow_once","optionId":"once"}]';
    const provider = new KiroProvider();
    const input = (runId: string): RunInput => ({
      ...runInput('ask'),
      providerId: 'kiro',
      runId,
      sessionId: 'same-app-session',
      cwd: directory,
      sandbox: 'workspace-write',
      plan: { ...runInput('ask').plan, tools: true },
    });
    try {
      const approvals = new Map<string, string>();
      let resolveBoth!: () => void;
      const both = new Promise<void>((r) => {
        resolveBoth = r;
      });
      const run = (id: string) =>
        provider.run(
          input(id),
          (event) => {
            if (event.type === 'approval') {
              approvals.set(id, event.approval.id);
              if (approvals.size === 2) resolveBoth();
            }
          },
          new AbortController().signal,
        );
      const one = run('r1'),
        two = run('r2');
      await Promise.race([
        both,
        new Promise((_, reject) => setTimeout(() => reject(new Error('approvals not emitted')), 5000)),
      ]);
      await Promise.all([...approvals.values()].map((id) => provider.approve(id, 'approve')));
      await Promise.all([one, two]);
      let denyId = '';
      const denied = provider.run(
        input('r3'),
        (event) => {
          if (event.type === 'approval') denyId = event.approval.id;
        },
        new AbortController().signal,
      );
      for (let i = 0; i < 100 && !denyId; i++) await new Promise((r) => setTimeout(r, 10));
      expect(denyId).toBeTruthy();
      await provider.approve(denyId, 'deny');
      await denied;
      let noToolsApprovals = 0;
      await provider.run(
        { ...input('r4'), plan: { ...input('r4').plan, tools: false } },
        (event) => {
          if (event.type === 'approval') noToolsApprovals++;
        },
        new AbortController().signal,
      );
      expect(noToolsApprovals).toBe(0);
      const controller = new AbortController();
      let cancelId = '';
      const cancelled = provider.run(
        input('r5'),
        (event) => {
          if (event.type === 'approval') cancelId = event.approval.id;
        },
        controller.signal,
      );
      for (let i = 0; i < 100 && !cancelId; i++) await new Promise((r) => setTimeout(r, 10));
      expect(cancelId).toBeTruthy();
      controller.abort();
      await expect(cancelled).resolves.toMatchObject({ stopReason: 'cancelled' });
      // On cancel the adapter answers `cancelled` and then terminates the process, so the fake
      // Kiro may die before logging that answer. The run has resolved only after the process
      // exited, so the log is final for r1–r5 here: r1–r4 always, r5 only if it was read in time.

      const closedController = new AbortController();
      let closedApproval = '';
      const closedRun = provider.run(
        input('r6'),
        (event) => {
          if (event.type === 'approval') closedApproval = event.approval.id;
        },
        closedController.signal,
      );
      for (let i = 0; i < 100 && !closedApproval; i++) await new Promise((r) => setTimeout(r, 10));
      expect(closedApproval).toBeTruthy();
      const activeProcess = [...(provider as unknown as { processes: Set<JsonRpcProcess> }).processes][0]!;
      activeProcess.child.stdin.destroy();
      expect(() => closedController.abort()).not.toThrow();
      await expect(closedRun).resolves.toMatchObject({ stopReason: 'cancelled' });
      await expect(provider.approve(closedApproval, 'approve')).rejects.toThrow(/não está mais pendente/);
      const responses = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect([4, 5]).toContain(responses.length);
      expect(responses.slice(0, 2)).toEqual([
        { outcome: { outcome: 'selected', optionId: 'once' } },
        { outcome: { outcome: 'selected', optionId: 'once' } },
      ]);
      expect(responses.slice(2)).toEqual(responses.slice(2).map(() => ({ outcome: { outcome: 'cancelled' } })));
      await expect(provider.approve(cancelId, 'approve')).rejects.toThrow(/não está mais pendente/);
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior;
      if (priorOptions === undefined) delete process.env.KIRO_PERMISSION_OPTIONS;
      else process.env.KIRO_PERMISSION_OPTIONS = priorOptions;
    }
  });
  it('confirms Kiro auth from the explicit Auth check, regardless of terminal integration failures', () => {
    const doctor = (auth: string, extra = '') =>
      `Let's check if you're logged in...\n${auth}\n\nLet's check your dotfiles...\n● ~/.bashrc does not source pre integration\n✘ Kiro CLI terminal integrations: kiro-cli-term is not running in this terminal\n✘ Qterm Socket Check: Qterm is not running, please restart your terminal.${extra}\n`;
    expect(parseKiroDoctorAuth({ code: 1, stdout: doctor('✔ Auth'), stderr: '', timedOut: false })).toBe(true);
    expect(parseKiroDoctorAuth({ code: 0, stdout: `\x1b[32m✔\x1b[0m Auth\n`, stderr: '', timedOut: false })).toBe(true);
    expect(parseKiroDoctorAuth({ code: 1, stdout: doctor('✘ Auth: not logged in'), stderr: '', timedOut: false })).toBe(
      false,
    );
    expect(
      parseKiroDoctorAuth({ code: 0, stdout: doctor('✔ Auth', '\n✘ Auth token expired'), stderr: '', timedOut: false }),
    ).toBe(false);
    expect(
      parseKiroDoctorAuth({
        code: 0,
        stdout: "Let's check your dotfiles...\n✔ Fish is up to date\n",
        stderr: '',
        timedOut: false,
      }),
    ).toBe(false);
    expect(parseKiroDoctorAuth({ code: 0, stdout: '✔ Authorization header sent\n', stderr: '', timedOut: false })).toBe(
      false,
    );
    expect(parseKiroDoctorAuth({ code: null, stdout: doctor('✔ Auth'), stderr: '', timedOut: true })).toBe(false);
    expect(parseKiroDoctorAuth({ code: null, stdout: '✔ Auth\n', stderr: '', timedOut: false })).toBe(false);
  });
  it('reports Kiro ready with a valid catalog when only terminal checks fail, and keeps the catalog mandatory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-kiro-doctor-'));
    const script = path.join(directory, 'kiro-cli');
    await writeFile(
      script,
      `#!/bin/sh
if [ "$1" = doctor ]; then printf '%s\\n' '✔ Auth' '✘ Qterm Socket Check: Qterm is not running'; exit 1; fi
if [ -n "$KIRO_EMPTY_CATALOG" ]; then echo '{"models":[]}'; else echo '{"models":[{"model_id":"m1","model_name":"M1","isDefault":true}]}'; fi
`,
    );
    await chmod(script, 0o755);
    const prior = process.env.ADELIC_KIRO_BIN;
    process.env.ADELIC_KIRO_BIN = script;
    try {
      const ready = new KiroProvider();
      try {
        await expect(ready.info()).resolves.toMatchObject({
          available: true,
          status: 'ready',
          defaultModel: 'm1',
          models: [{ id: 'm1' }],
        });
      } finally {
        await ready.shutdown();
      }
      process.env.KIRO_EMPTY_CATALOG = '1';
      const empty = new KiroProvider();
      try {
        await expect(empty.info()).resolves.toMatchObject({ available: false, status: 'error' });
      } finally {
        await empty.shutdown();
        delete process.env.KIRO_EMPTY_CATALOG;
      }
    } finally {
      if (prior === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('preserves empty and unknown reasoning-effort announcements from discovery', () => {
    const catalog = parseKiroModelCatalog(
      JSON.stringify({
        models: [
          { model_id: 'empty', model_name: 'Empty', supportedReasoningEfforts: [] },
          { model_id: 'unknown', model_name: 'Unknown', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] },
          { model_id: 'unspecified', model_name: 'Unspecified' },
        ],
      }),
    );
    expect(catalog.models.find((model) => model.id === 'empty')).toHaveProperty('efforts', []);
    expect(catalog.models.find((model) => model.id === 'unknown')).toHaveProperty('efforts', ['xhigh']);
    expect(catalog.models.find((model) => model.id === 'unspecified')).not.toHaveProperty('efforts');
  });
});

describe('Codex app-server JSON-RPC lifecycle', () => {
  async function fakeServer(
    options: {
      scenario?: string;
      argsLog?: string;
      approvalLog?: string;
      discoveryPidLog?: string;
      requestLog?: string;
      configReadLog?: string;
      neutralizationLog?: string;
      childPidLog?: string;
      baseDir?: string;
    } = {},
  ) {
    const directory = await mkdtemp(path.join(options.baseDir ?? os.tmpdir(), 'adelic-provider-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'fake-codex.mjs');
    await writeFile(
      file,
      `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
if (process.argv[2] === 'login' && process.argv[3] === 'status') { console.log('Logged in using ChatGPT'); process.exit(0); }
${options.neutralizationLog ? `if(process.env.FAKE_SCENARIO==='shell-neutralization'){const child=spawnSync('/usr/bin/bash',['-c','uname -a'],{encoding:'utf8'});fs.writeFileSync(${JSON.stringify(options.neutralizationLog)},JSON.stringify({output:child.stdout,code:child.status,BASH_ENV:process.env.BASH_ENV,ENV:process.env.ENV,func:Object.keys(process.env).filter(k=>k.startsWith('BASH_FUNC_')),unsafe:['SHELLOPTS','BASHOPTS','PS4'].filter(k=>Object.hasOwn(process.env,k)),execServer:Object.keys(process.env).filter(k=>k.startsWith('CODEX_EXEC_SERVER')),pulse:process.env.PULSE_SERVER,dbus:process.env.DBUS_SESSION_BUS_ADDRESS}));}` : ''}
${options.discoveryPidLog ? `if (process.argv[2] === 'app-server') fs.writeFileSync(${JSON.stringify(options.discoveryPidLog)}, String(process.pid));` : ''}
${options.argsLog ? `fs.appendFileSync(${JSON.stringify(options.argsLog)}, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd()}) + '\\n');` : ''}
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let turnId = 'turn-1';
rl.on('line', (line) => {
  const message = JSON.parse(line);
  ${options.configReadLog ? `if (message.method === 'config/read') fs.appendFileSync(${JSON.stringify(options.configReadLog)}, JSON.stringify(message.params) + '\\n');` : ''}
  ${options.requestLog ? `if (message.method === 'thread/start' || message.method === 'turn/start') fs.appendFileSync(${JSON.stringify(options.requestLog)}, JSON.stringify({ method: message.method, params: message.params }) + '\\n');` : ''}
  if (message.id === 700 && !message.method) {
    ${options.approvalLog ? `fs.writeFileSync(${JSON.stringify(options.approvalLog)}, JSON.stringify(message));` : ''}
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
  }

  else if (message.id === 999 && !message.method) { ${options.approvalLog ? `fs.writeFileSync(${JSON.stringify(options.approvalLog)}, JSON.stringify(message));` : ''} }
  if (message.method === 'initialize') { if (process.env.FAKE_SCENARIO !== 'abort-init' && process.env.FAKE_SCENARIO !== 'info-pending-init') send({ jsonrpc: '2.0', id: message.id, result: {} }); }
  else if (message.method === 'config/read') {
    const scenario=process.env.FAKE_SCENARIO;
    if(scenario==='mcp-config-error')send({jsonrpc:'2.0',id:message.id,result:{unexpected:true}});
    else if(scenario==='mcp-enabled')send({jsonrpc:'2.0',id:message.id,result:{config:{mcp_servers:{synthetic:{enabled:true}}}}});
    else if(scenario==='mcp-disabled')send({jsonrpc:'2.0',id:message.id,result:{config:{mcp_servers:{synthetic:{enabled:false}}}}});
    else if(scenario==='mcp-missing-enabled')send({jsonrpc:'2.0',id:message.id,result:{config:{mcp_servers:{synthetic:{command:'not-run'}}}}});
    else if(scenario==='mcp-shape-error')send({jsonrpc:'2.0',id:message.id,result:{config:{mcp_servers:[]}}});
    else send({jsonrpc:'2.0',id:message.id,result:{config:{mcp_servers:{}}}});
  }
  else if (message.method === 'thread/start') {
    const scenario=process.env.FAKE_SCENARIO;
    const environments=scenario==='missing-environment-announcement'?undefined:scenario==='malformed-announcement'?[{environmentId:'local',cwd:process.cwd(),runtimeWorkspaceRoots:[17]}]:scenario==='cwd-divergent'?[{environmentId:'local',cwd:process.cwd()+'/remote',runtimeWorkspaceRoots:[process.cwd()+'/remote']}]:scenario==='remote-announcement'?[{environmentId:'remote',cwd:process.cwd(),runtimeWorkspaceRoots:[process.cwd()]}]:[{environmentId:'local',cwd:process.cwd(),runtimeWorkspaceRoots:[process.cwd()]}];
    send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1', ...(environments?{environments}:{}) } } });
  }
  else if (message.method === 'turn/start') {
    send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: turnId } } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turnId } } });
    ${options.childPidLog ? `if(message.params.input[0].text.includes('child cleanup')){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(options.childPidLog)}+'-'+message.params.input[0].text.includes('sibling'),String(child.pid));if(message.params.input[0].text.includes('sibling'))setTimeout(()=>{send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:turnId,status:'completed'}}});},1200);return;}` : ''}
    if (process.env.FAKE_SCENARIO === 'tool-event') {
      send({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-1', item: { id: 'tool-1', type: 'commandExecution', command: 'echo hi' } } });
      send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'tool-1', type: 'commandExecution', command: 'echo hi', status: 'completed' } } });
    }
    if (process.env.FAKE_SCENARIO === 'approval') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId, itemId: 'item-1', cwd: process.cwd(), permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: process.cwd() + '/README.md' } }] } } } });
      return;
    }
    if (process.env.FAKE_SCENARIO === 'approval-unknown') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId, itemId: 'item-1', permissions: { fileSystem: { entries: [], deleteEverything: true } } } });
      return;
    }
    if (process.env.FAKE_SCENARIO === 'approval-network-only') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId, itemId: 'item-1', permissions: { network: { enabled: true } } } });
      return;
    }
    if (process.env.FAKE_SCENARIO === 'file-grant') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId, itemId: 'item-1', grantRoot: process.env.FAKE_GRANT } });
      return;
    }
    if (process.env.FAKE_SCENARIO === 'command-approval') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId, command: 'pwd', cwd: process.cwd(), reason: 'fixture', environmentId: 'local' } });
      return;
    }
    if (process.env.FAKE_SCENARIO === 'safe-bash') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId, command: '/usr/bin/bash -c "uname -a"', cwd: process.cwd(), environmentId: 'local' } });
      return;
    }
    if (['unknown-environment-id','missing-environment-announcement','cwd-divergent','malformed-announcement'].includes(process.env.FAKE_SCENARIO ?? '')) {
      send({ jsonrpc: '2.0', id: 700, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId, command: '/usr/bin/bash -c "uname -a"', cwd: process.cwd(), environmentId: process.env.FAKE_SCENARIO==='unknown-environment-id'?'remote':'local' } });
      setTimeout(() => send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } }), 40);
      return;
    }
    if (process.env.FAKE_SCENARIO === 'remote-direct') {
      send({ jsonrpc: '2.0', id: 700, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId, command: '/usr/bin/uname -a', cwd: process.cwd(), environmentId: 'remote' } });
      setTimeout(() => send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } }), 40);
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
  } else if (message.method === 'turn/steer') {
    if (message.params.expectedTurnId !== turnId) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'expected turn mismatch' } }); return; }
    send({ jsonrpc: '2.0', id: message.id, result: { turnId } });
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'steered: ' + message.params.input[0].text } });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
  } else if (message.method === 'turn/interrupt') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'interrupted' } } });
  }
});
`,
    );
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
    const provider = fixtureCodex(binary);
    try {
      const infoPromise = provider.info();
      let pidText = '';
      for (let attempt = 0; attempt < 100 && !pidText; attempt++) {
        try {
          pidText = await readFile(pidLog, 'utf8');
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(pidText).toMatch(/^\d+$/);
      const pid = Number(pidText);
      await provider.shutdown();
      await expect(infoPromise).resolves.toMatchObject({
        available: false,
        status: 'error',
        detail: 'Codex provider is shutting down.',
      });
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(provider.info()).resolves.toMatchObject({ available: false, status: 'error' });
    } finally {
      await provider.shutdown();
      if (priorScenario === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = priorScenario;
    }
  });

  it('initializes once, streams deltas, and maps completed status', async () => {
    const binary = await fakeServer();
    const provider = fixtureCodex(binary);
    const events: string[] = [];
    const result = await provider.run(
      runInput('answer directly'),
      (event) => {
        if (event.type === 'delta') events.push(event.text);
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      text: 'fake streamed answer',
      nativeSessionId: 'thread-1',
      stopReason: 'completed',
    });
    expect(events).toEqual(['fake streamed answer']);
    await provider.shutdown();
  });

  it('auto-approves the Codex-only neutral non-login shell wrapper but keeps login wrappers pending', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'safe-bash';
    const binary = await fakeServer();
    const provider = fixtureCodex(binary);
    let status: string | undefined;
    try {
      await provider.run(
        {
          ...runInput('native diagnostic'),
          cwd: process.cwd(),
          plan: { ...runInput('native diagnostic').plan, tools: true },
        },
        (event) => {
          if (event.type === 'approval') status = event.approval.status;
        },
        new AbortController().signal,
      );
      expect(status).toBe('approved');
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it.each([
    'unknown-environment-id',
    'missing-environment-announcement',
    'cwd-divergent',
    'malformed-announcement',
    'remote-direct',
  ])('keeps Codex command approvals manual for untrusted environment (%s)', async (scenario) => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = scenario;
    const provider = fixtureCodex(await fakeServer());
    let status: string | undefined;
    try {
      await provider.run(
        { ...runInput('manual native command'), plan: { ...runInput('manual native command').plan, tools: true } },
        (event) => {
          if (event.type === 'approval') status = event.approval.status;
        },
        new AbortController().signal,
      );
      expect(status).toBe('pending');
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('does not start a Codex turn if cancellation arrives during async environment validation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-abort-environment-'));
    temporaryDirectories.push(directory);
    const requestLog = path.join(directory, 'requests.jsonl');
    const binary = await fakeServer({ requestLog });
    const provider = fixtureCodex(binary);
    const controller = new AbortController();
    let armed = false;
    const signal = new Proxy(controller.signal, {
      get(target, key) {
        if (key === 'aborted') {
          // Abort after thread/start has been answered: the queued abort lands
          // while the subsequent asynchronous realpath checks are pending.
          if (
            !armed &&
            (() => {
              try {
                return readFileSync(requestLog, 'utf8').includes('thread/start');
              } catch {
                return false;
              }
            })()
          ) {
            armed = true;
            queueMicrotask(() => controller.abort(new Error('cancel during environment validation')));
          }
          return target.aborted;
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      await expect(provider.run(runInput('cancel during validation'), () => undefined, signal)).rejects.toThrow(
        'cancel during environment validation',
      );
    } finally {
      await provider.shutdown();
    }
    const requests = (await readFile(requestLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string });
    expect(requests.some((request) => request.method === 'thread/start')).toBe(true);
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false);
  });

  it('scrubs inherited BASH_ENV and exported shell functions before Codex can launch its trusted shell', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'codex-shell-env-'));
    temporaryDirectories.push(fixture);
    const marker = path.join(fixture, 'startup-marker'),
      bashEnv = path.join(fixture, 'bash-env'),
      result = path.join(fixture, 'env.json');
    await writeFile(bashEnv, `printf started > ${marker}\n`);
    const keys = [
      'FAKE_SCENARIO',
      'BASH_ENV',
      'BASH_FUNC_uname%%',
      'PS4',
      'CODEX_EXEC_SERVER_URL',
      'CODEX_EXEC_SERVER_NOISE',
      'PULSE_SERVER',
      'DBUS_SESSION_BUS_ADDRESS',
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.FAKE_SCENARIO = 'shell-neutralization';
    process.env.BASH_ENV = bashEnv;
    process.env['BASH_FUNC_uname%%'] = '() { echo ADELIC_SPOOFED_UNAME; }';
    process.env.PS4 = 'spoof';
    process.env.CODEX_EXEC_SERVER_URL = 'https://external.invalid';
    process.env.CODEX_EXEC_SERVER_NOISE = 'synthetic';
    process.env.PULSE_SERVER = 'unix:/synthetic-pulse';
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/synthetic-dbus';
    const provider = fixtureCodex(await fakeServer({ neutralizationLog: result }));
    try {
      await provider.run({ ...runInput('neutralized'), cwd: fixture }, () => undefined, new AbortController().signal);
      const info = JSON.parse(await readFile(result, 'utf8'));
      expect(info.output).toContain('Linux');
      expect(info.output).not.toContain('ADELIC_SPOOFED_UNAME');
      expect(info.code).toBe(0);
      expect(info.BASH_ENV).toBe('/dev/null');
      expect(info.func).toEqual([]);
      expect(info.unsafe).toEqual([]);
      expect(info.execServer).toEqual([]);
      expect(info.pulse).toBe('unix:/synthetic-pulse');
      expect(info.dbus).toBe('unix:path=/synthetic-dbus');
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await provider.shutdown();
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('runs behind real bubblewrap and removes provider scratch on shutdown', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'codex-real-bwrap-'));
    temporaryDirectories.push(fixture);
    const binary = await fakeServer({ baseDir: fixture });
    const dataDir = path.join(fixture, 'data');
    const provider = new CodexProvider(async () => binary, undefined, undefined, dataDir);
    try {
      const input = { ...runInput('answer behind the boundary'), cwd: fixture };
      await expect(provider.run(input, () => undefined, new AbortController().signal)).resolves.toMatchObject({
        stopReason: 'completed',
      });
      const scratchBase = path.join(dataDir, 'codex-tmp');
      const scratch = await readdir(scratchBase);
      expect(scratch).toEqual([]);
      await provider.shutdown();
      await expect(readdir(scratchBase)).resolves.toEqual([]);
    } finally {
      await provider.shutdown();
    }
  });

  it('reaps only the cancelled run process tree behind real bubblewrap and removes its scratch', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    await access('/usr/bin/bwrap');
    const fixture = await mkdtemp(path.join(base, 'codex-cancel-tree-'));
    temporaryDirectories.push(fixture);
    const dataDir = path.join(fixture, 'data');
    const pidLog = path.join(fixture, 'child.pid');
    const binary = await fakeServer({ baseDir: fixture, childPidLog: pidLog });
    const provider = new CodexProvider(async () => binary, undefined, undefined, dataDir);
    const cancelled = new AbortController();
    const cancelledInput = {
      ...runInput('child cleanup cancelled run'),
      runId: 'cancel-child',
      cwd: fixture,
      sandbox: 'workspace-write' as const,
    };
    const siblingInput = {
      ...runInput('child cleanup sibling run'),
      runId: 'sibling-child',
      cwd: fixture,
      sandbox: 'workspace-write' as const,
    };
    const cancelledRun = provider.run(cancelledInput, () => undefined, cancelled.signal);
    const siblingRun = provider.run(siblingInput, () => undefined, new AbortController().signal);
    const serverFor = (runId: string) =>
      [...(provider as unknown as { servers: Map<string, { rpc?: JsonRpcProcess }> }).servers.entries()].find(([key]) =>
        key.includes(`\0${runId}\0`),
      )?.[1];
    const turnFor = (runId: string) =>
      [...(provider as unknown as { turns: Map<string, { turnId?: string }> }).turns.entries()].find(
        ([key]) => key === runId,
      )?.[1];
    const descendants = async (rootPid: number): Promise<number[]> => {
      const seen = new Set<number>();
      const visit = async (pid: number) => {
        let children: number[];
        try {
          children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
        } catch {
          return;
        }
        for (const child of children)
          if (!seen.has(child)) {
            seen.add(child);
            await visit(child);
          }
      };
      await visit(rootPid);
      return [...seen];
    };
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for isolated child processes to start.');
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await waitFor(async () =>
        Boolean(
          turnFor('cancel-child')?.turnId &&
          turnFor('sibling-child')?.turnId &&
          serverFor('cancel-child')?.rpc &&
          serverFor('sibling-child')?.rpc &&
          (await descendants(serverFor('cancel-child')!.rpc!.child.pid!)).length &&
          (await descendants(serverFor('sibling-child')!.rpc!.child.pid!)).length,
        ),
      );
      const cancelledTree = await descendants(serverFor('cancel-child')!.rpc!.child.pid!);
      const siblingTree = await descendants(serverFor('sibling-child')!.rpc!.child.pid!);
      expect(cancelledTree.some(alive)).toBe(true);
      expect(siblingTree.some(alive)).toBe(true);
      cancelled.abort();
      await expect(cancelledRun).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(siblingTree.some(alive)).toBe(true);
      await expect(siblingRun).resolves.toMatchObject({ stopReason: 'completed' });
      await waitFor(async () => !cancelledTree.some(alive) && !siblingTree.some(alive));
      await expect(readdir(path.join(dataDir, 'codex-tmp'))).resolves.toEqual([]);
    } finally {
      cancelled.abort();
      await provider.shutdown();
    }
  });

  it('does not spawn after shutdown wins a blocked wrapper race and removes startup scratch', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'codex-wrapper-shutdown-'));
    temporaryDirectories.push(fixture);
    const dataDir = path.join(fixture, 'data');
    const argsLog = path.join(fixture, 'args.jsonl');
    const binary = await fakeServer({ argsLog });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const provider = new CodexProvider(
      async () => binary,
      undefined,
      undefined,
      dataDir,
      async (command, args) => {
        enter();
        await blocked;
        return { command, args };
      },
    );
    const running = provider.run(
      { ...runInput('startup race'), cwd: fixture },
      () => undefined,
      new AbortController().signal,
    );
    await entered;
    const shuttingDown = provider.shutdown();
    await shuttingDown;
    unblock();
    await expect(running).rejects.toThrow(/shutting down/);
    await expect(readFile(argsLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(path.join(dataDir, 'codex-tmp'))).resolves.toEqual([]);
  });

  it('binds only the first credential-bearing child and a readonly placeholder when workspace is filesystem root', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'codex-auth-root-'));
    temporaryDirectories.push(fixture);
    const home = path.join(fixture, 'synthetic-codex-home');
    await mkdir(home);
    await writeFile(path.join(home, 'auth.json'), 'synthetic only');
    const binary = await fakeServer();
    let bindings: unknown[] = [];
    const prior = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const provider = new CodexProvider(
      async () => binary,
      undefined,
      undefined,
      path.join(fixture, 'data'),
      async (command, args, _cwd, _sandbox, _scratch, readonly) => {
        bindings = readonly ?? [];
        return { command, args };
      },
    );
    try {
      await provider.run(
        { ...runInput('root workspace'), cwd: '/', sandbox: 'workspace-write' },
        () => undefined,
        new AbortController().signal,
      );
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prior;
    }
    const firstChild = path.join(path.sep, home.split(path.sep).filter(Boolean)[0]!);
    expect(bindings[0]).toMatchObject({ source: firstChild, target: firstChild, directory: true });
    expect(bindings[1]).toMatchObject({
      source: path.join(home, 'auth.json'),
      target: expect.stringContaining(`${path.sep}CODEX_HOME${path.sep}auth.json`),
    });
  });

  it('binds synthetic nested CODEX_HOME readonly and rejects workspace nested inside it', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'codex-auth-bindings-'));
    temporaryDirectories.push(fixture);
    const priorHome = process.env.CODEX_HOME;
    const workspace = path.join(fixture, 'workspace');
    const home = path.join(workspace, 'nested', '.codex');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'auth.json'), '{"synthetic":true}\n');
    process.env.CODEX_HOME = home;
    let captured: { source: string; target: string; directory?: boolean }[] = [];
    const binary = await fakeServer();
    const provider = new CodexProvider(
      async () => binary,
      undefined,
      undefined,
      undefined,
      async (command, args, _cwd, _sandbox, _runtime, readonly = []) => {
        captured = readonly;
        return { command, args };
      },
    );
    try {
      await expect(
        provider.run(
          { ...runInput('readonly synthetic home'), cwd: workspace, sandbox: 'workspace-write' },
          () => undefined,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ stopReason: 'completed' });
      expect(captured).toHaveLength(2);
      expect(captured[0]).toMatchObject({
        source: path.join(workspace, 'nested'),
        target: path.join(workspace, 'nested'),
        directory: true,
      });
      expect(captured[1]).toMatchObject({ source: path.join(home, 'auth.json') });
      expect(captured[1]?.target).toContain(`${path.sep}CODEX_HOME${path.sep}auth.json`);

      const nestedWorkspace = path.join(home, 'project');
      await mkdir(nestedWorkspace);
      const blocked = new CodexProvider(
        async () => binary,
        undefined,
        undefined,
        undefined,
        async (command, args) => ({ command, args }),
      );
      await expect(
        blocked.run(
          { ...runInput('incompatible workspace'), cwd: nestedWorkspace, sandbox: 'workspace-write' },
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/workspace-write incompatível/);
      await blocked.shutdown();
    } finally {
      await provider.shutdown();
      if (priorHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorHome;
    }
  });

  it('asks the sandbox for system config shims inside the Codex run scratch', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const fixture = await mkdtemp(path.join(base, 'codex-shims-'));
    temporaryDirectories.push(fixture);
    const binary = await fakeServer();
    let captured: { scratch?: string; options?: unknown } = {};
    const provider = new CodexProvider(
      async () => binary,
      undefined,
      undefined,
      path.join(fixture, 'data'),
      async (command, args, _cwd, _sandbox, runtime = [], _readonly, options) => {
        captured = { scratch: runtime[0], options };
        return { command, args };
      },
    );
    try {
      await provider.run(runInput('shims'), () => undefined, new AbortController().signal);
    } finally {
      await provider.shutdown();
    }
    expect(captured.scratch).toContain(`${path.sep}codex-tmp${path.sep}adelic-codex-`);
    expect(captured.options).toEqual({ systemShims: { dir: path.join(captured.scratch!, 'system-shims') } });
  });

  it('preserves a Codex item ID across tool lifecycle events', async () => {
    const previous = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'tool-event';
    const binary = await fakeServer();
    const provider = fixtureCodex(binary);
    const tools: string[] = [];
    try {
      await provider.run(
        runInput('inspect'),
        (event) => {
          if (event.type === 'tool') tools.push(`${event.toolCallId}:${event.status}`);
        },
        new AbortController().signal,
      );
    } finally {
      await provider.shutdown();
      if (previous === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = previous;
    }
    expect(tools).toEqual(['tool-1:running', 'tool-1:completed']);
  });

  it('sends medium reasoning effort through both Codex app-server request stages', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-medium-'));
    temporaryDirectories.push(directory);
    const requestLog = path.join(directory, 'requests.jsonl');
    const binary = await fakeServer({ requestLog });
    const provider = fixtureCodex(binary);
    const input = {
      ...runInput('medium effort'),
      plan: { ...runInput('medium effort').plan, effort: 'medium' as const },
    };
    await provider.run(input, () => undefined, new AbortController().signal);
    await provider.shutdown();
    const requests = (await readFile(requestLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, any> });
    expect(requests.find((request) => request.method === 'thread/start')?.params.config).toMatchObject({
      model_reasoning_effort: 'medium',
    });
    expect(requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({ effort: 'medium' });
  });

  it('keeps fast tools local, runs a real tool event, and isolates the no-tools and deep profiles', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-fast-tools-'));
    temporaryDirectories.push(directory);
    const requestLog = path.join(directory, 'requests.jsonl');
    const argsLog = path.join(directory, 'args.jsonl');
    const previous = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'tool-event';
    const binary = await fakeServer({ requestLog, argsLog });
    const provider = fixtureCodex(binary);
    const fastInput = runInput('verifique este computador');
    fastInput.plan.tools = true;
    const emitted: string[] = [];
    try {
      await provider.run(
        fastInput,
        (event) => {
          if (event.type === 'tool') emitted.push(`${event.name}:${event.status}`);
        },
        new AbortController().signal,
      );
      const noTools = runInput('responda sem ferramentas');
      await provider.run(noTools, () => undefined, new AbortController().signal);
      const deep = {
        ...runInput('tarefa profunda'),
        plan: { ...runInput('tarefa profunda').plan, level: 'deep' as const, tools: true },
      };
      await provider.run(deep, () => undefined, new AbortController().signal);
    } finally {
      await provider.shutdown();
      if (previous === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = previous;
    }
    expect(emitted).toEqual(['commandExecution:running', 'commandExecution:completed']);
    const requests = (await readFile(requestLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, any> });
    const threads = requests.filter((request) => request.method === 'thread/start');
    expect(threads).toHaveLength(3);
    const scratch = threads[0].params.config.shell_environment_policy.set.TMPDIR;
    expect(scratch).toContain('adelic-codex-');
    expect(threads[0].params.turn).toBeUndefined();
    expect(threads[0].params).toMatchObject({
      config: {
        allow_login_shell: false,
        shell_environment_policy: {
          set: { BASH_ENV: '/dev/null', ENV: '/dev/null', TMPDIR: scratch, PATH: process.env.PATH },
          exclude: ['BASH_FUNC_*', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'CODEX_EXEC_SERVER*'],
        },
        web_search: 'disabled',
        project_doc_max_bytes: 0,
        features: {
          shell_tool: true,
          unified_exec: true,
          code_mode_host: true,
          browser_use: false,
          memories: false,
          shell_snapshot: false,
          skip_host_skill_discovery: true,
        },
      },
      baseInstructions: expect.stringContaining('use ferramentas locais somente se necessário'),
    });
    expect(threads[1].params.config).toMatchObject({
      features: { shell_tool: false, unified_exec: false, code_mode_host: false },
    });
    expect(threads[1].params.baseInstructions).toContain('sem ferramentas');
    expect(threads[2].params.config).toMatchObject({ model_reasoning_effort: 'low' });
    expect(threads[2].params.config).not.toHaveProperty('web_search');
    const args = (await readFile(argsLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    const profiles = args.filter((entry) => entry.args[0] === 'app-server').map((entry) => entry.args);
    expect(profiles).toHaveLength(3);
    expect(profiles[0]).toContain('--enable');
    expect(profiles[0]).toContain('allow_login_shell=false');
    expect(profiles[0]).toContain('shell_snapshot');
    expect(profiles[0]).toContain('shell_tool');
    expect(profiles[0]).toContain('unified_exec');
    expect(profiles[0][profiles[0].indexOf('shell_tool') - 1]).toBe('--enable');
    expect(profiles[0][profiles[0].indexOf('unified_exec') - 1]).toBe('--enable');
    expect(profiles[0][profiles[0].indexOf('code_mode_host') - 1]).toBe('--enable');
    expect(profiles[0]).toContain('browser_use');
    expect(profiles[1][profiles[1].indexOf('shell_tool') - 1]).toBe('--disable');
    expect(profiles[1][profiles[1].indexOf('unified_exec') - 1]).toBe('--disable');
    expect(profiles[1][profiles[1].indexOf('code_mode_host') - 1]).toBe('--disable');
    expect(profiles[2]).not.toContain('browser_use');
  });

  it('sends turn/interrupt with the native turn id when the caller aborts', async () => {
    const binary = await fakeServer();
    const provider = fixtureCodex(binary);
    const controller = new AbortController();
    const running = provider.run(runInput('wait for cancellation'), () => undefined, controller.signal);
    // Abort only once the turn is registered: earlier, setup (thread/start, MCP checks) is
    // still running and an abort there rejects instead of interrupting a turn. A fixed delay
    // was too short on slower CI runners.
    const turns = (provider as unknown as { turns: Map<string, unknown> }).turns;
    for (let i = 0; i < 250 && !turns.size; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns.size).toBe(1);
    controller.abort();
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
    await provider.shutdown();
  });

  it('steers the active turn with turn/steer and the native turn id', async () => {
    const binary = await fakeServer();
    const provider = fixtureCodex(binary);
    expect(await provider.steer('run-1', 'nada ativo')).toBe(false);
    const running = provider.run(runInput('wait for cancellation'), () => undefined, new AbortController().signal);
    // Wait until the turn has its native id (turn/start answered).
    for (let i = 0; i < 100; i++) {
      try {
        if (await provider.steer('run-1', 'mude o foco')) break;
      } catch (error) {
        if (!/ainda não iniciou/.test((error as Error).message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(running).resolves.toMatchObject({ stopReason: 'completed', text: 'steered: mude o foco' });
    expect(await provider.steer('run-2', 'outra execução')).toBe(false);
    await provider.shutdown();
  });

  it('settles a turn when the app-server exits after turn/start', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'crash-after-start';
    const binary = await fakeServer();
    const provider = fixtureCodex(binary);
    try {
      await expect(
        provider.run(runInput('answer directly'), () => undefined, new AbortController().signal),
      ).rejects.toThrow(/encerrou antes de concluir/);
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('aborts during initialize without starting a thread or turn', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'abort-init';
    const binary = await fakeServer();
    const provider = fixtureCodex(binary);
    const controller = new AbortController();
    try {
      const running = provider.run(runInput('must not start'), () => undefined, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.abort();
      await expect(running).rejects.toThrow(/abort|cancel/i);
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('does not copy host MCP definitions into the isolated app-server profile', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-config-'));
    temporaryDirectories.push(directory);
    const codexHome = path.join(directory, 'codex-home');
    const projectA = path.join(directory, 'project-a');
    const projectB = path.join(directory, 'project-b');
    const argsLog = path.join(directory, 'args.jsonl');
    const requestLog = path.join(directory, 'requests.jsonl');
    const configReadLog = path.join(directory, 'config-reads.jsonl');
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(path.join(projectA, '.codex'), { recursive: true }),
      mkdir(path.join(projectB, '.codex'), { recursive: true }),
    ]);
    await writeFile(
      path.join(codexHome, 'config.toml'),
      'mcp_servers = { global_inline = { command = "sh", args = ["-c", "touch /tmp/adelic-must-not-run"] } }\n',
    );
    await writeFile(
      path.join(projectA, '.codex/config.toml'),
      '[mcp_servers."quoted name"] # comment\ncommand = "sh"\nargs = ["-c", "touch /tmp/adelic-must-not-run"]\n',
    );
    await writeFile(
      path.join(projectB, '.codex/config.toml'),
      'mcp_servers = { second_inline = { command = "sh", args = ["-c", "touch /tmp/adelic-must-not-run"] } }\n',
    );
    const binary = await fakeServer({ argsLog, requestLog, configReadLog });
    const provider = fixtureCodex(binary);
    const priorHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      await provider.run({ ...runInput('first'), cwd: projectA }, () => undefined, new AbortController().signal);
      await provider.run(
        { ...runInput('second'), runId: 'run-2', cwd: projectB },
        () => undefined,
        new AbortController().signal,
      );
    } finally {
      await provider.shutdown();
      if (priorHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorHome;
    }
    const launches = (await readFile(argsLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
    const byCwd = new Map(launches.map((launch) => [launch.cwd, launch.args]));
    expect(byCwd.size).toBe(2);
    for (const args of byCwd.values()) {
      expect(args.some((arg) => arg.startsWith('mcp_servers.'))).toBe(false);
      expect(args).toContain('--disable');
      expect(args).toContain('shell_tool');
      expect(args).toContain('hooks');
    }
    expect(byCwd.get(projectA)).toBeDefined();
    expect(byCwd.get(projectB)).toBeDefined();
    const requests = (await readFile(requestLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const reads = (await readFile(configReadLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const cwd of [projectA, projectB]) {
      expect(reads.find((item) => item.cwd === cwd)).toEqual({ cwd, includeLayers: false });
      expect(requests.find((item) => item.method === 'thread/start' && item.params.cwd === cwd)).toBeDefined();
    }
  });

  it.each(['mcp-enabled', 'mcp-missing-enabled', 'mcp-config-error', 'mcp-shape-error'])(
    'fails closed on effective MCP config %s before starting a thread',
    async (scenario) => {
      const prior = process.env.FAKE_SCENARIO;
      process.env.FAKE_SCENARIO = scenario;
      const dir = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-mcp-block-'));
      temporaryDirectories.push(dir);
      const requests = path.join(dir, 'requests.jsonl');
      const provider = fixtureCodex(await fakeServer({ requestLog: requests }));
      try {
        await expect(
          provider.run({ ...runInput('must be blocked'), cwd: dir }, () => undefined, new AbortController().signal),
        ).rejects.toThrow(/MCPs personalizados ativos|configuração MCP efetiva desconhecida/);
      } finally {
        await provider.shutdown();
        if (prior === undefined) delete process.env.FAKE_SCENARIO;
        else process.env.FAKE_SCENARIO = prior;
      }
      expect(await readFile(requests, 'utf8').catch(() => '')).not.toContain('thread/start');
    },
  );

  it('allows explicit disabled MCP entries without exposing their definitions to the child', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'mcp-disabled';
    const dir = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-mcp-off-'));
    temporaryDirectories.push(dir);
    const argsLog = path.join(dir, 'args.jsonl');
    const provider = fixtureCodex(await fakeServer({ argsLog }));
    try {
      await expect(
        provider.run({ ...runInput('disabled mcp'), cwd: dir }, () => undefined, new AbortController().signal),
      ).resolves.toMatchObject({ stopReason: 'completed' });
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
    expect(await readFile(argsLog, 'utf8')).not.toMatch(/mcp_servers/);
  });

  it('answers a permissions request with the schema permissions constrained to the selected workspace', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'approval';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-approval-'));
    temporaryDirectories.push(directory);
    const approvalLog = path.join(directory, 'approval.json');
    const binary = await fakeServer({ approvalLog });
    const provider = fixtureCodex(binary);
    const input = {
      ...runInput('change readme'),
      runId: 'approval-run',
      cwd: directory,
      sandbox: 'workspace-write' as const,
      plan: { ...runInput('change readme').plan, level: 'deep' as const, tools: true },
    };
    let resolveApproval!: (id: string) => void;
    const approvalEvent = new Promise<string>((resolve) => {
      resolveApproval = resolve;
    });
    try {
      const running = provider.run(
        input,
        (event) => {
          if (event.type === 'approval') resolveApproval(event.approval.id);
        },
        new AbortController().signal,
      );
      const id = await approvalEvent;
      await provider.approve(id, 'approve');
      await expect(running).resolves.toMatchObject({ stopReason: 'completed' });
      const response = JSON.parse(await readFile(approvalLog, 'utf8')) as {
        result: {
          permissions: { fileSystem: { entries: { access: string; path: { path: string } }[] } };
          scope: string;
        };
      };
      expect(response.result.scope).toBe('turn');
      expect(response.result.permissions.fileSystem.entries).toEqual([
        { access: 'write', path: { type: 'path', path: `${directory}/README.md` } },
      ]);
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('rejects unknown permission keys without consuming the pending approval', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'approval-unknown';
    const testTmp = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(testTmp, { recursive: true });
    const directory = await mkdtemp(path.join(testTmp, 'codex-unknown-permission-'));
    temporaryDirectories.push(directory);
    const approvalLog = path.join(directory, 'response.json');
    const binary = await fakeServer({ approvalLog });
    const provider = fixtureCodex(binary);
    let resolveApproval!: (id: string) => void;
    const event = new Promise<string>((resolve) => {
      resolveApproval = resolve;
    });
    try {
      const running = provider.run(
        {
          ...runInput('approve permission'),
          cwd: directory,
          sandbox: 'workspace-write',
          plan: { ...runInput('x').plan, level: 'deep', tools: true },
        },
        (e) => {
          if (e.type === 'approval') resolveApproval(e.approval.id);
        },
        new AbortController().signal,
      );
      const id = await event;
      await expect(provider.approve(id, 'approve')).rejects.toThrow(/excede o sandbox/);
      await expect(provider.approve(id, 'deny')).resolves.toBeUndefined();
      await expect(running).resolves.toMatchObject({ stopReason: 'completed' });
      expect(JSON.parse(await readFile(approvalLog, 'utf8'))).toMatchObject({
        result: { permissions: {}, scope: 'turn' },
      });
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('allows human approval of the known network-only permission shape', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'approval-network-only';
    const testTmp = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(testTmp, { recursive: true });
    const directory = await mkdtemp(path.join(testTmp, 'codex-network-permission-'));
    temporaryDirectories.push(directory);
    const approvalLog = path.join(directory, 'response.json');
    const binary = await fakeServer({ approvalLog });
    const provider = fixtureCodex(binary);
    let resolveApproval!: (id: string) => void;
    const event = new Promise<string>((resolve) => {
      resolveApproval = resolve;
    });
    try {
      const running = provider.run(
        {
          ...runInput('approve network'),
          cwd: directory,
          sandbox: 'workspace-write',
          plan: { ...runInput('x').plan, level: 'deep', tools: true },
        },
        (e) => {
          if (e.type === 'approval') resolveApproval(e.approval.id);
        },
        new AbortController().signal,
      );
      await provider.approve(await event, 'approve');
      await expect(running).resolves.toMatchObject({ stopReason: 'completed' });
      expect(JSON.parse(await readFile(approvalLog, 'utf8'))).toMatchObject({
        result: { permissions: { network: { enabled: true } }, scope: 'turn' },
      });
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('validates Codex file grants with a fake callback and keeps rejected grants pending until denied', async () => {
    const priorScenario = process.env.FAKE_SCENARIO,
      priorGrant = process.env.FAKE_GRANT;
    process.env.FAKE_SCENARIO = 'file-grant';
    const testTmp = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(testTmp, { recursive: true });
    const fixture = await mkdtemp(path.join(testTmp, 'codex-file-grant-'));
    temporaryDirectories.push(fixture);
    const workspace = path.join(fixture, 'workspace'),
      sibling = path.join(fixture, 'workspace-sibling');
    await mkdir(workspace);
    await mkdir(sibling);
    const binary = await fakeServer();
    const providers: CodexProvider[] = [];
    const input = {
      ...runInput('change file'),
      cwd: workspace,
      sandbox: 'workspace-write' as const,
      plan: { ...runInput('x').plan, tools: true },
    };
    const requestGrant = async (grantRoot: string) => {
      process.env.FAKE_GRANT = grantRoot;
      const provider = fixtureCodex(binary);
      providers.push(provider);
      let resolveApproval!: (id: string) => void;
      const event = new Promise<string>((resolve) => {
        resolveApproval = resolve;
      });
      const running = provider.run(
        { ...input, runId: `file-grant-${Math.random()}` },
        (e) => {
          if (e.type === 'approval') resolveApproval(e.approval.id);
        },
        new AbortController().signal,
      );
      return { id: await event, running, provider };
    };
    try {
      const inWorkspace = await requestGrant(path.join(workspace, 'new-file.txt'));
      await expect(inWorkspace.provider.approve(inWorkspace.id, 'approve')).resolves.toBeUndefined();
      await expect(inWorkspace.running).resolves.toMatchObject({ stopReason: 'completed' });
      await inWorkspace.provider.shutdown();
      const outside = await requestGrant(path.join(sibling, 'outside.txt'));
      await expect(outside.provider.approve(outside.id, 'approve')).rejects.toThrow(/excede o sandbox/);
      await expect(outside.provider.approve(outside.id, 'deny')).resolves.toBeUndefined();
      await expect(outside.running).resolves.toMatchObject({ stopReason: 'completed' });
      await outside.provider.shutdown();
      const missing = path.join(sibling, 'missing', 'new-file.txt');
      await symlink(missing, path.join(workspace, 'dangling'));
      const dangling = await requestGrant(path.join(workspace, 'dangling'));
      await expect(dangling.provider.approve(dangling.id, 'approve')).rejects.toThrow(/excede o sandbox/);
      await expect(dangling.provider.approve(dangling.id, 'deny')).resolves.toBeUndefined();
      await expect(dangling.running).resolves.toMatchObject({ stopReason: 'completed' });
      await dangling.provider.shutdown();
    } finally {
      await Promise.all(providers.map((provider) => provider.shutdown()));
      if (priorScenario === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = priorScenario;
      if (priorGrant === undefined) delete process.env.FAKE_GRANT;
      else process.env.FAKE_GRANT = priorGrant;
    }
  });

  it('uses untrusted Codex approvals and audits a safe command auto-approval without creating a pending owner', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'command-approval';
    const testTmp = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(testTmp, { recursive: true });
    const directory = await mkdtemp(path.join(testTmp, 'codex-auto-'));
    temporaryDirectories.push(directory);
    const requestLog = path.join(directory, 'requests.jsonl'),
      approvalLog = path.join(directory, 'approval.json');
    const binary = await fakeServer({ requestLog, approvalLog });
    const provider = fixtureCodex(binary);
    const input = {
      ...runInput('run a safe command'),
      cwd: directory,
      sandbox: 'workspace-write' as const,
      plan: { ...runInput('x').plan, tools: true },
    };
    const events: { status?: string; detail?: string }[] = [];
    try {
      await expect(
        provider.run(
          input,
          (event) => {
            if (event.type === 'approval')
              events.push({ status: event.approval.status, detail: event.approval.detail });
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ stopReason: 'completed' });
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe('approved');
      expect(events[0]?.detail).toContain('Comando: pwd');
      const request = (await readFile(requestLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      for (const entry of request) {
        expect(entry.params.approvalPolicy).toBe('untrusted');
        expect(entry.params.approvalsReviewer).toBe('user');
      }
      const features = (
        request.find((entry) => entry.method === 'thread/start')?.params.config as { features: Record<string, unknown> }
      ).features;
      expect(features.guardian_approval).toBe(false);
      expect(JSON.parse(await readFile(approvalLog, 'utf8'))).toMatchObject({ result: { decision: 'accept' } });
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('declines a command blocked by the project rules even when the safe classifier would approve it', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'command-approval';
    const testTmp = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(testTmp, { recursive: true });
    const directory = await mkdtemp(path.join(testTmp, 'codex-blocked-'));
    temporaryDirectories.push(directory);
    const approvalLog = path.join(directory, 'approval.json');
    const provider = fixtureCodex(await fakeServer({ approvalLog }));
    const events: { status?: string; title?: string; blocked?: string; command?: string }[] = [];
    try {
      await expect(
        provider.run(
          {
            ...runInput('run a safe command'),
            cwd: directory,
            sandbox: 'workspace-write' as const,
            approvalMode: 'auto-safe',
            blockedCommands: ['p*d'],
            plan: { ...runInput('x').plan, tools: true },
          },
          (event) => {
            if (event.type === 'approval') events.push(event.approval);
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ stopReason: 'completed' });
      expect(events).toMatchObject([
        { status: 'denied', title: 'Comando bloqueado pelas regras do projeto', blocked: 'p*d', command: 'pwd' },
      ]);
      expect(JSON.parse(await readFile(approvalLog, 'utf8'))).toMatchObject({ result: { decision: 'decline' } });
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });

  it('responds with a JSON-RPC error to unknown server requests instead of leaving them pending', async () => {
    const prior = process.env.FAKE_SCENARIO;
    process.env.FAKE_SCENARIO = 'unknown-request';
    const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-codex-unknown-'));
    temporaryDirectories.push(directory);
    const approvalLog = path.join(directory, 'response.json');
    const binary = await fakeServer({ approvalLog });
    const provider = fixtureCodex(binary);
    try {
      await expect(
        provider.run({ ...runInput('question'), cwd: directory }, () => undefined, new AbortController().signal),
      ).resolves.toMatchObject({ stopReason: 'completed' });
      await expect
        .poll(async () => JSON.parse(await readFile(approvalLog, 'utf8')))
        .toMatchObject({ error: { code: -32601, message: 'Unsupported Codex app-server request' } });
    } finally {
      await provider.shutdown();
      if (prior === undefined) delete process.env.FAKE_SCENARIO;
      else process.env.FAKE_SCENARIO = prior;
    }
  });
});
