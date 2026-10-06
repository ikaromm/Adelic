import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonWritePathWithin, classifyApproval, scanCodexRules } from '../server/approval-policy';

describe('classifyApproval', () => {
  let root: string; let bindir: string; let oldPath: string | undefined;
  beforeEach(async () => { const temp = path.join(process.cwd(), '.adelic/test-tmp'); await mkdir(temp,{recursive:true}); root = path.join(temp, `approval-test-${randomUUID()}`); await mkdir(root); bindir = path.join(root, 'bin'); await mkdir(bindir); oldPath = process.env.PATH; process.env.PATH = `/usr/bin:/bin:${bindir}`; await writeFile(path.join(root,'note.txt'),'ok'); await mkdir(path.join(root,'sub')); });
  afterEach(async () => { process.env.PATH = oldPath; await rm(root,{recursive:true,force:true}); });
  const run = (command: unknown, extra: Record<string, unknown> = {}) => classifyApproval({tools:true,kind:'command',command,cwd:root,workspace:root,sandbox:'workspace-write',...extra} as never);
  it('allows exact safe commands and safe workspace reads', async () => {
    expect((await run('pwd')).decision).toBe('auto');
    expect((await run('ls -la note.txt')).decision).toBe('auto');
    expect((await run('rg --no-config -n literal note.txt')).decision).toBe('auto');
    expect((await run('uname -a')).decision).toBe('auto');
    expect((await run('/usr/bin/uname -a')).decision).toBe('auto');
    expect((await run('pactl list sources')).decision).toBe('auto');
    expect((await run('/usr/bin/bash -c "uname -a"',{trustedNonLoginShell:true})).decision).toBe('auto');
    expect((await run('/bin/bash --noprofile --norc -c "pactl list sources"',{trustedNonLoginShell:true})).decision).toBe('auto');
  });
  it('leaves destructive, compound and expansion syntax pending', async () => {
    for (const c of ['rm note.txt','pwd; id','pwd $(id)','cat note.txt > copy','whoami &','FOO=bar pwd','bash -lc pwd','bash -lc "uname -a"','/usr/bin/bash -c "uname -a; id"','/usr/bin/bash -c "rm note.txt"','/usr/bin/bash -c "uname -a" extra','/usr/bin/bash -i -c "uname -a"','python -c x']) expect((await run(c,{trustedNonLoginShell:true})).decision).toBe('pending');
    expect((await run('/usr/bin/bash -c "uname -a"',{trustedNonLoginShell:false})).decision).toBe('pending');
  });
  it('rejects sensitive, external, missing and symlinked paths', async () => {
    await writeFile(path.join(root,'.env'),'secret'); await symlink('/etc/passwd',path.join(root,'escape'));
    for (const c of ['cat .env','cat escape','cat missing']) expect((await run(c)).decision).toBe('pending');
    expect((await run('cat /etc/passwd')).decision).toBe('pending');
  });
  it('requires rg no-config and rejects unsupported flags and wrappers', async () => {
    expect((await run('rg thing note.txt')).decision).toBe('pending');
    expect((await run('rg --no-config --pre cat thing note.txt')).decision).toBe('pending');
    expect((await run('bash -c "pwd"')).decision).toBe('pending');
    for (const c of ['rg --no-config --pre=evil pattern README','rg --no-config --hidden pattern README','rg --no-config --files pattern README','rg --no-config pattern','rg --no-config -z pattern README']) expect((await run(c)).decision).toBe('pending');
  });
  it('preserves empty argv tokens so rg cannot skip a sensitive positional file', async () => {
    await writeFile(path.join(root, '.env'), 'synthetic-secret');
    expect((await run("rg --no-config '' .env note.txt")).decision).toBe('pending');
    expect((await run("rg --no-config '' note.txt")).decision).toBe('auto');
  });
  it('rejects newlines, glob metacharacters, directory reads and sensitive lexical aliases', async () => {
    await mkdir(path.join(root,'nested')); await writeFile(path.join(root,'nested','secret.txt'),'not read');
    await writeFile(path.join(root,'.env-public'),'secret'); await symlink(path.join(root,'note.txt'),path.join(root,'.env-alias'));
    for (const c of ['ls\nrm target','cat note.txt\r rm target','cat *.txt','cat "[note].txt"','cat nested','rg --no-config x nested','cat .env-public','cat .env-alias']) expect((await run(c)).decision).toBe('pending');
  });
  it('manual, no-tools, missing fields and shadowed executable fail closed', async () => {
    expect((await run('pwd',{mode:'manual'})).decision).toBe('pending');
    expect((await run('pwd',{tools:[]})).decision).toBe('deny');
    expect((await run('pwd',{tools:['command']})).decision).toBe('deny');
    expect((await run(undefined)).decision).toBe('pending');
    await writeFile(path.join(bindir,'pwd'),'#!/bin/sh\n');
    await chmod(path.join(bindir,'pwd'),0o755);
    process.env.PATH = `${bindir}:/usr/bin:/bin`;
    expect((await run('pwd')).decision).toBe('pending');
  });
  it('accepts only exact flags and refuses paths outside canonical workspace', async () => {
    expect((await run('uname --help')).decision).toBe('pending');
    expect((await run('cat /etc/hosts')).decision).toBe('pending');
    expect((await run('pwd',{cwd:'/tmp'})).decision).toBe('pending');
  });
  it('scans injected isolated rule roots and fails closed only when a .rules file exists', async () => {
    const home = path.join(root,'home'), system = path.join(root,'etc'), project = path.join(root,'project');
    await mkdir(path.join(home,'rules'),{recursive:true}); await mkdir(path.join(system,'rules'),{recursive:true}); await mkdir(path.join(project,'.codex','rules'),{recursive:true});
    await expect(scanCodexRules({cwd:project,codexHome:home,systemRoot:system})).resolves.toBeUndefined();
    await writeFile(path.join(project,'.codex','rules','block.rules'),'not read');
    await expect(scanCodexRules({cwd:project,codexHome:home,systemRoot:system})).rejects.toThrow(/\.rules/);
  });
  it('rejects slash-containing relative executable names', async () => {
    expect((await run('../bin/ls note.txt')).decision).toBe('pending');
  });
  it('canonicalizes write targets and fails closed on outside and dangling symlink paths', async () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-sibling`);
    await mkdir(outside);
    await writeFile(path.join(root, 'inside.txt'), 'ok');
    await writeFile(path.join(outside, 'existing.txt'), 'outside');
    await symlink(path.join(outside, 'missing', 'new.txt'), path.join(root, 'dangling'));
    try {
      expect(await canonWritePathWithin(root, 'inside.txt')).toBe(path.join(root, 'inside.txt'));
      expect(await canonWritePathWithin(root, path.join(outside, 'existing.txt'))).toBeUndefined();
      expect(await canonWritePathWithin(root, 'dangling')).toBeUndefined();
      expect(await canonWritePathWithin(root, 'new/subdir/file.txt')).toBe(path.join(root, 'new/subdir/file.txt'));
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
