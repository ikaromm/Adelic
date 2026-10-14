import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider } from '../server/providers/codex';
import type { ProviderEvent, RunEvent, RunInput } from '../shared/contracts';
import { toolActionDescription } from '../src/run-activity';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fakeCodex() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adelic-mcp-sanitize-'));
  dirs.push(dir);
  const file = path.join(dir, 'fake-codex.mjs');
  await writeFile(
    file,
    `#!/usr/bin/env node
import readline from 'node:readline';
const send=(message)=>process.stdout.write(JSON.stringify(message)+'\\n');
readline.createInterface({input:process.stdin}).on('line',(line)=>{
  const message=JSON.parse(line);
  if(!message.method) return;
  if(message.method==='initialize') send({jsonrpc:'2.0',id:message.id,result:{}});
  else if(message.method==='config/read') send({jsonrpc:'2.0',id:message.id,result:{config:{mcp_servers:{}}}});
  else if(message.method==='thread/start') send({jsonrpc:'2.0',id:message.id,result:{thread:{id:'thread-1'}}});
  else if(message.method==='mcpServerStatus/list') send({jsonrpc:'2.0',id:message.id,result:{data:[],nextCursor:null}});
  else if(message.method==='turn/start'){
    send({jsonrpc:'2.0',id:message.id,result:{turn:{id:'turn-1'}}});
    for(const [index,[,error]] of [
      ['json', '{"token":"fixture-secret-123","password":"fixture-pass-456"}'],
      ['space', 'password="two word secret"']
    ].entries()){
      const item={id:'call-'+index,type:'mcpToolCall',server:'fixture-server',tool:'fixture-tool',status:'failed',error};
      send({jsonrpc:'2.0',method:'item/completed',params:{threadId:'thread-1',item}});
    }
    send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  }
});
`,
  );
  await chmod(file, 0o755);
  return { dir, file };
}

function runInput(cwd: string): RunInput {
  return {
    runId: 'run-sanitize',
    sessionId: 'session-sanitize',
    providerId: 'codex',
    cwd,
    prompt: 'test',
    history: [],
    plan: { level: 'deep', reason: 'test', tools: true, memory: false, effort: 'low', contextBudget: 80 },
    sandbox: 'read-only',
  };
}

describe('Codex MCP error sanitization', () => {
  it('redacts quoted JSON credentials and spaced quoted values before provider events and UI presentation', async () => {
    const { dir, file } = await fakeCodex();
    const events: ProviderEvent[] = [];
    const provider = new CodexProvider(
      async () => file,
      async () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '', timedOut: false }),
      async () => [],
      undefined,
      async (command, args) => ({ command, args }),
    );
    try {
      await provider.run(runInput(dir), (event) => events.push(event), new AbortController().signal);
    } finally {
      await provider.shutdown();
    }

    const toolEvents = events.filter((event) => event.type === 'tool');
    expect(toolEvents).toHaveLength(2);
    const rendered = toolEvents.map((event) => {
      if (event.type !== 'tool') throw new Error('Expected tool event');
      const presentation = toolActionDescription({
        type: 'tool',
        runId: 'run-sanitize',
        sessionId: 'session-sanitize',
        createdAt: new Date().toISOString(),
        text: event.description,
        toolName: event.name,
        status: event.status,
      } as RunEvent);
      return { event: event.description, presentation };
    });

    for (const output of rendered) {
      const combined = output.event + output.presentation;
      expect(combined).not.toContain('fixture-secret-123');
      expect(combined).not.toContain('fixture-pass-456');
      expect(combined).not.toContain('two word secret');
      expect(output.event).toContain('[redigido]');
    }
    expect(rendered[0]!.presentation).toContain('fixture-server');
    expect(rendered[0]!.presentation).toContain('fixture-tool');
    expect(rendered[0]!.presentation).toContain('failed');
  });
});
