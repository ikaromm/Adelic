import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bubblewrap } from '../server/providers/sandbox.js';

function execute(command: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

describe.skipIf(!existsSync('/usr/bin/bwrap'))('bubblewrap workspace mounts under /tmp', () => {
  it('preserves a real temporary workspace with the requested read-only and write permissions', async ({ skip }) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'adelic-sandbox-test-'));
    const workspace = path.join(parent, 'conversations', 'session');
    const alias = path.join(parent, 'session-alias');
    try {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }));
      await writeFile(path.join(workspace, 'sentinel.txt'), 'visible');
      await symlink(workspace, alias);
      const canonicalWorkspace = await realpath(workspace);
      const probe = `printf 'PWD=%s\\n' "$PWD"; test -f sentinel.txt || exit 31; if touch write-probe 2>/dev/null; then echo WRITABLE; else echo READ_ONLY; fi`;

      const readOnly = await bubblewrap('/bin/sh', ['-c', probe], alias, 'read-only');
      const readResult = await execute(readOnly.command, readOnly.args);
      if (
        readResult.code !== 0 &&
        /No permissions to create a new namespace|Operation not permitted|Failed to set up namespace/i.test(
          readResult.output,
        )
      ) {
        skip(`bubblewrap cannot create namespaces in this environment: ${readResult.output.trim()}`);
      }
      expect(readResult.code, readResult.output).toBe(0);
      expect(readResult.output).toContain(`PWD=${canonicalWorkspace}`);
      expect(readResult.output).toContain('READ_ONLY');
      await expect(readFile(path.join(workspace, 'write-probe'))).rejects.toMatchObject({ code: 'ENOENT' });

      const writeCommand = await bubblewrap('/bin/sh', ['-c', probe], workspace, 'workspace-write');
      const writeResult = await execute(writeCommand.command, writeCommand.args);
      expect(writeResult.code, writeResult.output).toBe(0);
      expect(writeResult.output).toContain('WRITABLE');
      await expect(readFile(path.join(workspace, 'write-probe'), 'utf8')).resolves.toBe('');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('resolves a /tmp alias to its canonical workspace before hiding /tmp', async ({ skip }) => {
    const aliasRoot = await mkdtemp(path.join(os.tmpdir(), 'adelic-sandbox-alias-'));
    const alias = path.join(aliasRoot, 'repo-alias');
    try {
      await symlink(process.cwd(), alias);
      const canonical = await realpath(process.cwd());
      const wrapped = await bubblewrap(
        '/bin/sh',
        ['-c', `printf 'PWD=%s\\n' "$PWD"; test -f package.json`],
        alias,
        'read-only',
      );
      const result = await execute(wrapped.command, wrapped.args);
      if (
        result.code !== 0 &&
        /No permissions to create a new namespace|Operation not permitted|Failed to set up namespace/i.test(
          result.output,
        )
      ) {
        skip(`bubblewrap cannot create namespaces in this environment: ${result.output.trim()}`);
      }
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(`PWD=${canonical}`);
    } finally {
      await rm(aliasRoot, { recursive: true, force: true });
    }
  });

  it('keeps a /var/tmp workspace and an intentionally writable /tmp runtime directory in both modes', async ({
    skip,
  }) => {
    const workspace = await mkdtemp(path.join('/var/tmp', 'adelic-sandbox-workspace-'));
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'adelic-sandbox-runtime-'));
    try {
      await writeFile(path.join(workspace, 'sentinel.txt'), 'workspace');
      await writeFile(path.join(runtimeDir, 'runtime-sentinel.txt'), 'runtime');
      const probe = `test -f sentinel.txt && test -f "$1/runtime-sentinel.txt" || exit 31; if touch workspace-write-probe 2>/dev/null; then echo WORKSPACE_WRITABLE; else echo WORKSPACE_READ_ONLY; fi; touch "$1/runtime-write-probe"`;

      const readonly = await bubblewrap('/bin/sh', ['-c', probe, 'sandbox', runtimeDir], workspace, 'read-only', [
        runtimeDir,
      ]);
      const readonlyResult = await execute(readonly.command, readonly.args);
      if (
        readonlyResult.code !== 0 &&
        /No permissions to create a new namespace|Operation not permitted|Failed to set up namespace/i.test(
          readonlyResult.output,
        )
      ) {
        skip(`bubblewrap cannot create namespaces in this environment: ${readonlyResult.output.trim()}`);
      }
      expect(readonlyResult.code, readonlyResult.output).toBe(0);
      expect(readonlyResult.output).toContain('WORKSPACE_READ_ONLY');
      await expect(readFile(path.join(workspace, 'workspace-write-probe'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(runtimeDir, 'runtime-write-probe'))).resolves.toBeTruthy();

      await rm(path.join(runtimeDir, 'runtime-write-probe'));
      const writable = await bubblewrap('/bin/sh', ['-c', probe, 'sandbox', runtimeDir], workspace, 'workspace-write', [
        runtimeDir,
      ]);
      const writableResult = await execute(writable.command, writable.args);
      expect(writableResult.code, writableResult.output).toBe(0);
      expect(writableResult.output).toContain('WORKSPACE_WRITABLE');
      await expect(readFile(path.join(workspace, 'workspace-write-probe'))).resolves.toBeTruthy();
      await expect(readFile(path.join(runtimeDir, 'runtime-write-probe'))).resolves.toBeTruthy();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });
});
