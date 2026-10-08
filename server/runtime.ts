import type { ObservationInput } from '../shared/observability.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ViteDevServer } from 'vite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { Project, ProviderRegistry } from '../shared/contracts.js';
import { GraphifyService } from './graphify.js';
import { createBackend } from './index.js';
import { Store } from './store.js';
import { funnelPortFromEnv, remoteAccessFromEnv, tagListener, type RemoteAccess } from './http/auth.js';
import type { FunnelListener } from './http/remote-access.js';
import type { FunnelService } from './funnel.js';
import { webAssets } from './http/web.js';
import { SelfUpdateService, type RestartFn, type SelfUpdater } from './self-update.js';

export interface StartServerOptions {
  port?: number;
  /** Remote access (token-protected). Defaults to ADELIC_REMOTE_BIND/TOKEN/PORT; off when unset. */
  remote?: RemoteAccess | null;
  /**
   * Loopback port that receives Tailscale Funnel traffic (always treated as internet).
   * Defaults to ADELIC_FUNNEL_PORT or 4319; null disables the option. It only listens once
   * Funnel is requested from this computer (or was, and an account exists).
   */
  funnelPort?: number | null;
  /** Test hook: the Tailscale CLI wrapper (tests never call the real `tailscale`). */
  funnelService?: FunnelService;
  webDir?: string;
  dataDir?: string;
  development?: boolean;
  seedProject?: Project;
  /**
   * Restarts the app after "Atualizar Adelic" (docs/specs/self-update.md); receives this
   * server's close(). The CLI respawns the process, the desktop relaunches Electron.
   * Without it the update still applies and asks for a manual restart.
   */
  restart?: (close: () => Promise<void>, context: { dataDir: string }) => Promise<void> | void;
  /** Replaces the updater (tests): an instance, or a factory given the wired restart. */
  selfUpdater?: SelfUpdater | ((restart: RestartFn | undefined) => SelfUpdater);
  /**
   * Keep retrying for this long while the ports or the data folder are still held (a restart
   * waits for the previous process). Default: ADELIC_RESTART_WAIT (ms), else no retry.
   */
  restartWaitMs?: number;
}

export interface RunningServer {
  recordObservation?(input: ObservationInput): void;
  url: string;
  port: number;
  /** Set only when remote access is enabled. */
  remoteUrl?: string;
  /** Funnel listener, once it listens. */
  funnelUrl?(): string | undefined;
  close(): Promise<void>;
}

type Cleanup = () => Promise<void>;

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function listen(server: HttpServer | NetServer, ...args: Parameters<HttpServer['listen']>): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const failed = (error: Error) => {
      server.removeListener('listening', ready);
      rejectListen(error);
    };
    const ready = () => {
      server.removeListener('error', failed);
      resolveListen();
    };
    server.once('error', failed);
    server.once('listening', ready);
    // The common overload used here is also accepted by net.Server at runtime.
    (server.listen as (...params: unknown[]) => HttpServer | NetServer)(...args);
  });
}

const addressInUse = (error: unknown) =>
  errorCode(error) === 'EADDRINUSE' ||
  (error instanceof Error && error.cause !== undefined && errorCode(error.cause) === 'EADDRINUSE');

/** Repeats `work` while it fails with EADDRINUSE, with growing pauses, for up to `waitMs`. */
export async function retryInUse<T>(work: () => Promise<T>, waitMs: number): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
    try {
      return await work();
    } catch (error) {
      if (!addressInUse(error) || Date.now() + pause > deadline) throw error;
      await new Promise((done) => setTimeout(done, pause));
    }
  }
}

async function closeServer(server: HttpServer) {
  if (!server.listening) return;
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) =>
      error && errorCode(error) !== 'ERR_SERVER_NOT_RUNNING' ? rejectClose(error) : resolveClose(),
    );
  });
  server.closeAllConnections();
  await closed;
}

