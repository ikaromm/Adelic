// "Atualizar Adelic" (docs/specs/self-update.md). Detects how this Adelic runs and updates it
// only on an explicit request: a git checkout fast-forwards its branch and rebuilds; the
// desktop AppImage downloads the release asset, checks its SHA-256 and swaps the file. Both
// end with a restart. Nothing here runs on its own; the routes call it.
//
// Safety: every git command goes through the hardened runner of server/checkpoints.ts (no
// shell, timeouts, no prompts, hooks and fsmonitor off). The update refuses instead of
// guessing: changed tracked files, another branch, local commits, runs or git operations in
// progress. Until the new build succeeds the old dist stays in place, and any failure after
// the merge resets HEAD to where it was.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type {
  InstallKind,
  SelfUpdateStatus,
  Settings,
  UpdateChannel,
  UpdateProgress,
  UpdateStepId,
  UpdateStepStatus,
} from '../shared/contracts.js';
import { HARDENED_CONFIG, git, lines } from './checkpoints.js';
import { appImageCheck, applyAppImage, type AppImageOptions, type AppImageRelease } from './self-update-appimage.js';
import { checkForUpdate } from './updates.js';
// Static import: esbuild inlines it into the desktop bundle, where package.json is not on disk.
import pkg from '../package.json' with { type: 'json' };

export const RELEASES_PAGE = 'https://github.com/ikaromm/Adelic/releases';
export const LOG_LIMIT = 64 * 1024;
const NPM_TIMEOUT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const AUTO_CHECK_TTL_MS = 6 * 60 * 60_000;
/** Random per process: the UI knows the restart finished when it changes. */
export const BOOT_ID = randomUUID();

/** What an update needs from the orchestrator: refuse while busy, and hold new work off. */
export interface UpdateGuard {
  /** Why an update cannot start now (a run, undo, git operation…); undefined when idle. */
  block(): string | undefined;
  /** Starts holding runs and git operations off (throws 409 when blocked); returns the release. */
  begin(): () => void;
}

/** The routes talk to this interface; tests and the E2E server inject fakes. */
export interface SelfUpdater {
  status(settings: Settings, guard: UpdateGuard): Promise<SelfUpdateStatus>;
  check(settings: Settings, guard: UpdateGuard, channel?: UpdateChannel): Promise<SelfUpdateStatus>;
  /** Starts the update in the background; progress() reports it. Throws 409 when refused. */
  apply(
    settings: Settings,
    guard: UpdateGuard,
    options: { channel?: UpdateChannel; target?: string },
  ): Promise<UpdateProgress>;
  progress(): UpdateProgress;
}

export type NpmRunner = (
  args: string[],
  options: { cwd: string; timeoutMs: number; onOutput: (text: string) => void },
) => Promise<void>;
/** Restarts the app on the new code; called once, after a successful update. */
export type RestartFn = () => Promise<void> | void;

export interface SelfUpdateOptions {
  /** Install kind; detected from the process when absent. */
  kind?: InstallKind;
  /** Folder of the git checkout (default: the process cwd). */
  appRoot?: string;
  npm?: NpmRunner;
  restart?: RestartFn;
  /** AppImage mode: path of the AppImage, download policy and fetch (tests). */
  appImage?: AppImageOptions;
}

export class UpdateError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

const pkgName = (root: string) => {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    return undefined;
  }
};

/**
 * How this process was installed. AppImage: the desktop backend inside a release AppImage
 * ($APPIMAGE). Checkout: `npm start`/`npm run dev` at the top of an Adelic git work tree.
 * Anything else (desktop from a folder, a copied build) is "other": version and link only.
 */
export async function detectInstall(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; electron?: boolean } = {},
): Promise<{ kind: InstallKind; root?: string }> {
  const env = options.env ?? process.env;
  const electron = options.electron ?? Boolean(process.versions.electron);
  if (env.APPIMAGE) return electron ? { kind: 'appimage' } : { kind: 'other' };
  if (electron) return { kind: 'other' };
  let root: string;
  try {
    root = realpathSync(options.cwd ?? process.cwd());
  } catch {
    return { kind: 'other' };
  }
  if (pkgName(root) !== 'adelic') return { kind: 'other' };
  try {
    const top = lines(
      await git(root, ['rev-parse', '--show-toplevel'], { config: HARDENED_CONFIG, timeoutMs: 5000 }),
    )[0];
    if (top && realpathSync(top) === root) return { kind: 'checkout', root };
  } catch {
    /* Not a git work tree. */
  }
  return { kind: 'other' };
}

