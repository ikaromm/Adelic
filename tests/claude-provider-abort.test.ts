import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../server/providers/claude';
import type { RunInput } from '../shared/contracts';

const directories: string[] = [];
const previousBinary = process.env.ADELIC_CLAUDE_BIN;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  if (previousBinary === undefined) delete process.env.ADELIC_CLAUDE_BIN;
  else process.env.ADELIC_CLAUDE_BIN = previousBinary;
});

function input(cwd: string): RunInput {
  return {
    runId: 'claude-fixture',
    sessionId: 'claude-session',
    providerId: 'claude',
    cwd,
    prompt: 'synthetic fixture',
    history: [],
    plan: { level: 'fast', reason: 'test', tools: false, memory: false, effort: 'low', contextBudget: 0 },
    sandbox: 'read-only',
  };
}

async function setupFakeClaude(mode: 'complete' | 'close-immediately' | 'wait' = 'complete') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-claude-close-race-'));
  directories.push(directory);
  const binary = path.join(directory, 'fake-claude.mjs');
  const delta = JSON.stringify({
    type: 'stream_event',
    event: { delta: { type: 'text_delta', text: 'partial answer' } },
  });
  const completed = JSON.stringify({ type: 'result', is_error: false, result: 'finished' });
  await writeFile(
    binary,
    `#!/usr/bin/env node
const send = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
send(${delta});
${mode === 'wait' ? 'setInterval(() => {}, 1000);' : `send(${completed}); ${mode === 'close-immediately' ? 'process.exit(0);' : 'setImmediate(() => process.exit(0));'}`}
`,
  );
  await chmod(binary, 0o755);
  process.env.ADELIC_CLAUDE_BIN = binary;
  return { provider: new ClaudeProvider(), input: input(directory) };
}

const namespaceCheck = spawnSync(
  '/usr/bin/bwrap',
  [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--',
    '/bin/true',
  ],
  { encoding: 'utf8', timeout: 5000 },
);
const canUseProductionBubblewrap = namespaceCheck.status === 0;

describe.skipIf(!canUseProductionBubblewrap)(
  'Claude CLI abort/close classification behind production bubblewrap',
  () => {
    it('maps an ordinary close to completed', async () => {
      const { provider, input: run } = await setupFakeClaude();
      try {
        const result = await provider.run(run, () => undefined, new AbortController().signal);
        expect(result).toMatchObject({ text: 'partial answer', stopReason: 'completed' });
      } finally {
        await provider.shutdown();
      }
    });

    it('cancels a still-running CLI and preserves its streamed partial text', async () => {
      const { provider, input: run } = await setupFakeClaude('wait');
      const controller = new AbortController();
      try {
        const result = await provider.run(
          run,
          (event) => {
            if (event.type === 'delta') controller.abort(new Error('synthetic abort'));
          },
          controller.signal,
        );
        expect(result).toMatchObject({ text: 'partial answer', stopReason: 'cancelled' });
      } finally {
        await provider.shutdown();
      }
    });

    it('keeps an observed abort cancelled when close races termination and retains partial text', async () => {
      const { provider, input: run } = await setupFakeClaude('close-immediately');
      const controller = new AbortController();
      try {
        const result = await provider.run(
          run,
          (event) => {
            if (event.type === 'delta') controller.abort(new Error('synthetic abort'));
          },
          controller.signal,
        );
        expect(result).toMatchObject({ text: 'partial answer', stopReason: 'cancelled' });
      } finally {
        await provider.shutdown();
      }
    });
  },
);
