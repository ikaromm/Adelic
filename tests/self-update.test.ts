// "Atualizar Adelic" in a git checkout (docs/specs/self-update.md), against real temporary
// repositories: a bare "origin" with master and develop, a "dev" clone that publishes
// commits, and the "app" clone the updater works on. npm and the restart are injected.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../shared/contracts.js';
import {
  SelfUpdateService,
  checkoutState,
  detectInstall,
  respawnCommand,
  type NpmRunner,
  type UpdateGuard,
} from '../server/self-update.js';
import { gitIn } from './git-fixtures.js';

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false'];
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function commit(dir: string, files: Record<string, string>, message: string) {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  gitIn(dir, 'add', '-A');
  gitIn(dir, ...ID, 'commit', '-qm', message);
}

/** origin (bare) with master and develop, an upstream "dev" clone, and the app checkout on master. */
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-selfupdate-')));
  dirs.push(base);
  const origin = join(base, 'origin.git');
  const dev = join(base, 'dev');
  const app = join(base, 'app');
  gitIn(base, 'init', '-q', '--bare', '-b', 'master', origin);
  gitIn(base, 'init', '-q', '-b', 'master', dev);
  gitIn(dev, 'remote', 'add', 'origin', origin);
  commit(
    dev,
    {
      'package.json': JSON.stringify({ name: 'adelic', version: '0.4.0' }),
      'package-lock.json': '{"lockfileVersion":3}\n',
      '.gitignore': 'dist/\n.adelic/\nnode_modules/\n',
      'version.txt': 'v1\n',
    },
    'init',
  );
  gitIn(dev, 'push', '-q', '-u', 'origin', 'master');
  gitIn(dev, 'checkout', '-q', '-b', 'develop');
  commit(dev, { 'version.txt': 'develop-1\n' }, 'develop work');
  gitIn(dev, 'push', '-q', 'origin', 'develop');
  gitIn(dev, 'checkout', '-q', 'master');
  gitIn(base, 'clone', '-q', origin, app);
  gitIn(app, 'branch', '-q', '--track', 'develop', 'origin/develop');
  // The build being served now.
  mkdirSync(join(app, 'dist'));
  writeFileSync(join(app, 'dist', 'index.html'), 'old build v1');
  return { base, origin, dev, app };
}

const publish = (dev: string, branch: string, files: Record<string, string>, message: string) => {
  gitIn(dev, 'checkout', '-q', branch);
  commit(dev, files, message);
  gitIn(dev, 'push', '-q', 'origin', branch);
};

/** Fake npm: `ci` is recorded; `run build -- --outDir X` writes X/index.html from version.txt, or fails on BUILD_FAILS. */
function fakeNpm() {
  const calls: string[][] = [];
  const npm: NpmRunner = vi.fn(async (args, { cwd, onOutput }) => {
    calls.push(args);
    onOutput(`> npm ${args.join(' ')}\n`);
    if (args[0] === 'ci') return;
    if (existsSync(join(cwd, 'BUILD_FAILS'))) throw new Error('npm run saiu com 1');
    const out = args[args.indexOf('--outDir') + 1];
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'index.html'), `new build ${readFileSync(join(cwd, 'version.txt'), 'utf8').trim()}`);
  });
  return { npm, calls };
}

function guard(blocked?: () => string | undefined) {
  const released = vi.fn();
  const g: UpdateGuard & { released: typeof released; begun: number } = {
    begun: 0,
    released,
    block: () => blocked?.(),
    begin: () => {
      const reason = blocked?.();
      if (reason) throw Object.assign(new Error(reason), { status: 409 });
      g.begun++;
      return released;
    },
  };
  return g;
}

const settings = (patch: Partial<Settings> = {}) => ({ ...patch }) as Settings;