/** `npm` with the user's environment, except NODE_ENV (`npm start` sets production, which drops devDependencies). */
export const defaultNpm: NpmRunner = (args, { cwd, timeoutMs, onOutput }) =>
  new Promise((done, fail) => {
    // Under `npm start` the same npm is known; otherwise the one on PATH.
    const cli = process.env.npm_execpath?.endsWith('.js') ? process.env.npm_execpath : undefined;
    // npm's own variables from the parent `npm start` (and NODE_ENV=production, which would
    // skip devDependencies) must not leak into the build.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'NODE_ENV' && !key.toLowerCase().startsWith('npm_')),
    );
    const child = spawn(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) done();
      else
        fail(
          new Error(
            `npm ${args[0]} ${signal ? `interrompido (${signal}, limite ${timeoutMs / 60_000} min)` : `saiu com ${code}`}`,
          ),
        );
    });
  });

/**
 * Command that starts this process again. Under tsx (`npm start`, `npm run dev`) the server
 * is tsx's child, so the copy goes through the same `node_modules/.bin/tsx` wrapper (which
 * also keeps the command line that scripts look for); otherwise node with the same flags.
 */
export function respawnCommand(
  proc: Pick<NodeJS.Process, 'execPath' | 'execArgv' | 'argv'> = process,
  cwd = process.cwd(),
  has: (path: string) => boolean = existsSync,
) {
  const tsx = join(cwd, 'node_modules', '.bin', 'tsx');
  const underTsx = proc.execArgv.some((arg) => /[\\/]tsx[\\/]dist[\\/]/.test(arg));
  // `server/cli.ts` as typed by the npm scripts (tsx passes it on as an absolute path).
  const script = proc.argv[1] && proc.argv[1].startsWith(cwd + sep) ? relative(cwd, proc.argv[1]) : proc.argv[1];
  if (underTsx && has(tsx) && script) return { file: proc.execPath, args: [tsx, script, ...proc.argv.slice(2)] };
  return { file: proc.execPath, args: [...proc.execArgv, ...proc.argv.slice(1)] };
}

/**
 * Restart of `npm start`/`npm run dev`: a detached copy of this process (same command, env
 * and cwd) that waits for the ports and the data lock (ADELIC_RESTART_WAIT), then `close`
 * and exit. Output of the new process goes to `logFile`.
 */
export function respawnProcess(close: () => Promise<void>, logFile?: string): RestartFn {
  return async () => {
    const out = logFile ? openSync(logFile, 'a', 0o600) : 'ignore';
    const { file, args } = respawnCommand();
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: { ...process.env, ADELIC_RESTART_WAIT: '30000' },
      detached: true,
      stdio: ['ignore', out, out],
    });
    await new Promise<void>((done, fail) => {
      child.once('spawn', done);
      child.once('error', fail);
    });
    child.unref();
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
}

// ---------------------------------------------------------------------------------------
// Progress

const STEP_LABELS: Record<UpdateStepId, string> = {
  fetch: 'Buscar atualizações',
  switch: 'Trocar de branch',
  merge: 'Avançar o branch (fast-forward)',
  install: 'Instalar dependências (npm ci)',
  build: 'Compilar (npm run build)',
  download: 'Baixar o AppImage',
  verify: 'Conferir SHA-256 e formato',
  replace: 'Substituir o AppImage',
  restart: 'Reiniciar',
};

