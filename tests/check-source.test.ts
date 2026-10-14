import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { observeCheckSource } from '../server/check-source.js';
import { HookChecks } from '../server/hooks.js';
import type { RunEvent } from '../shared/contracts.js';
import type { AfterEditCheck } from '../shared/hooks.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'adelic-check-source-'));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  writeFileSync(join(root, 'src.ts'), 'export const value = 1;\n');
  execFileSync('git', ['add', 'src.ts'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
};
const check = (command: string): AfterEditCheck => ({ name: 'regression', command, timeoutSec: 10, enabled: true });

describe('check source and environment evidence', () => {
  it('fingerprints a dirty tracked and untracked source tree, not HEAD, and correlates failed real checks', async () => {
    const root = fixture();
    const baseline = observeCheckSource(root, 'run-baseline');
    writeFileSync(join(root, 'src.ts'), 'export const value = 2;\n');
    writeFileSync(join(root, 'untracked.ts'), 'export const local = true;\n');
    const dirty = observeCheckSource(root, 'run-dirty');
    expect(dirty.state).toBe('verified');
    expect(dirty.revision?.value).not.toBe(baseline.revision?.value);
    expect(dirty.scope).toBe('filesystem-except-.git-and-node_modules');

    const events: RunEvent[] = [];
    const hooks = new HookChecks({
      saveEvent: (event) => events.push(event),
      startFix: async () => undefined,
    });
    await hooks.start(
      'project',
      root,
      'workspace-write',
      { id: 'run-dirty', sessionId: 'session' },
      [check('exit 7')],
      false,
    );
    const result = events.filter((event) => event.check?.status === 'failed').at(-1)?.check;
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 7,
      source: { runId: 'run-dirty', state: 'verified' },
      environment: { state: 'observed', digest: expect.any(String) },
    });
    expect(result?.source?.revision?.value).toBe(dirty.revision?.value);
    expect(JSON.stringify(result)).not.toContain(process.env.HOME ?? '/unlikely-home');
  });

  it('marks a source changed when the actual check runner mutates it during a failing check', async () => {
    const root = fixture();
    const file = join(root, 'src.ts');
    const events: RunEvent[] = [];
    const hooks = new HookChecks({
      saveEvent: (event) => events.push(event),
      startFix: async () => undefined,
    });
    await hooks.start(
      'project',
      root,
      'workspace-write',
      { id: 'run-mutation', sessionId: 'session' },
      [check('sleep 0.2; printf changed >> src.ts; exit 1')],
      false,
    );
    expect(readFileSync(file, 'utf8')).toContain('changed');
    expect(events.filter((event) => event.check?.status === 'failed').at(-1)?.check).toMatchObject({
      status: 'failed',
      exitCode: 1,
      source: { runId: 'run-mutation', state: 'changed' },
      environment: { state: 'observed' },
    });
  });

  it('detects transient source edits even when the check restores the final tree', async () => {
    const root = fixture();
    const events: RunEvent[] = [];
    const hooks = new HookChecks({ saveEvent: (event) => events.push(event), startFix: async () => undefined });
    await hooks.start(
      'project',
      root,
      'workspace-write',
      { id: 'run-transient-edit', sessionId: 'session' },
      [check('cp src.ts src.tmp; printf changed >> src.ts; mv src.tmp src.ts; exit 1')],
      false,
    );
    expect(readFileSync(join(root, 'src.ts'), 'utf8')).toBe('export const value = 1;\n');
    expect(events.filter((event) => event.check?.status === 'failed').at(-1)?.check).toMatchObject({
      status: 'failed',
      source: { runId: 'run-transient-edit', state: 'changed' },
    });
  });

  it('distinguishes binary content from record boundaries and is stable for identical trees', () => {
    const oneFile = mkdtempSync(join(tmpdir(), 'adelic-check-source-one-'));
    const twoFiles = mkdtempSync(join(tmpdir(), 'adelic-check-source-two-'));
    const identical = mkdtempSync(join(tmpdir(), 'adelic-check-source-copy-'));
    dirs.push(oneFile, twoFiles, identical);
    const firstContent = Buffer.from([0x41, 0x00, 0x42]);
    const secondContent = Buffer.from([0xff, 0x00, 0x7f]);
    writeFileSync(join(twoFiles, 'a'), firstContent);
    writeFileSync(join(twoFiles, 'b'), secondContent);
    const mode = String(statSync(join(twoFiles, 'a')).mode & 0o777);

    // Under the old NUL-concatenation, this sole file's bytes encoded the following "b" record.
    writeFileSync(
      join(oneFile, 'a'),
      Buffer.concat([
        firstContent,
        Buffer.from([0, ...Buffer.from('b'), 0, ...Buffer.from(mode), 0, ...Buffer.from('file'), 0]),
        secondContent,
      ]),
    );
    writeFileSync(join(identical, 'a'), firstContent);
    writeFileSync(join(identical, 'b'), secondContent);

    const one = observeCheckSource(oneFile, 'one');
    const two = observeCheckSource(twoFiles, 'two');
    const copy = observeCheckSource(identical, 'copy');
    expect(one.state).toBe('verified');
    expect(two.state).toBe('verified');
    expect(one.revision?.value).not.toBe(two.revision?.value);
    expect(copy.revision?.value).toBe(two.revision?.value);
  });

  it('returns unknown rather than claiming a fingerprint when the source root is unavailable', () => {
    const missing = join(tmpdir(), 'adelic-does-not-exist-source');
    expect(existsSync(missing)).toBe(false);
    expect(observeCheckSource(missing, 'r')).toMatchObject({ runId: 'r', state: 'unknown' });
  });
});
