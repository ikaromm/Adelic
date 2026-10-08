import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sshConfigAliases } from '../server/remote/ssh-config';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('SSH config alias discovery', () => {
  it('lists literal aliases and nested Includes without evaluating commands or exposing options', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adelic-ssh-config-'));
    roots.push(root);
    await mkdir(join(root, 'parts'));
    const config = join(root, 'config');
    const canary = join(root, 'must-not-run');
    await writeFile(
      config,
      `Host main second # ignored-comment\n  HostName secret-address\n  IdentityFile secret-key\nHost *.example !excluded [ab] -bad\nInclude "${root}/parts/*.conf"\nMatch exec "touch ${canary}"\nHost = final\n`,
    );
    await writeFile(join(root, 'parts/one.conf'), `Host included\nInclude ${config}\n`);
    expect(await sshConfigAliases(config)).toEqual(['final', 'included', 'main', 'second']);
    const { existsSync } = await import('node:fs');
    expect(existsSync(canary)).toBe(false);
  });
  it('returns an empty list when the config is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adelic-ssh-config-'));
    roots.push(root);
    expect(await sshConfigAliases(join(root, 'missing'))).toEqual([]);
  });
});