export class ProgressTracker {
  private value: UpdateProgress = { state: 'idle', steps: [], log: '' };
  get(): UpdateProgress {
    return { ...this.value, steps: this.value.steps.map((s) => ({ ...s })) };
  }
  get running() {
    return this.value.state === 'running' || this.value.state === 'restarting';
  }
  start(steps: UpdateStepId[], target?: string) {
    this.value = {
      state: 'running',
      steps: steps.map((id) => ({ id, label: STEP_LABELS[id], status: 'pending' })),
      log: '',
      target,
      startedAt: new Date().toISOString(),
    };
  }
  mark(id: UpdateStepId, status: UpdateStepStatus) {
    const step = this.value.steps.find((s) => s.id === id);
    if (step) step.status = status;
  }
  log(text: string) {
    const log = this.value.log + text;
    this.value.log = log.length > LOG_LIMIT ? log.slice(log.length - LOG_LIMIT) : log;
  }
  /** Runs one step, marking it running, then done or failed. */
  async step<T>(id: UpdateStepId, work: () => Promise<T>): Promise<T> {
    this.mark(id, 'running');
    try {
      const result = await work();
      this.mark(id, 'done');
      return result;
    } catch (error) {
      this.mark(id, 'failed');
      throw error;
    }
  }
  fail(message: string) {
    for (const step of this.value.steps) if (step.status === 'pending') step.status = 'skipped';
    this.value.state = 'failed';
    this.value.error = message;
    this.value.finishedAt = new Date().toISOString();
    this.log(`\nErro: ${message}\n`);
  }
  restarting() {
    this.value.state = 'restarting';
  }
  setTarget(target: string) {
    this.value.target = target;
  }
}

// ---------------------------------------------------------------------------------------
// Git checkout

/** No submodule recursion on checkout/merge, whatever the repository config says. */
const UPDATE_CONFIG = [...HARDENED_CONFIG, '-c', 'submodule.recurse=false'];
/**
 * Extra `-c` for fetch: no `ext::`/`git://` transports (git:// may run core.gitProxy), the
 * stock upload-pack, and no askpass or credential helpers from the repository config.
 */
const FETCH_CONFIG = [
  ...UPDATE_CONFIG,
  ...[
    'protocol.ext.allow=never',
    'protocol.git.allow=never',
    'remote.origin.uploadpack=git-upload-pack',
    'core.askPass=',
    'credential.helper=',
  ].flatMap((c) => ['-c', c]),
];
/** SSH remotes: never wait for a passphrase or host-key prompt. */
const FETCH_ENV = { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const run = (root: string, args: string[], timeoutMs = 30_000, config = UPDATE_CONFIG) =>
  git(root, args, { config, timeoutMs }).then((out) => out.toString('utf8').trim());
const ok = (root: string, args: string[]) =>
  git(root, args, { config: UPDATE_CONFIG, timeoutMs: 30_000 }).then(
    () => true,
    () => false,
  );

export interface CheckoutState {
  branch: string | null;
  head: string;
  clean: boolean;
  /** Ref the update fast-forwards from: HEAD, or the local channel branch when switching. */
  base?: string;
  remote?: string;
  behind: number;
  ahead: number;
  commits: { hash: string; subject: string }[];
  install: boolean;
  switchTo?: UpdateChannel;
  blocked?: string;
}

/**
 * Programs the repository's own config (with its includes) would run while git reads or
 * writes the working tree: clean/smudge filters. The user's global config is trusted.
 */
async function plantedPrograms(root: string) {
  try {
    const out = await run(root, [
      'config',
      '--local',
      '--includes',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process)$',
    ]);
    return out ? out.split('\n') : [];
  } catch {
    return []; // Exit 1: nothing matched.
  }
}

