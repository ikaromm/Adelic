import express from 'express';
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

export interface StartServerOptions {
  port?: number;
  webDir?: string;
  dataDir?: string;
  development?: boolean;
  seedProject?: Project;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

type Cleanup = () => Promise<void>;

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function listen(server: HttpServer | NetServer, ...args: Parameters<HttpServer['listen']>): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const failed = (error: Error) => { server.removeListener('listening', ready); rejectListen(error); };
    const ready = () => { server.removeListener('error', failed); resolveListen(); };
    server.once('error', failed);
    server.once('listening', ready);
    // The common overload used here is also accepted by net.Server at runtime.
    (server.listen as (...params: unknown[]) => HttpServer | NetServer)(...args);
  });
}

async function closeServer(server: HttpServer) {
  if (!server.listening) return;
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error && errorCode(error) !== 'ERR_SERVER_NOT_RUNNING' ? rejectClose(error) : resolveClose());
  });
  server.closeAllConnections();
  await closed;
}

async function acquireDataLock(realDataDir: string): Promise<Cleanup> {
  if (process.platform !== 'linux') throw new Error('O runtime desktop exige Linux para proteger a pasta de dados.');
  const digest = createHash('sha256').update(realDataDir).digest('hex');
  const address = `\0adelic-${digest}`;
  const lock = createNetServer(socket => socket.destroy());
  try {
    await listen(lock, address);
  } catch (error) {
    if (errorCode(error) === 'EADDRINUSE') {
      throw new Error('Esta pasta de dados já está sendo usada por outra instância do Adelic (modo web ou desktop). Feche a outra instância antes de continuar.');
    }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return () => closing ??= new Promise<void>((resolveClose, rejectClose) => {
    if (!lock.listening) { resolveClose(); return; }
    lock.close(error => error ? rejectClose(error) : resolveClose());
  });
}

function mountWebAssets(app: ReturnType<typeof createBackend>['app'], webDir: string) {
  const absoluteWebDir = resolve(webDir);
  app.use(express.static(absoluteWebDir, { fallthrough: true }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) { next(); return; }
    res.sendFile(join(absoluteWebDir, 'index.html'), error => { if (error) next(error); });
  });
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const requestedDataDir = options.dataDir ?? process.env.ADELIC_DATA_DIR ?? join(homedir(), '.local/share/adelic');
  mkdirSync(resolve(requestedDataDir), { recursive: true });
  const realDataDir = realpathSync(requestedDataDir);

  // Own the real database path before Store runs its startup repair statements.
  const releaseLock = await acquireDataLock(realDataDir);
  let store: Store | undefined;
  let providers: ProviderRegistry | undefined;
  let orchestrator: ReturnType<typeof createBackend>['orchestrator'] | undefined;
  let graphifyService: GraphifyService | undefined;
  let http: HttpServer | undefined;
  let vite: ViteDevServer | undefined;
  let closePromise: Promise<void> | undefined;
  try {
    store = new Store(realDataDir);
    if (options.seedProject && !store.listProjects().length) store.putProject(options.seedProject);
    const { createProviderRegistry } = await import('./providers/index.js');
    providers = createProviderRegistry(realDataDir);
    graphifyService = new GraphifyService(undefined, realDataDir);
    const backend = createBackend(store, providers, graphifyService);
    orchestrator = backend.orchestrator;

    if (options.development) {
      const { createServer: createViteServer } = await import('vite');
      vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
      backend.app.use(vite.middlewares);
    } else if (options.webDir) {
      mountWebAssets(backend.app, options.webDir);
    }

    http = createHttpServer(backend.app);
    await listen(http, { host: '127.0.0.1', port: options.port ?? 4317 });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('O servidor iniciou sem uma porta TCP válida.');

    const close = () => closePromise ??= (async () => {
      let firstError: unknown;
      const attempt = async (work: () => Promise<void>) => { try { await work(); } catch (error) { firstError ??= error; } };
      await attempt(async () => { await closeServer(http!); });
      await attempt(async () => {
        const results = await Promise.allSettled([orchestrator?.shutdown(), graphifyService?.shutdown()].filter((pending): pending is Promise<void> => Boolean(pending)));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      });
      await attempt(async () => { await providers?.shutdown(); });
      await attempt(async () => { await vite?.close(); });
      await attempt(async () => { store?.close(); });
      await attempt(releaseLock);
      if (firstError) throw firstError;
    })();

    return { url: `http://127.0.0.1:${address.port}`, port: address.port, close };
  } catch (error) {
    await Promise.allSettled([orchestrator?.shutdown(), graphifyService?.shutdown()].filter((pending): pending is Promise<void> => Boolean(pending)));
    try { await providers?.shutdown(); } catch {}
    try { if (http) await closeServer(http); } catch {}
    try { await vite?.close(); } catch {}
    try { store?.close(); } catch {}
    try { await releaseLock(); } catch {}
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
    return { id: randomUUID(), name: 'Adelic', path: realpathSync(cwd), createdAt: new Date().toISOString(), memoryWorkspace: workspace, memoryProject: project };
  } catch { return undefined; }
}
