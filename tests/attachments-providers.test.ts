import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider, codexTurnInput, stageCodexImages } from '../server/providers/codex';
import { KiroProvider, kiroAcceptsImages, kiroPromptBlocks } from '../server/providers/kiro';
import { bubblewrap } from '../server/providers/sandbox';
import { runCommand } from '../server/providers/command';
import type { RunInput } from '../shared/contracts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tempDir = async (base = os.tmpdir()) => {
  const directory = await mkdtemp(path.join(base, 'adelic-attach-provider-'));
  directories.push(directory);
  return directory;
};
const runInput = (cwd: string, attachments?: RunInput['attachments']): RunInput => ({
  runId: 'run-1',
  sessionId: 'session-1',
  providerId: 'codex',
  cwd,
  prompt: 'descreva a imagem',
  history: [],
  plan: { level: 'fast', reason: 'direct', tools: false, memory: false, contextBudget: 80 },
  sandbox: 'read-only',
  ...(attachments ? { attachments } : {}),
});

describe('Codex image input', () => {
  it('builds the turn input with one localImage item per image after the text', () => {
    expect(codexTurnInput('oi', ['/s/a.png', '/s/b.jpg'])).toEqual([
      { type: 'text', text: 'oi', text_elements: [] },
      { type: 'localImage', path: '/s/a.png' },
      { type: 'localImage', path: '/s/b.jpg' },
    ]);
    expect(codexTurnInput('oi')).toEqual([{ type: 'text', text: 'oi', text_elements: [] }]);
  });

  it('copies images into the run scratch, which bubblewrap exposes inside the sandbox', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const root = await tempDir(base);
    const source = path.join(root, 'data', 'a.png');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, PNG);
    const scratch = path.join(root, 'scratch');
    await mkdir(scratch, { mode: 0o700 });
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const [staged] = await stageCodexImages(scratch, [{ path: source, name: 'a.png', mime: 'image/png' }]);
    expect(staged).toBe(path.join(scratch, 'attachments', '0-a.png'));
    expect((await stat(staged!)).mode & 0o777).toBe(0o600);
    await access('/usr/bin/bwrap');
    // Read the copy from inside the same wrapper Codex uses (scratch as runtime dir).
    const wrapped = await bubblewrap('/usr/bin/wc', ['-c', staged!], workspace, 'read-only', [scratch]);
    const result = await runCommand(wrapped.command, wrapped.args, 5000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`${PNG.length} ${staged}`);
  });

  it('sends the staged image path in turn/start through the app-server', async () => {
    const directory = await tempDir();
    const log = path.join(directory, 'turn.json');
    const binary = path.join(directory, 'fake-codex.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import readline from 'node:readline';import fs from 'node:fs';
if (process.argv[2]==='login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',(line)=>{const m=JSON.parse(line);
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{}});
else if(m.method==='config/read')send({jsonrpc:'2.0',id:m.id,result:{config:{mcp_servers:{}}}});
else if(m.method==='thread/start')send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'t1'}}});
else if(m.method==='turn/start'){const img=m.params.input.find((i)=>i.type==='localImage');
fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({input:m.params.input,readable:fs.existsSync(img.path)}));
send({jsonrpc:'2.0',id:m.id,result:{turn:{id:'u1'}}});
send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'t1',turn:{id:'u1',status:'completed'}}});}});
`,
    );
    await chmod(binary, 0o755);
    const image = path.join(directory, 'a.png');
    await writeFile(image, PNG);
    const provider = new CodexProvider(
      async () => binary,
      undefined,
      undefined,
      path.join(directory, 'data'),
      async (command, args) => ({ command, args }),
    );
    try {
      await provider.run(
        runInput(directory, [{ path: image, name: 'a.png', mime: 'image/png' }]),
        () => undefined,
        new AbortController().signal,
      );
    } finally {
      await provider.shutdown();
    }
    const turn = JSON.parse(await readFile(log, 'utf8')) as {
      input: { type: string; path?: string }[];
      readable: boolean;
    };
    expect(turn.input.map((i) => i.type)).toEqual(['text', 'localImage']);
    expect(turn.input[1]!.path).toMatch(
      new RegExp(`^${path.join(directory, 'data', 'codex-tmp')}/adelic-codex-[^/]+/attachments/0-a\\.png$`),
    );
    expect(turn.readable).toBe(true);
  });
});

describe('Kiro image capability', () => {
  it('reads promptCapabilities.image from the initialize response', () => {
    // Shape answered by kiro-cli 2.23.0 (`kiro-cli acp --agent-engine v2`).
    expect(
      kiroAcceptsImages({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false } },
      }),
    ).toBe(true);
    expect(kiroAcceptsImages({ agentCapabilities: { promptCapabilities: { image: false } } })).toBe(false);
    expect(kiroAcceptsImages({ protocolVersion: 1 })).toBe(false);
    expect(kiroAcceptsImages(null)).toBe(false);
  });

  it('builds ACP image blocks in base64 after the text', async () => {
    const directory = await tempDir();
    const image = path.join(directory, 'a.png');
    await writeFile(image, PNG);
    expect(await kiroPromptBlocks('oi', [{ path: image, name: 'a.png', mime: 'image/png' }])).toEqual([
      { type: 'text', text: 'oi' },
      { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
    ]);
  });

  async function fakeKiro(directory: string, capabilities: string, log: string) {
    const script = path.join(directory, 'kiro-fixture.mjs');
    await writeFile(
      script,
      `#!/usr/bin/env node