/** Local state of the checkout against origin/<channel>; never touches the network. */
export async function checkoutState(root: string, channel: UpdateChannel, fetched: boolean): Promise<CheckoutState> {
  const head = await run(root, ['rev-parse', 'HEAD']);
  const branch = await run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  // Checked before `status`, which may already run a clean filter.
  const planted = await plantedPrograms(root);
  if (planted.length)
    return {
      branch,
      head,
      clean: false,
      behind: 0,
      ahead: 0,
      commits: [],
      install: false,
      blocked: `A configuração deste repositório define filtros que executam programas (${planted.join(', ')}); atualize manualmente`,
    };
  // Tracked changes only; untracked files never block.
  const clean = !(await run(root, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none']));
  const remote = `refs/remotes/origin/${channel}`;
  const state: CheckoutState = { branch, head, clean, behind: 0, ahead: 0, commits: [], install: false };
  if (!fetched || !(await ok(root, ['rev-parse', '--verify', '--quiet', `${remote}^{commit}`]))) return state;
  state.remote = await run(root, ['rev-parse', remote]);
  let base = 'HEAD';
  if (branch !== channel) {
    const local = `refs/heads/${channel}`;
    const tracks =
      (await run(root, ['config', '--get', `branch.${channel}.remote`]).catch(() => '')) === 'origin' &&
      (await run(root, ['config', '--get', `branch.${channel}.merge`]).catch(() => '')) === local;
    const exists = await ok(root, ['rev-parse', '--verify', '--quiet', `${local}^{commit}`]);
    if (!exists || !tracks) {
      state.blocked = `O checkout está ${branch ? `no branch ${branch}` : 'sem branch (HEAD destacado)'}; não há um branch local ${channel} que acompanhe origin/${channel}`;
    } else if (!clean) {
      state.blocked = `O checkout está ${branch ? `no branch ${branch}` : 'sem branch'} e tem alterações; para trocar para ${channel}, salve ou descarte as alterações`;
    } else if (!(await ok(root, ['merge-base', '--is-ancestor', local, remote]))) {
      state.blocked = `O branch local ${channel} tem commits que não estão em origin/${channel}; atualize-o manualmente`;
    } else {
      state.switchTo = channel;
      base = local;
    }
  }
  const baseSha = await run(root, ['rev-parse', base]);
  state.base = baseSha;
  state.behind = Number(await run(root, ['rev-list', '--count', `${baseSha}..${state.remote}`]));
  state.ahead = Number(await run(root, ['rev-list', '--count', `${state.remote}..${baseSha}`]));
  const log = await run(root, ['log', '--no-color', '--format=%h%x00%s', '-n', '10', `${baseSha}..${state.remote}`]);
  state.commits = log
    ? log.split('\n').map((line) => {
        const [hash, subject = ''] = line.split('\0');
        return { hash, subject: subject.slice(0, 200) };
      })
    : [];
  state.install = Boolean(
    await run(root, ['diff', '--no-ext-diff', '--name-only', baseSha, state.remote, '--', 'package-lock.json']),
  );
  if (!state.blocked) {
    if (!clean)
      state.blocked =
        'Há alterações em arquivos rastreados; salve (commit) ou descarte antes de atualizar. Arquivos não rastreados não impedem.';
    else if (state.ahead > 0 && state.behind > 0)
      state.blocked = `O branch divergiu de origin/${channel} (${state.ahead} commit(s) locais); atualize manualmente`;
    else if (state.ahead > 0)
      state.blocked = `Há ${state.ahead} commit(s) locais que não estão em origin/${channel}; envie ou atualize manualmente`;
  }
  return state;
}

/** Same folder as `dist`, ignored by git (.adelic/). */
const tempDir = (root: string, kind: string) =>
  join(root, '.adelic', `update-${kind}-${randomBytes(6).toString('hex')}`);
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

// ---------------------------------------------------------------------------------------
// Service

export class SelfUpdateService implements SelfUpdater {
  private readonly tracker = new ProgressTracker();
  private detected?: Promise<{ kind: InstallKind; root?: string }>;
  private checked?: { at: number; channel: UpdateChannel; error?: string };
  private release?: AppImageRelease | { latest: string; url: string; available: boolean };
  private releaseError?: string;
  /** An apply is between its first check and the start of the job. */
  private starting = false;

  constructor(private readonly options: SelfUpdateOptions = {}) {}

  private install() {
    return (this.detected ??= this.options.kind
      ? Promise.resolve({
          kind: this.options.kind,
          root: this.options.kind === 'checkout' ? resolve(this.options.appRoot ?? process.cwd()) : undefined,
        })
      : detectInstall({ cwd: this.options.appRoot }));
  }

  progress() {
    return this.tracker.get();
  }

  private channelOf(settings: Settings, channel?: UpdateChannel): UpdateChannel {
    return channel ?? settings.updateChannel ?? 'master';
  }

  async status(settings: Settings, guard: UpdateGuard, channel?: UpdateChannel): Promise<SelfUpdateStatus> {
    const selected = this.channelOf(settings, channel);
    const stale =
      !this.checked || this.checked.channel !== selected || Date.now() - this.checked.at > AUTO_CHECK_TTL_MS;
    // Settings › "Verificar novas versões" allows the network check without a click.
    if (settings.updateCheck === true && stale && !this.tracker.running) return this.check(settings, guard, selected);
    return this.report(selected, guard);
  }

  async check(settings: Settings, guard: UpdateGuard, channel?: UpdateChannel): Promise<SelfUpdateStatus> {
    const selected = this.channelOf(settings, channel);
    const { kind, root } = await this.install();
    if (this.tracker.running) return this.report(selected, guard);
    let error: string | undefined;
    if (kind === 'checkout' && root) {
      try {
        await this.fetch(root, selected);
      } catch (e) {
        error = `Não foi possível buscar origin/${selected}: ${(e as Error).message}`;
      }
    } else if (kind === 'appimage') {
      try {
        this.release = await appImageCheck(this.options.appImage);
        this.releaseError = undefined;
      } catch (e) {
        this.releaseError = `Não foi possível verificar atualizações: ${(e as Error).message}`;
      }
    } else {
      const result = await checkForUpdate({ force: true, fetcher: this.options.appImage?.fetcher });
      this.releaseError = result.error;
      this.release = result.latest
        ? { latest: result.latest, url: result.url!, available: result.available }
        : undefined;
    }
    this.checked = { at: Date.now(), channel: selected, error };
    return this.report(selected, guard);
  }

  private fetch(root: string, channel: UpdateChannel, log?: (text: string) => void) {
    return git(
      root,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `+refs/heads/${channel}:refs/remotes/origin/${channel}`,
      ],
      { config: FETCH_CONFIG, env: FETCH_ENV, timeoutMs: FETCH_TIMEOUT_MS },
    ).then((out) => log?.(out.toString('utf8')));
  }

  private async report(channel: UpdateChannel, guard: UpdateGuard): Promise<SelfUpdateStatus> {
    const { kind, root } = await this.install();
    const busy = this.tracker.running;
    const base = {
      kind,
      version: pkg.version,
      bootId: BOOT_ID,
      channel,
      releaseUrl: RELEASES_PAGE,
      busy,
      ...(this.checked ? { checkedAt: new Date(this.checked.at).toISOString() } : {}),
    };
    const blockedBy = (own?: string) => own ?? (busy ? 'Uma atualização já está em andamento' : guard.block());
    if (kind === 'checkout' && root) {
      const fetched = this.checked?.channel === channel && !this.checked.error;
      let state: CheckoutState;
      try {
        state = await checkoutState(root, channel, fetched);
      } catch (e) {
        return {
          ...base,
          available: false,
          canApply: false,
          error: `Não foi possível ler o git: ${(e as Error).message}`,
        };
      }
      const available = Boolean(state.remote) && (state.behind > 0 || Boolean(state.switchTo)) && state.ahead === 0;
      const blocked = available || state.blocked ? blockedBy(state.blocked) : undefined;
      return {
        ...base,
        commit: state.head.slice(0, 12),
        available,
        canApply: available && !blocked,
        ...(blocked ? { blocked } : {}),
        ...(this.checked?.channel === channel && this.checked.error ? { error: this.checked.error } : {}),
        ...(state.remote ? { target: state.remote } : {}),
        checkout: {
          branch: state.branch,
          head: state.head.slice(0, 12),
          behind: state.behind,
          ahead: state.ahead,
          clean: state.clean,
          commits: state.commits,
          install: state.install,
          ...(state.switchTo ? { switchTo: state.switchTo } : {}),
        },
      };
    }
    const release = this.release;
    if (kind === 'appimage' && release && 'asset' in release) {
      const blocked = release.available
        ? blockedBy(
            release.writable
              ? undefined
              : `Sem permissão para substituir ${release.path}; baixe a nova versão pela página da release`,
          )
        : undefined;
      return {
        ...base,
        available: release.available,
        canApply: release.available && !blocked,
        ...(blocked ? { blocked } : {}),
        ...(this.releaseError ? { error: this.releaseError } : {}),
        target: release.latest,
        release: { latest: release.latest, url: release.url, writable: release.writable, size: release.asset.size },
      };
    }
    return {
      ...base,
      available: Boolean(release?.available),
      canApply: false,
      ...(release?.available
        ? { blocked: 'Esta instalação não se atualiza sozinha; baixe a nova versão pela página da release' }
        : {}),
      ...(this.releaseError ? { error: this.releaseError } : {}),
      ...(release ? { release: { latest: release.latest, url: release.url, writable: false } } : {}),
    };
  }

  async apply(
    settings: Settings,
    guard: UpdateGuard,
    options: { channel?: UpdateChannel; target?: string } = {},
  ): Promise<UpdateProgress> {
    if (this.tracker.running || this.starting) throw new UpdateError('Uma atualização já está em andamento');
    this.starting = true;
    try {
      return await this.startApply(settings, guard, options);
    } finally {
      this.starting = false;
    }
  }

  private async startApply(
    settings: Settings,
    guard: UpdateGuard,
    options: { channel?: UpdateChannel; target?: string },
  ): Promise<UpdateProgress> {
    const channel = this.channelOf(settings, options.channel);
    const { kind, root } = await this.install();
    if (kind === 'checkout' && root) {
      // Refusals known without the network (changed files, another branch, local commits)
      // answer 409 right away; the job fetches and checks again before touching anything.
      const known = await checkoutState(root, channel, true);
      if (known.blocked) throw new UpdateError(known.blocked);
      const release = guard.begin();
      this.tracker.start(['fetch', 'switch', 'merge', 'install', 'build', 'restart'], options.target?.slice(0, 12));
      void this.applyCheckout(root, channel, options.target, release);
    } else if (kind === 'appimage') {
      const current = this.release;
      if (!current || !('asset' in current) || !current.available)
        throw new UpdateError('Verifique as atualizações antes de atualizar');
      if (options.target && options.target !== current.latest)
        throw new UpdateError('A versão disponível mudou; verifique de novo');
      if (!current.writable) throw new UpdateError(`Sem permissão para substituir ${current.path}`);
      const release = guard.begin();
      this.tracker.start(['download', 'verify', 'replace', 'restart'], current.latest);
      void this.applyAppImage(current, release);
    } else {
      throw new UpdateError('Esta instalação não se atualiza pelo Adelic; use a página da release', 400);
    }
    return this.tracker.get();
  }

  /**
   * The new code is in place: restart. A failure here leaves the update applied (no rollback,
   * the build already succeeded); the user restarts by hand. Runs stay held off either way.
   */
  private async restart() {
    const t = this.tracker;
    try {
      await t.step('restart', async () => {
        if (!this.options.restart) throw new Error('reinício automático indisponível');
        t.restarting();
        t.log('Reiniciando o Adelic…\n');
        await this.options.restart();
      });
    } catch (error) {
      t.fail(
        `A atualização foi aplicada, mas o reinício falhou (${(error as Error).message}); reinicie o Adelic manualmente`,
      );
    }
  }

  private async applyCheckout(root: string, channel: UpdateChannel, target: string | undefined, release: () => void) {
    const t = this.tracker;
    const log = (text: string) => text && t.log(text.endsWith('\n') ? text : `${text}\n`);
    const npm = this.options.npm ?? defaultNpm;
    // What to put back on failure: the branch that moves and where it was, and where HEAD was.
    let undo: { moved: string; startBranch: string | null; startHead: string; switched: boolean } | undefined;
    let installed = false;
    let buildDir: string | undefined;
    try {
      const state = await t.step('fetch', async () => {
        await this.fetch(root, channel, log);
        this.checked = { at: Date.now(), channel };
        const now = await checkoutState(root, channel, true);
        if (now.blocked) throw new UpdateError(now.blocked);
        if (!now.remote || (now.behind === 0 && !now.switchTo)) throw new UpdateError('O Adelic já está atualizado');
        if (target && !now.remote.startsWith(target))
          throw new UpdateError(`origin/${channel} mudou desde a verificação; verifique de novo`);
        log(`origin/${channel} em ${now.remote.slice(0, 12)}: ${now.behind} commit(s) novos`);
        return now;
      });
      t.setTarget(state.remote!.slice(0, 12));
      undo = { moved: state.base!, startBranch: state.branch, startHead: state.head, switched: false };
      if (state.switchTo) {
        await t.step('switch', async () => {
          undo!.switched = true;
          log(await run(root, ['checkout', '--quiet', '--no-recurse-submodules', channel]));
          log(`Agora no branch ${channel}`);
        });
      } else t.mark('switch', 'skipped');
      await t.step('merge', async () => {
        log(
          await run(root, ['merge', '--ff-only', '--no-stat', '--no-edit', `refs/remotes/origin/${channel}`], 60_000),
        );
        if ((await run(root, ['rev-parse', 'HEAD'])) !== state.remote)
          throw new Error('HEAD não chegou ao commit esperado');
        log(`HEAD em ${state.remote!.slice(0, 12)}`);
      });
      if (state.install) {
        await t.step('install', async () => {
          installed = true;
          await npm(['ci', '--no-audit', '--no-fund'], { cwd: root, timeoutMs: NPM_TIMEOUT_MS, onOutput: log });
        });
      } else t.mark('install', 'skipped');
      await t.step('build', async () => {
        // Built aside: dist (served now) is swapped only after a successful build.
        await mkdir(join(root, '.adelic'), { recursive: true });
        buildDir = tempDir(root, 'build');
        await npm(['run', 'build', '--', '--outDir', buildDir], {
          cwd: root,
          timeoutMs: NPM_TIMEOUT_MS,
          onOutput: log,
        });
        if (!(await exists(join(buildDir, 'index.html')))) throw new Error('o build não gerou index.html');
        const dist = join(root, 'dist');
        const old = (await exists(dist)) ? tempDir(root, 'previous-dist') : undefined;
        if (old) await rename(dist, old);
        try {
          await rename(buildDir, dist);
        } catch (error) {
          if (old) await rename(old, dist);
          throw error;
        }
        buildDir = undefined;
        if (old) await rm(old, { recursive: true, force: true }).catch(() => undefined);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (buildDir) await rm(buildDir, { recursive: true, force: true });
        if (undo) await this.rollback(root, undo, installed, log);
      } catch (rollback) {
        log(`Falha ao desfazer: ${(rollback as Error).message}`);
      }
      t.fail(message);
      release();
      return;
    }
    await this.restart();
  }

  /** Puts HEAD (and the branch the update moved) back; the tree was clean at the start. */
  private async rollback(
    root: string,
    undo: { moved: string; startBranch: string | null; startHead: string; switched: boolean },
    installed: boolean,
    log: (text: string) => void,
  ) {
    const head = await run(root, ['rev-parse', 'HEAD']);
    if (head !== undo.moved) {
      await run(root, ['reset', '--quiet', '--hard', undo.moved]);
      log(`HEAD voltou para ${undo.moved.slice(0, 12)}`);
    }
    if (undo.switched) {
      await run(root, [
        'checkout',
        '--quiet',
        '--no-recurse-submodules',
        ...(undo.startBranch ? [undo.startBranch] : ['--detach', undo.startHead]),
      ]);
      log(`De volta a ${undo.startBranch ?? undo.startHead.slice(0, 12)}`);
    }
    if (installed) {
      log('Reinstalando as dependências da versão anterior (npm ci)…');
      await (this.options.npm ?? defaultNpm)(['ci', '--no-audit', '--no-fund'], {
        cwd: root,
        timeoutMs: NPM_TIMEOUT_MS,
        onOutput: log,
      }).catch((e: Error) => log(`npm ci da versão anterior falhou: ${e.message}; rode npm ci manualmente`));
    }
  }

  private async applyAppImage(current: AppImageRelease, release: () => void) {
    const t = this.tracker;
    try {
      await applyAppImage(current, this.options.appImage, {
        step: (id, work) => t.step(id, work),
        log: (text) => t.log(text),
      });
    } catch (error) {
      t.fail(error instanceof Error ? error.message : String(error));
      release();
      return;
    }
    await this.restart();
  }
}