async function settle(service: SelfUpdateService) {
  for (let i = 0; i < 200; i++) {
    const progress = service.progress();
    if (progress.state === 'failed' || progress.state === 'restarting' || progress.state === 'idle') return progress;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error('update did not finish');
}

function service(app: string, npm: NpmRunner, restart = vi.fn()) {
  return { updater: new SelfUpdateService({ kind: 'checkout', appRoot: app, npm, restart }), restart };
}

const head = (dir: string) => gitIn(dir, 'rev-parse', 'HEAD').trim();

describe('install detection', () => {
  it('detects a checkout only at the top of an Adelic work tree', async () => {
    const { app, base } = fixture();
    expect(await detectInstall({ cwd: app, env: {}, electron: false })).toEqual({ kind: 'checkout', root: app });
    mkdirSync(join(app, 'sub'));
    writeFileSync(join(app, 'sub', 'package.json'), '{"name":"adelic"}');
    expect((await detectInstall({ cwd: join(app, 'sub'), env: {}, electron: false })).kind).toBe('other');
    writeFileSync(join(base, 'package.json'), '{"name":"adelic"}');
    expect((await detectInstall({ cwd: base, env: {}, electron: false })).kind).toBe('other');
    writeFileSync(join(app, 'package.json'), '{"name":"outro"}');
    expect((await detectInstall({ cwd: app, env: {}, electron: false })).kind).toBe('other');
  });
  it('detects the AppImage only inside Electron', async () => {
    expect((await detectInstall({ env: { APPIMAGE: '/x/Adelic.AppImage' }, electron: true })).kind).toBe('appimage');
    expect((await detectInstall({ env: { APPIMAGE: '/x/Adelic.AppImage' }, electron: false })).kind).toBe('other');
    expect((await detectInstall({ env: {}, electron: true })).kind).toBe('other');
  });
});

describe('checkout status', () => {
  it('reports commits behind with their subjects after a fetch, and nothing before one', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: segunda versão');
    publish(dev, 'master', { 'other.txt': 'x\n' }, 'fix: outra coisa');
    const { updater } = service(app, fakeNpm().npm);
    const before = await updater.status(settings(), guard());
    expect(before).toMatchObject({ kind: 'checkout', available: false, canApply: false, channel: 'master' });
    expect(before.checkedAt).toBeUndefined();
    const status = await updater.check(settings(), guard());
    expect(status).toMatchObject({
      available: true,
      canApply: true,
      commit: head(app).slice(0, 12),
      checkout: { branch: 'master', behind: 2, ahead: 0, clean: true, install: false },
    });
    expect(status.checkout!.commits.map((c) => c.subject)).toEqual(['fix: outra coisa', 'feat: segunda versão']);
    expect(status.target).toBe(gitIn(dev, 'rev-parse', 'master').trim());
  });

  it('checks the network on its own only when Settings.updateCheck is on', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    const { updater } = service(app, fakeNpm().npm);
    expect((await updater.status(settings(), guard())).available).toBe(false);
    expect((await updater.status(settings({ updateCheck: true }), guard())).available).toBe(true);
  });

  it('caps the list at 10 commits and limits each subject', async () => {
    const { app, dev } = fixture();
    for (let i = 0; i < 12; i++) publish(dev, 'master', { 'n.txt': `${i}\n` }, `commit ${i} ${'x'.repeat(300)}`);
    const status = await service(app, fakeNpm().npm).updater.check(settings(), guard());
    expect(status.checkout!.behind).toBe(12);
    expect(status.checkout!.commits).toHaveLength(10);
    expect(status.checkout!.commits[0].subject.length).toBe(200);
  });

  it('flags a lockfile change, so npm ci will run', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'package-lock.json': '{"lockfileVersion":3,"x":1}\n' }, 'chore: deps');
    expect((await service(app, fakeNpm().npm).updater.check(settings(), guard())).checkout!.install).toBe(true);
  });

  it('refuses with changed tracked files, but not with untracked ones', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    const { updater } = service(app, fakeNpm().npm);
    writeFileSync(join(app, 'untracked.txt'), 'meu\n');
    expect(await updater.check(settings(), guard())).toMatchObject({ canApply: true });
    writeFileSync(join(app, 'version.txt'), 'editado\n');
    const dirty = await updater.check(settings(), guard());
    expect(dirty).toMatchObject({ available: true, canApply: false, checkout: { clean: false } });
    expect(dirty.blocked).toMatch(/alterações em arquivos rastreados/);
    await expect(updater.apply(settings(), guard(), {})).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(app, 'version.txt'), 'utf8')).toBe('editado\n');
  });

  it('refuses when local commits are ahead or the branch diverged', async () => {
    const { app, dev } = fixture();
    commit(app, { 'local.txt': 'meu\n' }, 'local');
    const { updater } = service(app, fakeNpm().npm);
    const ahead = await updater.check(settings(), guard());
    expect(ahead).toMatchObject({ available: false, checkout: { ahead: 1, behind: 0 } });
    expect(ahead.blocked).toMatch(/1 commit\(s\) locais/);
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    const diverged = await updater.check(settings(), guard());
    expect(diverged).toMatchObject({ available: false, canApply: false, checkout: { ahead: 1, behind: 1 } });
    expect(diverged.blocked).toMatch(/divergiu/);
    const before = head(app);
    await expect(updater.apply(settings(), guard(), {})).rejects.toThrow(/divergiu/);
    expect(head(app)).toBe(before);
  });

  it('refuses while a run or another operation is active', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    const { updater } = service(app, fakeNpm().npm);
    const busy = guard(() => 'Há uma execução em andamento; aguarde ou cancele antes de atualizar');
    const status = await updater.check(settings(), busy);
    expect(status).toMatchObject({ available: true, canApply: false, blocked: expect.stringMatching(/execução/) });
    await expect(updater.apply(settings(), busy, {})).rejects.toMatchObject({ status: 409 });
    expect(busy.begun).toBe(0);
  });

  it('offers switching to the channel branch only when clean and a fast-forward', async () => {
    const { app, dev } = fixture();
    const { updater } = service(app, fakeNpm().npm);
    const status = await updater.check(settings({ updateChannel: 'develop' }), guard());
    expect(status).toMatchObject({
      channel: 'develop',
      available: true,
      canApply: true,
      checkout: { branch: 'master', switchTo: 'develop', behind: 0 },
    });
    publish(dev, 'develop', { 'version.txt': 'develop-2\n' }, 'feat: prévia');
    expect((await updater.check(settings(), guard(), 'develop')).checkout).toMatchObject({
      switchTo: 'develop',
      behind: 1,
    });
    writeFileSync(join(app, 'version.txt'), 'editado\n');
    const dirty = await updater.check(settings(), guard(), 'develop');
    expect(dirty).toMatchObject({ canApply: false });
    expect(dirty.blocked).toMatch(/para trocar para develop/);
  });

  it('does not offer a switch when no local branch tracks the channel', async () => {
    const { app } = fixture();
    gitIn(app, 'branch', '-q', '-D', 'develop');
    const status = await service(app, fakeNpm().npm).updater.check(settings(), guard(), 'develop');
    expect(status.canApply).toBe(false);
    expect(status.blocked).toMatch(/não há um branch local develop/);
  });

  it('reports a fetch failure without breaking the status', async () => {
    const { app } = fixture();
    gitIn(app, 'remote', 'set-url', 'origin', join(app, 'nao-existe.git'));
    const status = await service(app, fakeNpm().npm).updater.check(settings(), guard());
    expect(status).toMatchObject({
      available: false,
      error: expect.stringMatching(/Não foi possível buscar origin\/master/),
    });
  });

  it('refuses repositories whose config defines filters that run programs', async () => {
    const { app, base, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    const marker = join(base, 'filter-ran');
    gitIn(app, 'config', 'filter.evil.clean', `touch ${marker}`);
    gitIn(app, 'config', 'filter.evil.smudge', `touch ${marker}`);
    writeFileSync(join(app, '.git', 'info', 'attributes'), '* filter=evil\n');
    const state = await checkoutState(app, 'master', true);
    expect(state.blocked).toMatch(/filtros que executam programas/);
    await expect(service(app, fakeNpm().npm).updater.apply(settings(), guard(), {})).rejects.toThrow(/filtros/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('checkout update', () => {
  it('fast-forwards, builds aside, swaps dist and restarts once', async () => {
    const { app, dev, base } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: segunda versão');
    // Hooks in the app's .git must never run.
    const marker = join(base, 'hook-ran');
    for (const hook of ['post-merge', 'post-checkout', 'reference-transaction']) {
      writeFileSync(join(app, '.git', 'hooks', hook), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(app, '.git', 'hooks', hook), 0o755);
    }
    gitIn(app, 'config', 'hook.planted.event', 'post-merge');
    gitIn(app, 'config', 'hook.planted.command', `touch '${marker}'`);
    const { npm, calls } = fakeNpm();
    const { updater, restart } = service(app, npm);
    const g = guard();
    const status = await updater.check(settings(), g);
    const started = await updater.apply(settings(), g, { target: status.target });
    expect(started.state).toBe('running');
    const done = await settle(updater);
    expect(done.state).toBe('restarting');
    expect(restart).toHaveBeenCalledTimes(1);
    expect(head(app)).toBe(gitIn(dev, 'rev-parse', 'master').trim());
    expect(readFileSync(join(app, 'dist', 'index.html'), 'utf8')).toBe('new build v2');
    expect(calls).toEqual([['run', 'build', '--', '--outDir', expect.stringContaining(join(app, '.adelic'))]]);
    expect(done.steps.map((s) => [s.id, s.status])).toEqual([
      ['fetch', 'done'],
      ['switch', 'skipped'],
      ['merge', 'done'],
      ['install', 'skipped'],
      ['build', 'done'],
      ['restart', 'done'],
    ]);
    expect(done.target).toBe(head(app).slice(0, 12));
    expect(done.log).toContain('npm run build');
    expect(existsSync(marker)).toBe(false);
    // Runs stay held off until the process is replaced.
    expect(g.released).not.toHaveBeenCalled();
    // No leftover build folders.
    expect(
      gitIn(app, 'status', '--porcelain', '--ignored')
        .split('\n')
        .filter((l) => l.includes('.adelic/update')),
    ).toEqual([]);
    expect(existsSync(join(app, '.adelic'))).toBe(true);
    expect(gitIn(app, 'ls-files', '--others', '--exclude-standard')).toBe('');
  });

  it('runs npm ci when package-lock.json changed', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'package-lock.json': '{"lockfileVersion":3,"x":1}\n', 'version.txt': 'v2\n' }, 'deps');
    const { npm, calls } = fakeNpm();
    const { updater } = service(app, npm);
    await updater.check(settings(), guard());
    await updater.apply(settings(), guard(), {});
    expect((await settle(updater)).steps.find((s) => s.id === 'install')?.status).toBe('done');
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ['ci', '--no-audit'],
      ['run', 'build'],
    ]);
  });

  it('keeps the old dist and resets HEAD when the build fails', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { BUILD_FAILS: 'x\n', 'package-lock.json': '{"x":2}\n' }, 'broken');
    const before = head(app);
    const { npm, calls } = fakeNpm();
    const { updater, restart } = service(app, npm);
    const g = guard();
    await updater.check(settings(), g);
    await updater.apply(settings(), g, {});
    const done = await settle(updater);
    expect(done).toMatchObject({ state: 'failed', error: expect.stringMatching(/npm run saiu com 1/) });
    expect(done.steps.find((s) => s.id === 'build')?.status).toBe('failed');
    expect(done.steps.find((s) => s.id === 'restart')?.status).toBe('skipped');
    expect(head(app)).toBe(before);
    expect(existsSync(join(app, 'BUILD_FAILS'))).toBe(false);
    expect(readFileSync(join(app, 'dist', 'index.html'), 'utf8')).toBe('old build v1');
    expect(gitIn(app, 'status', '--porcelain')).toBe('');
    expect(restart).not.toHaveBeenCalled();
    expect(g.released).toHaveBeenCalledTimes(1);
    // The previous dependencies are reinstalled after the lockfile went back.
    expect(calls.map((c) => c[0])).toEqual(['ci', 'run', 'ci']);
    expect(done.log).toContain(`HEAD voltou para ${before.slice(0, 12)}`);
  });

  it('refuses when origin moved since the confirmation', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    const { updater, restart } = service(app, fakeNpm().npm);
    const status = await updater.check(settings(), guard());
    publish(dev, 'master', { 'version.txt': 'v3\n' }, 'feat: mais nova');
    const before = head(app);
    await updater.apply(settings(), guard(), { target: status.target });
    expect(await settle(updater)).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/mudou desde a verificação/),
    });
    expect(head(app)).toBe(before);
    expect(restart).not.toHaveBeenCalled();
  });

  it('refuses a second update while one runs', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    let finish!: () => void;
    const slow: NpmRunner = async (args, options) => {
      await new Promise<void>((done) => (finish = done));
      return fakeNpm().npm(args, options);
    };
    const { updater } = service(app, slow);
    await updater.check(settings(), guard());
    // Two clicks at once: only one starts.
    const both = await Promise.allSettled([
      updater.apply(settings(), guard(), {}),
      updater.apply(settings(), guard(), {}),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(updater.apply(settings(), guard(), {})).rejects.toMatchObject({ status: 409 });
    expect((await updater.status(settings(), guard())).busy).toBe(true);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish();
    expect((await settle(updater)).state).toBe('restarting');
  });

  it('switches to the develop channel and fast-forwards it', async () => {
    const { app, dev } = fixture();
    publish(dev, 'develop', { 'version.txt': 'develop-2\n' }, 'feat: prévia');
    const { updater, restart } = service(app, fakeNpm().npm);
    await updater.check(settings(), guard(), 'develop');
    await updater.apply(settings(), guard(), { channel: 'develop' });
    const done = await settle(updater);
    expect(done.steps.find((s) => s.id === 'switch')?.status).toBe('done');
    expect(gitIn(app, 'branch', '--show-current').trim()).toBe('develop');
    expect(head(app)).toBe(gitIn(dev, 'rev-parse', 'develop').trim());
    expect(readFileSync(join(app, 'dist', 'index.html'), 'utf8')).toBe('new build develop-2');
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('goes back to the starting branch when a channel switch fails to build', async () => {
    const { app, dev } = fixture();
    publish(dev, 'develop', { BUILD_FAILS: 'x\n' }, 'broken preview');
    const developBefore = gitIn(app, 'rev-parse', 'develop').trim();
    const masterBefore = head(app);
    const { updater } = service(app, fakeNpm().npm);
    await updater.check(settings(), guard(), 'develop');
    await updater.apply(settings(), guard(), { channel: 'develop' });
    expect((await settle(updater)).state).toBe('failed');
    expect(gitIn(app, 'branch', '--show-current').trim()).toBe('master');
    expect(head(app)).toBe(masterBefore);
    expect(gitIn(app, 'rev-parse', 'develop').trim()).toBe(developBefore);
    expect(gitIn(app, 'status', '--porcelain')).toBe('');
  });

  it('reports a restart failure without undoing the applied update', async () => {
    const { app, dev } = fixture();
    publish(dev, 'master', { 'version.txt': 'v2\n' }, 'feat: nova');
    const restart = vi.fn(async () => {
      throw new Error('spawn falhou');
    });
    const { updater } = service(app, fakeNpm().npm, restart);
    await updater.check(settings(), guard());
    await updater.apply(settings(), guard(), {});
    const done = await settle(updater);
    expect(done).toMatchObject({ state: 'failed', error: expect.stringMatching(/reinicie o Adelic manualmente/) });
    expect(head(app)).toBe(gitIn(dev, 'rev-parse', 'master').trim());
  });

  it('says so when there is nothing to update', async () => {
    const { app } = fixture();
    const { updater } = service(app, fakeNpm().npm);
    expect(await updater.check(settings(), guard())).toMatchObject({ available: false, canApply: false });
    await updater.apply(settings(), guard(), {});
    expect(await settle(updater)).toMatchObject({ state: 'failed', error: 'O Adelic já está atualizado' });
  });
});

describe('other installs', () => {
  it('shows the version and the release link only', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://github.com/ikaromm/Adelic/releases/tag/v99.0.0' }),
        ),
    );
    const updater = new SelfUpdateService({ kind: 'other', appImage: { fetcher } });
    const status = await updater.check(settings(), guard());
    expect(status).toMatchObject({ kind: 'other', available: true, canApply: false, release: { latest: '99.0.0' } });
    expect(status.blocked).toMatch(/não se atualiza sozinha/);
    await expect(updater.apply(settings(), guard(), {})).rejects.toMatchObject({ status: 400 });
  });
});

describe('restart command', () => {
  it('goes through the tsx wrapper under npm start, with the script as typed', () => {
    const cwd = '/srv/adelic';
    const proc = {
      execPath: '/usr/bin/node',
      execArgv: [
        '--require',
        '/srv/adelic/node_modules/tsx/dist/preflight.cjs',
        '--import',
        'file:///x/tsx/dist/loader.mjs',
      ],
      argv: ['/usr/bin/node', '/srv/adelic/server/cli.ts', '--flag'],
    };
    expect(respawnCommand(proc, cwd, () => true)).toEqual({
      file: '/usr/bin/node',
      args: ['/srv/adelic/node_modules/.bin/tsx', 'server/cli.ts', '--flag'],
    });
    expect(respawnCommand(proc, cwd, () => false).args).toEqual([
      ...proc.execArgv,
      '/srv/adelic/server/cli.ts',
      '--flag',
    ]);
    const plain = {
      execPath: '/usr/bin/node',
      execArgv: ['--max-old-space-size=100'],
      argv: ['/usr/bin/node', 'cli.js'],
    };
    expect(respawnCommand(plain, cwd, () => true)).toEqual({
      file: '/usr/bin/node',
      args: ['--max-old-space-size=100', 'cli.js'],
    });
  });
});
