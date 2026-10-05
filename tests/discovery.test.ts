import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopPath, findProviderBinary } from '../server/providers/discovery';

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function tempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adelic-discovery-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(file: string, contents = '#!/bin/sh\nexit 0\n', mode = 0o755) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
  return file;
}

describe('provider binary discovery', () => {
  it('prefers direct mise installs over local and PATH wrappers', async () => {
    const root = await tempDir();
    const miseBin = await executable(path.join(root, 'mise/installs/codex/0.99.0/bin/codex'));
    await executable(path.join(root, 'home/.local/bin/codex'));
    const pathBin = await executable(path.join(root, 'path/codex'));

    await expect(findProviderBinary('codex', {
      HOME: path.join(root, 'home'), MISE_DATA_DIR: path.join(root, 'mise'), PATH: path.dirname(pathBin),
    })).resolves.toBe(miseBin);
  });

  it('uses a valid explicit override and never falls through from an invalid one', async () => {
    const root = await tempDir();
    const override = await executable(path.join(root, 'custom/claude'));
    const invalidOverride = await executable(path.join(root, 'custom/not-executable-claude'), '#!/bin/sh\n', 0o644);
    await executable(path.join(root, 'home/.local/bin/claude'));
    const pathBinary = await executable(path.join(root, 'path/claude'));

    await expect(findProviderBinary('claude', {
      HOME: path.join(root, 'home'), ADELIC_CLAUDE_BIN: override, PATH: path.dirname(pathBinary),
    })).resolves.toBe(override);
    await expect(findProviderBinary('claude', {
      HOME: path.join(root, 'home'), ADELIC_CLAUDE_BIN: invalidOverride, PATH: path.dirname(pathBinary),
    })).resolves.toBeUndefined();
  });

  it('rejects non-files and files without execute permission', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    await executable(path.join(home, '.local/bin/kiro-cli'), '#!/bin/sh\n', 0o644);
    const pathBinary = await executable(path.join(root, 'path/kiro-cli'), '#!/bin/sh\n', 0o644);

    await expect(findProviderBinary('kiro', { HOME: home, PATH: path.dirname(pathBinary) })).resolves.toBeUndefined();
  });

  it('finds official per-user CLI locations before PATH', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    const official = await executable(path.join(home, '.claude/local/claude'));
    const pathBinary = await executable(path.join(root, 'path/claude'));

    await expect(findProviderBinary('claude', { HOME: home, PATH: path.dirname(pathBinary) })).resolves.toBe(official);
  });

  it('finds Kiro under the direct mise tool name and uses PATH as the last fallback', async () => {
    const root = await tempDir();
    const kiro = await executable(path.join(root, 'mise/installs/kiro/1.2.3/bin/kiro-cli'));
    await expect(findProviderBinary('kiro', { HOME: path.join(root, 'home'), MISE_DATA_DIR: path.join(root, 'mise'), PATH: '' })).resolves.toBe(kiro);

    const opencode = await executable(path.join(root, 'path/opencode'));
    await expect(findProviderBinary('opencode', { HOME: path.join(root, 'home'), PATH: path.dirname(opencode) })).resolves.toBe(opencode);
  });
});

describe('desktop PATH construction', () => {
  it('adds local, mise, system, and inherited executable directories without duplicates', async () => {
    const root = await tempDir();
    const home = path.join(root, 'home');
    const localBin = path.join(home, '.local/bin');
    const miseNodeBin = path.join(root, 'mise/installs/node/22.12.0/bin');
    const inherited = path.join(root, 'custom/bin');
    await Promise.all([localBin, miseNodeBin, inherited].map((directory) => mkdir(directory, { recursive: true })));

    const entries = desktopPath({
      HOME: home,
      MISE_DATA_DIR: path.join(root, 'mise'),
      PATH: [inherited, localBin, inherited].join(path.delimiter),
    }).split(path.delimiter);

    expect(entries).toContain(localBin);
    expect(entries).toContain(miseNodeBin);
    expect(entries).toContain(inherited);
    expect(entries.filter((entry) => entry === inherited)).toHaveLength(1);
    expect(entries).toContain('/usr/local/bin');
    expect(entries).toContain('/usr/bin');
    expect(entries).toContain('/bin');
  });
});
