import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { REMOTE_RUNNER_SOURCE } from '../server/remote/runner-source.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const createHarness = async (projectRoot?: string, runnerSource = REMOTE_RUNNER_SOURCE) => {
  const base = await mkdtemp(join(tmpdir(), 'adelic-remote-runner-'));
  roots.push(base);
  const root = projectRoot ?? join(base, 'project');
  if (!projectRoot) await mkdir(root);
  const runner = join(base, 'runner.py');
  await writeFile(runner, runnerSource, { mode: 0o700 });
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
  it('diagnoses executor capabilities in-process without installing tools or reading secrets', async () => {
    const harness = await createHarness();
    try {
      const response = await harness.send({ id: 'diagnose', method: 'call', tool: 'diagnose', args: {} });
      expect(response.ok).toBe(true);
      const result = response.result as {
        git: string;
        tmp: Record<string, boolean>;
        browsers: string[];
        browserFunctional: string[];
        binaries: Record<string, boolean>;
        hostDependentTests: string;
      };
      expect(['repository', 'binary-only', 'unavailable', 'unverified']).toContain(result.git);
      expect(result.browserFunctional.every((name) => result.browsers.includes(name))).toBe(true);
      expect(result.tmp).toHaveProperty('/var/tmp');
      expect(result.binaries).toHaveProperty('python3');
      expect(result.browsers).toBeInstanceOf(Array);
      expect(result.hostDependentTests).toContain('host services');
    } finally {
      await harness.close();
    }
  });

  it('keeps slow Git and browser probes within one diagnostic budget', async () => {
    const instrumentedSource = REMOTE_RUNNER_SOURCE.replace(
      'if __name__ == "__main__":\n    main()\n',
      `_real_run = subprocess.run
_git_timeout = None
_browser_timeouts = []

def _slow_probe_run(args, **kwargs):
    global _git_timeout
    if args[0] == "git":
        _git_timeout = kwargs["timeout"]
        time.sleep(1.25)
        return type("Result", (), {"returncode": 1, "stdout": b""})()
    timeout = kwargs["timeout"]
    _browser_timeouts.append(timeout)
    # Consume the remaining budget so the next browser must not be started.
    time.sleep(timeout)
    raise subprocess.TimeoutExpired(args, timeout)

subprocess.run = _slow_probe_run
shutil.which = lambda name: "/deterministic/" + name
_real_diagnose = diagnose_capabilities

def _checked_diagnose():
    result = _real_diagnose()
    assert 1.8 < _git_timeout <= 2
    assert len(_browser_timeouts) == 1
    assert 0 < _browser_timeouts[0] < 1
    assert result["browserFunctional"] == []
    return result

diagnose_capabilities = _checked_diagnose

if __name__ == "__main__":
    main()`,
    );
    const harness = await createHarness(undefined, instrumentedSource);
    const started = Date.now();
    try {
      const response = await harness.send({ id: 'slow-diagnose', method: 'call', tool: 'diagnose', args: {} });
      const elapsed = Date.now() - started;
      expect(response.ok).toBe(true);
      const result = response.result as { browsers: string[]; browserFunctional: string[] };
      expect(result.browsers).toEqual(['chromium', 'chromium-browser', 'google-chrome', 'firefox']);
      expect(result.browserFunctional).toEqual([]);
      expect(elapsed).toBeLessThan(3500);
    } finally {
      await harness.close();
    }
  });

  it('verifies worktree Git reachability through external gitdir metadata and leaves broken metadata unverified', async () => {
    const base = await mkdtemp(join(tmpdir(), 'adelic-diagnose-worktree-'));
    roots.push(base);
    const main = join(base, 'main');
    const worktree = join(base, 'linked-worktree');
    await mkdir(main);
    const git = (...args: string[]) => execFileAsync('git', ['-C', main, ...args]);
    await git('init', '-q');
    await git('config', 'user.name', 'Adelic Test');
    await git('config', 'user.email', 'adelic-test@example.invalid');
    await writeFile(join(main, 'tracked.txt'), 'tracked');
    await git('add', 'tracked.txt');
    await git('commit', '-qm', 'fixture');
    await git('worktree', 'add', '-q', worktree, '-b', 'diagnose-worktree');
    const linked = await createHarness(worktree);
    try {
      expect(await readFile(join(worktree, '.git'), 'utf8')).toContain('gitdir:');
      const report = await linked.send({ id: 'worktree-diagnose', method: 'call', tool: 'diagnose', args: {} });
      expect(report).toMatchObject({ ok: true, result: { git: 'repository' } });
    } finally {
      await linked.close();
    }
    const inaccessible = join(base, 'inaccessible');
    await mkdir(inaccessible);
    await writeFile(join(inaccessible, '.git'), 'gitdir: /no/such/namespace/path\n');
    const broken = await createHarness(inaccessible);
    try {
      expect(await broken.send({ id: 'broken-gitdir', method: 'call', tool: 'diagnose', args: {} })).toMatchObject({
        ok: true,
        result: { git: 'unverified' },
      });
    } finally {
      await broken.close();
    }
  }, 10000);

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
      await writeFile(join(harness.root, 'edit.txt'), 'const answer = 41;\n');
      await harness.send({ id: 'edit-read-1', method: 'call', tool: 'read_file', args: { path: 'edit.txt' } });
      expect(
        await harness.send({
          id: 'replace-1',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'edit.txt', oldText: '41', newText: '42' },
        }),
      ).toMatchObject({ ok: true, result: { matches: 1 } });
      await expect(readFile(join(harness.root, 'edit.txt'), 'utf8')).resolves.toBe('const answer = 42;\n');
      const basePage = await harness.send({
        id: 'random-access-base',
        method: 'call',
        tool: 'read_file',
        args: { path: 'edit.txt' },
      });
      const randomAccess = await harness.send({
        id: 'random-access-read',
        method: 'call',
        tool: 'read_file',
        args: { path: 'edit.txt', offset: 5, revision: (basePage.result as { revision: string }).revision },
      });
      expect(randomAccess).toMatchObject({ ok: true, result: { offset: 5, content: ' answer = 42;\n' } });
      await writeFile(join(harness.root, 'overlap.txt'), 'aaa');
      const overlapPage = await harness.send({
        id: 'overlap-read',
        method: 'call',
        tool: 'read_file',
        args: { path: 'overlap.txt' },
      });
      await expect(
        harness.send({
          id: 'overlap-edit',
          method: 'call',
          tool: 'replace_text',
          args: {
            path: 'overlap.txt',
            oldText: 'aa',
            newText: 'X',
            expectedRevision: (overlapPage.result as { revision: string }).revision,
          },
        }),
      ).resolves.toMatchObject({ ok: false, error: 'oldText must match exactly once' });
      await expect(readFile(join(harness.root, 'overlap.txt'), 'utf8')).resolves.toBe('aaa');
      const oversized = Buffer.alloc(2 * 1024 * 1024, 0x61);
      await writeFile(join(harness.root, 'oversized.txt'), oversized);
      let oversizedRevision = '';
      for (let offset = 0; ;) {
        const page = await harness.send({
          id: `oversized-page-${offset}`,
          method: 'call',
          tool: 'read_file',
          args: {
            path: 'oversized.txt',
            offset,
            limit: 49152,
            ...(oversizedRevision ? { revision: oversizedRevision } : {}),
          },
        });
        const result = page.result as { nextOffset: number; truncated: boolean; revision: string };
        offset = result.nextOffset;
        oversizedRevision = result.revision;
        if (!result.truncated) break;
      }
      await expect(
        harness.send({
          id: 'replace-oversized',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'oversized.txt', oldText: 'a', newText: 'b', readRevision: oversizedRevision },
        }),
      ).resolves.toMatchObject({ ok: false, error: 'oldText must match exactly once' });
      expect((await readFile(join(harness.root, 'oversized.txt'))).equals(oversized)).toBe(true);
      await harness.send({ id: 'edit-read-again', method: 'call', tool: 'read_file', args: { path: 'edit.txt' } });
      await expect(
        harness.send({
          id: 'replace-duplicate',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'edit.txt', oldText: ' ', newText: '-' },
        }),
      ).resolves.toMatchObject({ ok: false, error: 'oldText must match exactly once' });
      await expect(readFile(join(harness.root, 'edit.txt'), 'utf8')).resolves.toBe('const answer = 42;\n');
      await expect(
        harness.send({
          id: 'replace-readonly',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'edit.txt', oldText: '42', newText: '43', readOnly: true },
        }),
      ).resolves.toMatchObject({ ok: false, error: 'replace_text is disabled for a read-only call' });
      await expect(access(join(harness.root, '.adelic-locks'))).rejects.toMatchObject({ code: 'ENOENT' });
      const outside = join(dirname(harness.root), 'outside.txt');
      await writeFile(outside, 'outside canary');
      await symlink(outside, join(harness.root, 'outside-link.txt'));
      await expect(
        harness.send({
          id: 'replace-escape',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'outside-link.txt', oldText: 'canary', newText: 'changed' },
        }),
      ).resolves.toMatchObject({ ok: false, error: 'path escapes project root' });
      await expect(readFile(outside, 'utf8')).resolves.toBe('outside canary');
      expect(
        await harness.send({ id: 'read-1', method: 'call', tool: 'read_file', args: { path: 'nested.txt' } }),
      ).toMatchObject({ ok: true, result: { content: 'hello' } });
      const listed = await harness.send({
        id: 'list-1',
        method: 'call',
        tool: 'list',
        args: { path: '.', recursive: true },
      });
      expect(listed.ok).toBe(true);
      expect((listed.result as { entries: Array<{ name: string }> }).entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'nested.txt' }),
          expect.objectContaining({ name: 'edit.txt' }),
        ]),
      );
      expect((listed.result as { truncated: boolean }).truncated).toBe(false);
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
      ).toMatchObject({ id: 'escape-1', ok: false, errorCategory: 'invalid_request' });
      expect(
        await harness.send({ id: 'missing-1', method: 'call', tool: 'read_file', args: { path: 'missing.txt' } }),
      ).toMatchObject({ id: 'missing-1', ok: false, errorCategory: 'not_found' });
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

  it('paginates bounded UTF-8 reads and refuses edits after a partial or stale read', async () => {
    const harness = await createHarness();
    try {
      const source = 'á'.repeat(80000);
      await writeFile(join(harness.root, 'large.txt'), source, 'utf8');
      let offset = 0;
      let recovered = '';
      let revision = '';
      for (;;) {
        const frame = await harness.send({
          id: `page-${offset}`,
          method: 'call',
          tool: 'read_file',
          args: { path: 'large.txt', offset, limit: 49152, ...(revision ? { revision } : {}) },
        });
        expect(frame.ok).toBe(true);
        const page = frame.result as {
          content: string;
          offset: number;
          bytesRead: number;
          totalBytes: number;
          truncated: boolean;
          nextOffset: number;
          revision: string;
        };
        expect(page.offset).toBe(offset);
        expect(Buffer.byteLength(page.content, 'utf8')).toBe(page.bytesRead);
        expect(page.totalBytes).toBe(Buffer.byteLength(source, 'utf8'));
        expect(page.nextOffset).toBe(offset + page.bytesRead);
        recovered += page.content;
        revision = page.revision;
        offset = page.nextOffset;
        if (!page.truncated) break;
      }
      expect(recovered).toBe(source);
      expect(offset).toBe(Buffer.byteLength(source, 'utf8'));

      await writeFile(join(harness.root, 'stale.txt'), 'before');
      expect(
        await harness.send({ id: 'stale-read', method: 'call', tool: 'read_file', args: { path: 'stale.txt' } }),
      ).toMatchObject({ ok: true, result: { truncated: false } });
      await writeFile(join(harness.root, 'stale.txt'), 'after!');
      expect(
        await harness.send({
          id: 'stale-edit',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'stale.txt', oldText: 'after!', newText: 'modified' },
        }),
      ).toMatchObject({ ok: false, errorCategory: 'conflict' });

      const partial = await harness.send({
        id: 'partial-read',
        method: 'call',
        tool: 'read_file',
        args: { path: 'large.txt', offset: 0, limit: 32 },
      });
      expect(partial).toMatchObject({ ok: true, result: { truncated: true } });
      expect(
        await harness.send({
          id: 'partial-edit',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'large.txt', oldText: 'á', newText: 'b' },
        }),
      ).toMatchObject({ ok: false, error: 'file must be read completely before replace_text' });

      await expect(
        harness.send({
          id: 'bad-limit',
          method: 'call',
          tool: 'read_file',
          args: { path: 'large.txt', offset: 0, limit: 50000 },
        }),
      ).resolves.toMatchObject({ ok: false, errorCategory: 'invalid_request' });
      expect(revision).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
      const omitted = await harness.send({
        id: 'search-omitted',
        method: 'call',
        tool: 'search',
        args: { query: 'not-present' },
      });
      expect(omitted).toMatchObject({ ok: true, result: { truncated: false, omittedFiles: { tooLarge: 1 } } });
      await expect(
        harness.send({
          id: 'forbidden-read',
          method: 'call',
          tool: 'read_file',
          args: { path: '../outside.txt' },
        }),
      ).resolves.toMatchObject({ ok: false, errorCategory: 'invalid_request' });
    } finally {
      await harness.close();
    }
  });

  it('edits a uniquely inspected multibyte range in a large file with revision checks and atomic preservation', async () => {
    const harness = await createHarness();
    try {
      const prefix = 'antes-á😀\n'.repeat(30000);
      const oldText = 'ALVO-á😀-único';
      const suffix = '\ncontinua-ç🧪'.repeat(30000);
      const source = oldText + prefix + suffix;
      expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(128 * 1024);
      await writeFile(join(harness.root, 'large-edit.txt'), source, 'utf8');
      const first = await harness.send({
        id: 'large-edit-inspect',
        method: 'call',
        tool: 'read_file',
        args: { path: 'large-edit.txt', offset: 0, limit: 49152 },
      });
      expect(first).toMatchObject({ ok: true, result: { truncated: true } });
      expect((first.result as { content: string }).content).toContain(oldText);
      const revision = (first.result as { revision: string }).revision;
      const changed = await harness.send({
        id: 'large-edit',
        method: 'call',
        tool: 'replace_text',
        args: { path: 'large-edit.txt', oldText, newText: 'novo-ß🚀', expectedRevision: revision },
      });
      expect(changed).toMatchObject({ ok: true, result: { matches: 1 } });
      expect(await readFile(join(harness.root, 'large-edit.txt'), 'utf8')).toBe('novo-ß🚀' + prefix + suffix);

      const stale = await harness.send({
        id: 'large-edit-stale',
        method: 'call',
        tool: 'replace_text',
        args: { path: 'large-edit.txt', oldText: 'novo-ß🚀', newText: 'bad', expectedRevision: revision },
      });
      expect(stale).toMatchObject({ ok: false, errorCategory: 'conflict', error: 'file changed before edit' });
      expect(
        await harness.send({
          id: 'mismatched-revisions',
          method: 'call',
          tool: 'replace_text',
          args: {
            path: 'large-edit.txt',
            oldText: 'novo-ß🚀',
            newText: 'bad',
            expectedRevision: 'stale',
            readRevision: revision,
          },
        }),
      ).toMatchObject({ ok: false, errorCategory: 'invalid_request' });

      const legacyPage = await harness.send({
        id: 'legacy-page',
        method: 'call',
        tool: 'read_file',
        args: { path: 'large-edit.txt', offset: 0, limit: 49152 },
      });
      const legacyRevision = (legacyPage.result as { revision: string }).revision;
      const legacy = await harness.send({
        id: 'large-edit-legacy',
        method: 'call',
        tool: 'replace_text',
        args: { path: 'large-edit.txt', oldText: 'novo-ß🚀', newText: 'legacy', readRevision: legacyRevision },
      });
      expect(legacy).toMatchObject({ ok: true, result: { matches: 1 } });
      const text = await readFile(join(harness.root, 'large-edit.txt'), 'utf8');
      expect(text).toBe('legacy' + prefix + suffix);
      expect(text.startsWith('legacy')).toBe(true);
      expect(text.endsWith(suffix)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('continues stateless pages across fresh runner processes and rejects a stale revision', async () => {
    const first = await createHarness();
    try {
      const source = 'á😀'.repeat(30_000);
      await writeFile(join(first.root, 'restart.txt'), source, 'utf8');
      let offset = 0;
      let revision = '';
      let recovered = '';
      let pages = 0;
      for (;;) {
        const runner = pages === 0 ? first : await createHarness(first.root);
        try {
          const response = await runner.send({
            id: `restart-${offset}`,
            method: 'call',
            tool: 'read_file',
            args: { path: 'restart.txt', offset, limit: 49152, ...(revision ? { revision } : {}) },
          });
          expect(response.ok).toBe(true);
          const page = response.result as { content: string; nextOffset: number; truncated: boolean; revision: string };
          recovered += page.content;
          offset = page.nextOffset;
          revision = page.revision;
          pages++;
          if (!page.truncated) break;
        } finally {
          if (runner !== first) await runner.close();
        }
      }
      expect(pages).toBeGreaterThan(2);
      expect(recovered).toBe(source);

      await writeFile(join(first.root, 'restart.txt'), 'x'.repeat(Buffer.byteLength(source)));
      const restarted = await createHarness(first.root);
      try {
        await expect(
          restarted.send({
            id: 'stale-continuation',
            method: 'call',
            tool: 'read_file',
            args: { path: 'restart.txt', offset: 49152, limit: 49152, revision },
          }),
        ).resolves.toMatchObject({ ok: false, error: 'file changed while reading' });
      } finally {
        await restarted.close();
      }
    } finally {
      await first.close();
    }
  });

  it('inspects the complete large Adelic orchestrator through the real runner read_file tool', async () => {
    const harness = await createHarness(process.cwd());
    try {
      const expected = await readFile(join(process.cwd(), 'server/orchestrator.ts'), 'utf8');
      expect(Buffer.byteLength(expected, 'utf8')).toBeGreaterThan(128 * 1024);
      let offset = 0;
      let content = '';
      let pages = 0;
      let revision = '';
      for (;;) {
        const response = await harness.send({
          id: `orchestrator-${offset}`,
          method: 'call',
          tool: 'read_file',
          args: { path: 'server/orchestrator.ts', offset, limit: 49152, ...(revision ? { revision } : {}) },
        });
        expect(response.ok).toBe(true);
        const page = response.result as {
          content: string;
          offset: number;
          totalBytes: number;
          truncated: boolean;
          nextOffset: number;
          revision: string;
        };
        expect(page.offset).toBe(offset);
        expect(page.totalBytes).toBe(Buffer.byteLength(expected, 'utf8'));
        content += page.content;
        revision = page.revision;
        offset = page.nextOffset;
        pages++;
        if (!page.truncated) break;
      }
      expect(pages).toBeGreaterThan(2);
      expect(content).toBe(expected);
      expect(offset).toBe(Buffer.byteLength(expected, 'utf8'));
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

  it('serializes concurrent edits from separate runner processes and revalidates the shared revision', async () => {
    const project = await mkdtemp(join(tmpdir(), 'adelic-shared-edit-'));
    roots.push(project);
    await writeFile(join(project, 'shared.txt'), 'target');
    const first = await createHarness(project);
    const second = await createHarness(project);
    try {
      const initial = await first.send({
        id: 'initial',
        method: 'call',
        tool: 'read_file',
        args: { path: 'shared.txt' },
      });
      const revision = (initial.result as { revision: string }).revision;
      const [a, b] = await Promise.all([
        first.send({
          id: 'edit-a',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'shared.txt', oldText: 'target', newText: 'alpha', expectedRevision: revision },
        }),
        second.send({
          id: 'edit-b',
          method: 'call',
          tool: 'replace_text',
          args: { path: 'shared.txt', oldText: 'target', newText: 'bravo', expectedRevision: revision },
        }),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect([a, b].filter((item) => !item.ok)).toMatchObject([{ error: 'file changed before edit' }]);
      expect(['alpha', 'bravo']).toContain(await readFile(join(project, 'shared.txt'), 'utf8'));
    } finally {
      await Promise.all([first.close(), second.close()]);
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