async function acquireDataLock(realDataDir: string): Promise<Cleanup> {
  if (process.platform !== 'linux') throw new Error('O runtime desktop exige Linux para proteger a pasta de dados.');
  const digest = createHash('sha256').update(realDataDir).digest('hex');
  const address = `\0adelic-${digest}`;
  const lock = createNetServer((socket) => socket.destroy());
  try {
    await listen(lock, address);
  } catch (error) {
    if (errorCode(error) === 'EADDRINUSE') {
      throw new Error(
        'Esta pasta de dados já está sendo usada por outra instância do Adelic (modo web ou desktop). Feche a outra instância antes de continuar.',
        { cause: error },
      );
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= new Promise<void>((resolveClose, rejectClose) => {
      if (!lock.listening) {
        resolveClose();
        return;
      }
      lock.close((error) => (error ? rejectClose(error) : resolveClose()));
    }));
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const requestedDataDir = options.dataDir ?? process.env.ADELIC_DATA_DIR ?? join(homedir(), '.local/share/adelic');
  mkdirSync(resolve(requestedDataDir), { recursive: true });
  const realDataDir = realpathSync(requestedDataDir);

  const envWait = Number(process.env.ADELIC_RESTART_WAIT);
  const waitMs = options.restartWaitMs ?? (Number.isFinite(envWait) && envWait > 0 ? Math.min(envWait, 60_000) : 0);
  // Read once: agents and terminals started by this process must not inherit it.
  delete process.env.ADELIC_RESTART_WAIT;

  // Own the real database path before Store runs its startup repair statements.
  const releaseLock = await retryInUse(() => acquireDataLock(realDataDir), waitMs);
  let store: Store | undefined;
  let providers: ProviderRegistry | undefined;
  let orchestrator: ReturnType<typeof createBackend>['orchestrator'] | undefined;
  let terminal: ReturnType<typeof createBackend>['terminal'] | undefined;
  let automations: ReturnType<typeof createBackend>['automations'] | undefined;
  let graphifyService: GraphifyService | undefined;
  let http: HttpServer | undefined;
  let remoteHttp: HttpServer | undefined;
  let funnelHttp: HttpServer | undefined;
  let vite: ViteDevServer | undefined;
  let closePromise: Promise<void> | undefined;
  let stopHealth: (() => void) | undefined;
  try {
    store = new Store(realDataDir);
    if (options.seedProject && !store.listProjects().length) store.putProject(options.seedProject);
    const { createProviderRegistry } = await import('./providers/index.js');
    providers = createProviderRegistry(realDataDir);
    graphifyService = new GraphifyService(undefined, realDataDir);
    const remote = options.remote === null ? undefined : (options.remote ?? remoteAccessFromEnv());
    const configuredFunnelPort = options.funnelPort === null ? undefined : (options.funnelPort ?? funnelPortFromEnv());
    if (configuredFunnelPort && [options.port ?? 4317, remote?.port].includes(configuredFunnelPort))
      throw new Error('ADELIC_FUNNEL_PORT precisa ser diferente das outras portas do Adelic.');
    let funnelPort = configuredFunnelPort;
    let funnelStarting: Promise<number> | undefined;
    // Filled right below; the listener starts only after createBackend returned.
    const holder: { app?: ReturnType<typeof createBackend>['app'] } = {};
    // 127.0.0.1 only; tailscaled connects here. Started lazily so an unused option binds nothing.
    const funnelListener: FunnelListener | undefined =
      configuredFunnelPort === undefined
        ? undefined
        : {
            port: () => funnelPort!,
            listening: () => Boolean(funnelHttp?.listening),
            ensure: () =>
              (funnelStarting ??= (async () => {
                const server = createHttpServer(holder.app!);
                tagListener(server, 'funnel');
                try {
                  await listen(server, { host: '127.0.0.1', port: configuredFunnelPort });
                } catch (error) {
                  funnelStarting = undefined;
                  throw Object.assign(
                    new Error(
                      `Não foi possível escutar em 127.0.0.1:${configuredFunnelPort} para o Funnel (${errorCode(error) ?? String(error)}). Defina outra porta em ADELIC_FUNNEL_PORT.`,
                    ),
                    { status: 409 },
                  );
                }
                funnelHttp = server;
                const bound = server.address();
                if (bound && typeof bound !== 'string') funnelPort = bound.port;
                return funnelPort!;
              })()),
          };
    // close() is defined below; the updater calls it only after the server is up.
    const closeRef: { current?: () => Promise<void> } = {};
    const restartOption = options.restart;
    const restart: RestartFn | undefined = restartOption
      ? () => restartOption(() => closeRef.current!(), { dataDir: realDataDir })
      : undefined;
    const selfUpdater =
      typeof options.selfUpdater === 'function'
        ? options.selfUpdater(restart)
        : (options.selfUpdater ?? new SelfUpdateService(restart ? { restart } : {}));
    const backend = createBackend(
      store,
      providers,
      graphifyService,
      remote,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { funnelListener, funnelService: options.funnelService },
      selfUpdater,
    );
    holder.app = backend.app;
    orchestrator = backend.orchestrator;
    terminal = backend.terminal;
    automations = backend.automations;
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    eventLoop.enable();
    const healthTimer = setInterval(() => {
      const delayMs = eventLoop.max / 1e6;
      backend.observations.recordObservation({
        name: 'runtime.event-loop',
        component: 'process',
        status: delayMs > 2000 ? 'error' : 'success',
        durationMs: delayMs,
      });
      eventLoop.reset();
    }, 30000);
    healthTimer.unref();
    stopHealth = () => {
      clearInterval(healthTimer);
      eventLoop.disable();
    };

    if (options.development) {
      const { createServer: createViteServer } = await import('vite');
      vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
      backend.app.use(vite.middlewares);
    } else if (options.webDir) {
      backend.app.use(webAssets(options.webDir));
    }

    http = createHttpServer(backend.app);
    tagListener(http, 'local');
    const server = http;
    await retryInUse(() => listen(server, { host: '127.0.0.1', port: options.port ?? 4317 }), waitMs);
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('O servidor iniciou sem uma porta TCP válida.');
    // Same app on a second, explicitly configured address; every request there needs the token.
    let remotePort: number | undefined;
    if (remote) {
      const remoteServer = (remoteHttp = createHttpServer(backend.app));
      tagListener(remoteServer, 'tailnet');
      await retryInUse(() => listen(remoteServer, { host: remote.bind, port: remote.port }), waitMs);
      const remoteAddress = remoteHttp.address();
      remotePort = remoteAddress && typeof remoteAddress !== 'string' ? remoteAddress.port : remote.port;
    }

    // Re-applies Funnel only when it was requested before and an account still exists.
    void backend.funnel.restore();

    const close = () =>
      (closePromise ??= (async () => {
        let firstError: unknown;
        const attempt = async (work: () => Promise<void>) => {
          try {
            await work();
          } catch (error) {
            firstError ??= error;
          }
        };
        // No automation may start while the server shuts down.
        stopHealth?.();
        automations?.stop();
        backend.access.stop();
        await attempt(async () => {
          await closeServer(http!);
        });
        await attempt(async () => {
          if (remoteHttp) await closeServer(remoteHttp);
        });
        await attempt(async () => {
          await funnelStarting?.catch(() => undefined);
          if (funnelHttp) await closeServer(funnelHttp);
        });
        await attempt(async () => {
          const results = await Promise.allSettled(
            [orchestrator?.shutdown(), graphifyService?.shutdown(), terminal?.shutdown()].filter(
              (pending): pending is Promise<void> => Boolean(pending),
            ),
          );
          const failed = results.find((result) => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        });
        await attempt(async () => {
          await providers?.shutdown();
        });
        await attempt(async () => {
          await vite?.close();
        });
        await attempt(async () => {
          store?.close();
        });
        await attempt(releaseLock);
        if (firstError) throw firstError;
      })());

    closeRef.current = close;
    return {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      ...(remote
        ? { remoteUrl: `http://${remote.bind.includes(':') ? `[${remote.bind}]` : remote.bind}:${remotePort}` }
        : {}),
      funnelUrl: () => (funnelHttp?.listening ? `http://127.0.0.1:${funnelPort}` : undefined),
      close,
      recordObservation: backend.observations.recordObservation,
    };
  } catch (error) {
    stopHealth?.();
    automations?.stop();
    await Promise.allSettled(
      [orchestrator?.shutdown(), graphifyService?.shutdown(), terminal?.shutdown()].filter(
        (pending): pending is Promise<void> => Boolean(pending),
      ),
    );
    try {
      await providers?.shutdown();
    } catch {}
    try {
      if (http) await closeServer(http);
    } catch {}
    try {
      if (remoteHttp) await closeServer(remoteHttp);
    } catch {}
    try {
      if (funnelHttp) await closeServer(funnelHttp);
    } catch {}
    try {
      await vite?.close();
    } catch {}
    try {
      store?.close();
    } catch {}
    try {
      await releaseLock();
    } catch {}
    throw error;
  }
}

export async function seedAdelicProject(cwd = process.cwd()): Promise<Project | undefined> {
  if (resolve(cwd).split('/').at(-1)?.toLowerCase() !== 'adelic') return undefined;
  try {
    const { readFile } = await import('node:fs/promises');
    const config = await readFile(join(cwd, '.ai-memory.toml'), 'utf8');
    const workspace = config.match(/^workspace\s*=\s*"([^"]+)"/m)?.[1];
    const project = config.match(/^project\s*=\s*"([^"]+)"/m)?.[1];
    if (!workspace || !project) return undefined;
    return {
      id: randomUUID(),
      name: 'Adelic',
      path: realpathSync(cwd),
      createdAt: new Date().toISOString(),
      memoryWorkspace: workspace,
      memoryProject: project,
    };
  } catch {
    return undefined;
  }
}