import readline from 'node:readline';import fs from 'node:fs';
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',(line)=>{const m=JSON.parse(line);if(!m.method)return;
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,params:m.params})+'\\n');
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:${capabilities}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'k1'}});
else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'k1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'vi'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});}});
`,
    );
    await chmod(script, 0o755);
    return script;
  }

  it('sends image blocks when advertised and fails before the session when not', async () => {
    const base = path.join(process.cwd(), '.adelic/test-tmp');
    await mkdir(base, { recursive: true });
    const directory = await tempDir(base);
    const image = path.join(directory, 'a.png');
    await writeFile(image, PNG);
    const attachments = [{ path: image, name: 'a.png', mime: 'image/png' }];
    const prior = process.env.ADELIC_KIRO_BIN;
    const read = async (log: string) =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params: { prompt?: { type: string }[] } });
    try {
      const withImages = path.join(directory, 'with.jsonl');
      process.env.ADELIC_KIRO_BIN = await fakeKiro(
        directory,
        JSON.stringify({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } }),
        withImages,
      );
      const provider = new KiroProvider();
      // Real bubblewrap: the fixture logs inside the (writable) workspace.
      const input = {
        ...runInput(directory, attachments),
        providerId: 'kiro' as const,
        sandbox: 'workspace-write' as const,
      };
      await expect(provider.run(input, () => undefined, new AbortController().signal)).resolves.toMatchObject({
        text: 'vi',
      });
      await provider.shutdown();
      const prompt = (await read(withImages)).find((m) => m.method === 'session/prompt')!;
      expect(prompt.params.prompt?.map((b) => b.type)).toEqual(['text', 'image']);
      expect(prompt.params.prompt?.[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') });

      const without = path.join(directory, 'without.jsonl');
      process.env.ADELIC_KIRO_BIN = await fakeKiro(directory, JSON.stringify({ protocolVersion: 1 }), without);
      const legacy = new KiroProvider();
      await expect(legacy.run(input, () => undefined, new AbortController().signal)).rejects.toThrow(
        'Este agente não aceita imagens nesta versão',
      );
      // Text-only runs keep working with the same agent.
      await expect(
        legacy.run({ ...input, attachments: undefined, runId: 'run-2' }, () => undefined, new AbortController().signal),
      ).resolves.toMatchObject({ text: 'vi' });
      await legacy.shutdown();
      const methods = (await read(without)).map((m) => m.method);
      expect(methods.slice(0, 2)).toEqual(['initialize', 'initialize']);
      expect(methods.filter((m) => m === 'session/new')).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env.ADELIC_KIRO_BIN;
      else process.env.ADELIC_KIRO_BIN = prior;
    }
  });
});
