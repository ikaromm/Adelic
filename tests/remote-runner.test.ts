import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { REMOTE_RUNNER_SOURCE } from '../server/remote/runner-source.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const createHarness = async () => {
  const base = await mkdtemp(join(tmpdir(), 'adelic-remote-runner-'));
  roots.push(base);
  const root = join(base, 'project');
  await mkdir(root);
  const runner = join(base, 'runner.py');
  await writeFile(runner, REMOTE_RUNNER_SOURCE, { mode: 0o700 });
  const child = spawn('python3', ['-u', runner, '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let data = '';
  let stderr = '';
  const queue: Array<(frame: Record<string, unknown>) => void> = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      data += `${line}\n`;
      const next = queue.shift();
      if (next) next(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const send = (frame: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      queue.push(resolve);
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  const close = async () => {
    child.stdin.end();
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  };
  return { root, child, send, close, getData: () => data, getStderr: () => stderr };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('credential-free remote runner', () => {
  it('exposes protocol info and performs bounded file operations under its root', async () => {
    const harness = await createHarness();
    try {
      expect(await harness.send({ id: 'info-1', method: 'info' })).toMatchObject({
        id: 'info-1',
        ok: true,
        result: { protocol: 1, platform: process.platform === 'win32' ? 'Windows' : 'Linux' },
      });
      expect(
        await harness.send({
          id: 'write-1',
          method: 'call',
          tool: 'write_file',
          args: { path: 'nested.txt', content: 'hello' },
        }),
      ).toMatchObject({ ok: true, result: { bytesWritten: 5 } });
      expect(await readFile(join(harness.root, 'nested.txt'), 'utf8')).toBe('hello');
      expect(
        await harness.send({ id: 'read-1', method: 'call', tool: 'read_file', args: { path: 'nested.txt' } }),
      ).toMatchObject({ ok: true, result: { content: 'hello' } });
      expect(
        await harness.send({ id: 'list-1', method: 'call', tool: 'list', args: { path: '.', recursive: true } }),
      ).toMatchObject({ ok: true, result: { entries: [{ name: 'nested.txt', directory: false }], truncated: false } });
      expect(
        await harness.send({ id: 'stat-1', method: 'call', tool: 'stat', args: { path: 'nested.txt' } }),
      ).toMatchObject({
        ok: true,
        result: { type: 'file', size: 5 },
      });
      expect(
        await harness.send({ id: 'search-1', method: 'call', tool: 'search', args: { query: 'ell' } }),
      ).toMatchObject({
        ok: true,
        result: { results: [{ line: 1, text: 'hello' }] },
      });
      await execFileAsync('git', ['init', '-q', harness.root]);
      expect(
        await harness.send({ id: 'git-1', method: 'call', tool: 'git', args: { operation: 'status' } }),
      ).toMatchObject({
        ok: true,
        result: { exitCode: 0 },
      });
      expect(
        await harness.send({ id: 'escape-1', method: 'call', tool: 'read_file', args: { path: '../outside' } }),
      ).toMatchObject({ id: 'escape-1', ok: false });
      expect(
        await harness.send({
          id: 'readonly-1',
          method: 'call',
          tool: 'write_file',
          args: { path: 'blocked', content: 'x', readOnly: true },
        }),
      ).toMatchObject({ id: 'readonly-1', ok: false });
    } finally {
      await harness.close();
    }
  });

  it('cancels before spawn and kills process-group and observed setsid descendants', async () => {
    const harness = await createHarness();
    try {
      const marker = join(dirname(harness.root), 'cancelled-descendant-ran');
      for (let index = 0; index < 15; index++) {
        const id = `cancel-race-${index}`;
        const response = harness.send({
          id,
          method: 'call',
          tool: 'exec',
          args: { command: `sleep 0.15; touch ${marker}`, timeoutMs: 60000 },
        });
        harness.child.stdin.write(`${JSON.stringify({ method: 'cancel', id })}\n`);
        await expect(response).resolves.toMatchObject({ id, ok: false, error: 'command cancelled' });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });

      const escapedId = 'cancel-setsid';
      const escaped = harness.send({
        id: escapedId,
        method: 'call',
        tool: 'exec',
        args: { command: `setsid sh -c 'sleep 0.5; touch ${marker}' & sleep 30`, timeoutMs: 60000 },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      harness.child.stdin.write(`${JSON.stringify({ method: 'cancel', id: escapedId })}\n`);
      await expect(escaped).resolves.toMatchObject({ id: escapedId, ok: false, error: 'command cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await harness.close();
    }
  });

  it('reads Git changes without executing attribute filters or repository helpers', async () => {
    const harness = await createHarness();
    try {
      const marker = join(dirname(harness.root), 'git-helper-executed');
      const helper = join(dirname(harness.root), 'git-helper');
      await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
      const git = (...args: string[]) => execFileAsync('git', ['-C', harness.root, ...args]);
      await git('init', '-q');
      await writeFile(join(harness.root, 'sample.txt'), 'before\n');
      await git('add', 'sample.txt');
      await writeFile(join(harness.root, 'sample.txt'), 'after\n');
      await writeFile(join(harness.root, '.gitattributes'), '*.txt filter=SpY diff=spy\n');
      // Included config and case-sensitive filter names must be overridden too.
      const filterConfig = join(dirname(harness.root), 'filters.config');
      await writeFile(filterConfig, `[filter "SpY"]\nclean = ${helper}\nrequired = true\n`);
      await git('config', 'include.path', filterConfig);
      await git('config', 'core.fsmonitor', helper);
      await git('config', 'diff.spy.command', helper);
      await git('config', 'diff.spy.textconv', helper);
      for (const phase of ['clean', 'process']) {
        if (phase === 'process') await git('config', 'filter.SpY.process', helper);
        for (const operation of ['status', 'diff']) {
          const response = await harness.send({
            id: `git-${phase}-${operation}`,
            method: 'call',
            tool: 'git',
            args: { operation, readOnly: true },
          });
          expect(response).toMatchObject({ ok: true, result: { exitCode: 0 } });
          if (operation === 'diff') {
            expect((response.result as { stdout: string }).stdout).toContain('-before\n+after');
          }
          await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      }
    } finally {
      await harness.close();
    }
  });

  it('rejects corrupted frames without emitting non-JSON output', async () => {
    const harness = await createHarness();
    try {
      harness.child.stdin.write('{broken json}\n');
      await new Promise<void>((resolve) => harness.child.once('close', () => resolve()));
      expect(harness.getData()).toContain('"error":"invalid JSON frame"');
      expect(harness.getStderr()).toBe('');
    } finally {
      if (harness.child.exitCode === null) await harness.close();
    }
  });
});
