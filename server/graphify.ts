import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Express } from 'express';
import type { GraphifyQueryResult, GraphifyStatus, Project } from '../shared/contracts.js';
import type { Store } from './store.js';
import { error } from './http/common.js';

const excluded = new Set([
  '.git',
  '.adelic',
  'graphify-out',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  'out',
  '.cache',
]);
type IndexState = { fingerprint: string; updatedAt: string };
type Runtime = { pending?: Promise<GraphifyStatus>; error?: string; cancelled?: boolean };

/** Only metadata is read here. Source contents belong to Graphify's local AST pass. */
async function fingerprint(root: string) {
  const hash = createHash('sha256');
  async function visit(directory: string) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        excluded.has(entry.name) ||
        /\.(?:log|pyc|tmp|swp|sqlite(?:-wal|-shm)?)$/i.test(entry.name)
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        // Track all source extensions and ignore-rule files rather than keeping
        // a language allowlist that can drift from the installed Graphify CLI.
        const info = await stat(path);
        hash.update(`${path.slice(root.length)}\0${info.size}\0${info.mtimeMs}\n`);
      }
    }
  }
  await visit(root);
  return hash.digest('hex');
}

/** The Graphify CLI Adelic runs and suggests to agents; undefined when none is installed. */
export async function findGraphify() {
  const candidates = [
    join(homedir(), '.local/bin/graphify'),
    ...String(process.env.PATH || '')
      .split(':')
      .map((directory) => join(directory, 'graphify')),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

function runCli(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  environment: Record<string, string> = {},
) {
  return new Promise<string>((resolveResult, reject) => {
    if (signal?.aborted) {
      reject(new Error('Consulta Graphify cancelada'));
      return;
    }
    const child = spawn(binary, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
    });
    let stdout = '',
      stderr = '',
      done = false,
      interrupted: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    function stop() {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {}
      force = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {}
        finish(new Error('Graphify não encerrou após interrupção'));
      }, 750);
      force.unref();
    }
    function finish(error?: Error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (force) clearTimeout(force);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolveResult(stdout);
    }
    const onAbort = () => {
      interrupted = new Error('Consulta Graphify cancelada');
      stop();
    };
    const timer = setTimeout(() => {
      interrupted = new Error('Graphify excedeu o tempo limite');
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-60_000);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) =>
      finish(
        interrupted ||
          (signal?.aborted
            ? new Error('Consulta Graphify cancelada')
            : code === 0
              ? undefined
              : new Error(stderr.trim() || `Graphify encerrou com código ${code}`)),
      ),
    );
  });
}

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Consulta Graphify cancelada'));
  return new Promise<T>((resolveOperation, rejectOperation) => {
    const onAbort = () => {
      cleanup();
      rejectOperation(new Error('Consulta Graphify cancelada'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolveOperation(value);
      },
      (error) => {
        cleanup();
        rejectOperation(error);
      },
    );
  });
}

export class GraphifyService {
  private states = new Map<string, Runtime>();
  private activeControllers = new Set<AbortController>();
  private activeOperations = new Set<Promise<unknown>>();
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  constructor(
    private binaryResolver: () => Promise<string | undefined> = findGraphify,
    private dataDir = process.env.ADELIC_DATA_DIR || join(homedir(), '.local/share/adelic'),
  ) {}
  private outputRoot(project: Project) {
    return join(
      resolve(this.dataDir),
      'graphs',
      createHash('sha256').update(resolve(project.path)).digest('hex').slice(0, 32),
    );
  }
  /**
   * Trusted paths for the safe-command classifier (docs/specs/safe-command-approvals.md): the
   * binary Adelic suggests and this project's own graph directory. Undefined without Graphify.
   */
  async approvalPaths(project: Project): Promise<{ binary: string; graphsRoot: string } | undefined> {
    const binary = await this.binaryResolver();
    return binary ? { binary, graphsRoot: this.outputRoot(project) } : undefined;
  }
  graphPath(project: Project) {
    return join(this.outputRoot(project), 'graphify-out/graph.json');
  }
  private metadataPath(project: Project) {
    return join(this.outputRoot(project), 'adelic-index.json');
  }
  private runtime(project: Project) {
    const key = resolve(project.path);
    let current = this.states.get(key);
    if (!current) {
      current = {};
      this.states.set(key, current);
    }
    return current;
  }
  private operation<T>(externalSignal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Serviço Graphify está encerrando'));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', onAbort, { once: true });
    this.activeControllers.add(controller);
    const pending = Promise.resolve().then(() => run(controller.signal));
    this.activeOperations.add(pending);
    return pending.finally(() => {
      externalSignal?.removeEventListener('abort', onAbort);
      this.activeControllers.delete(controller);
      this.activeOperations.delete(pending);
    });
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    for (const controller of this.activeControllers) controller.abort();
    this.shutdownPromise = Promise.allSettled([...this.activeOperations]).then(() => undefined);
    return this.shutdownPromise;
  }
  status(project: Project): Promise<GraphifyStatus> {
    return this.operation(undefined, () => this.statusInternal(project));
  }
  private async statusInternal(project: Project): Promise<GraphifyStatus> {
    const graphPath = this.graphPath(project),
      installed = Boolean(await this.binaryResolver()),
      enabled = project.graphify?.enabled !== false;
    const base = { graphPath, installed, enabled };
    if (!enabled) return { ...base, status: 'disabled', detail: 'Índice desativado neste projeto' };
    if (!installed)
      return {
        ...base,
        status: 'missing',
        detail: 'Graphify não está instalado; nenhuma busca no grafo foi executada',
      };
    const state = this.runtime(project);
    if (state.pending)
      return { ...base, status: 'indexing', detail: 'Construindo o índice de código local, sem chamada de modelo' };
    if (state.error) return { ...base, status: 'error', detail: state.error };
    try {
      const graph = JSON.parse(await readFile(graphPath, 'utf8')) as {
        nodes?: unknown[];
        edges?: unknown[];
        links?: unknown[];
      };
      if (!Array.isArray(graph.nodes)) throw new Error('O arquivo Graphify não contém um grafo válido');
      let stamp: IndexState | undefined;
      try {
        stamp = JSON.parse(await readFile(this.metadataPath(project), 'utf8')) as IndexState;
      } catch {}
      const info = await stat(graphPath),
        updatedAt = stamp?.updatedAt || info.mtime.toISOString();
      const fresh = stamp?.fingerprint === (await fingerprint(resolve(project.path)));
      return {
        ...base,
        status: fresh ? 'ready' : 'stale',
        updatedAt,
        nodes: graph.nodes.length,
        edges: (graph.edges || graph.links || []).length,
        detail: fresh
          ? 'Grafo AST de código disponível; consultas recebem somente um recorte'
          : 'O código mudou ou o índice não foi conferido; será atualizado na próxima consulta',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          ...base,
          status: 'unindexed',
          detail: 'Índice ativado; será construído na primeira tarefa com código ou pelo botão abaixo',
        };
      return { ...base, status: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
  }
  index(project: Project, signal?: AbortSignal): Promise<GraphifyStatus> {
    return this.operation(signal, (operationSignal) => this.indexInternal(project, operationSignal));
  }
  private async indexInternal(project: Project, signal: AbortSignal): Promise<GraphifyStatus> {
    if (signal.aborted) throw new Error('Consulta Graphify cancelada');
    if (project.graphify?.enabled === false) return this.statusInternal(project);
    const current = this.runtime(project);
    if (current.pending) return waitForAbort(current.pending, signal);
    current.error = undefined;
    current.cancelled = false;
    const pending = (async () => {
      const binary = await this.binaryResolver();
      if (signal.aborted) throw new Error('Consulta Graphify cancelada');
      if (!binary) throw new Error('Graphify não está instalado');
      const root = resolve(project.path),
        output = this.outputRoot(project);
      await mkdir(output, { recursive: true });
      if (signal.aborted) throw new Error('Consulta Graphify cancelada');
      const resolvedOutput = await realpath(output),
        resolvedData = await realpath(resolve(this.dataDir));
      if (!resolvedOutput.startsWith(`${resolvedData}/`))
        throw new Error('A pasta do índice deve permanecer no armazenamento local do aplicativo');
      // No semantic/backend pass, global install, hooks, or model API keys.
      const before = await fingerprint(root);
      await runCli(
        binary,
        ['extract', root, '--code-only', '--no-cluster', '--max-workers', '2', '--out', output],
        root,
        90_000,
        signal,
        { GRAPHIFY_OUT: dirname(this.graphPath(project)) },
      );
      if (signal.aborted) throw new Error('Consulta Graphify cancelada');
      const graph = JSON.parse(await readFile(this.graphPath(project), 'utf8')) as { nodes?: unknown[] };
      if (!Array.isArray(graph.nodes)) throw new Error('Graphify não produziu um grafo válido');
      if (signal.aborted) throw new Error('Consulta Graphify cancelada');
      await writeFile(
        this.metadataPath(project),
        JSON.stringify({ fingerprint: before, updatedAt: new Date().toISOString() } satisfies IndexState),
      );
    })();
    current.pending = pending.then(
      async () => {
        current.pending = undefined;
        return this.statusInternal(project);
      },
      async (error) => {
        current.pending = undefined;
        current.error = error instanceof Error ? error.message : String(error);
        current.cancelled = signal.aborted;
        return this.statusInternal(project);
      },
    );
    return current.pending;
  }
  query(project: Project, query: string, signal?: AbortSignal): Promise<GraphifyQueryResult> {
    return this.operation(signal, (operationSignal) => this.queryInternal(project, query, operationSignal));
  }
  private async queryInternal(project: Project, query: string, signal: AbortSignal): Promise<GraphifyQueryResult> {
    if (!query.trim()) throw new Error('Consulta obrigatória');
    let status = await this.statusInternal(project);
    if (
      status.status === 'unindexed' ||
      status.status === 'stale' ||
      (status.status === 'error' && this.runtime(project).cancelled)
    )
      status = await this.indexInternal(project, signal);
    if (signal.aborted) throw new Error('Consulta Graphify cancelada');
    // A file may change while extraction is in progress. Do not inject that
    // snapshot as current code; a subsequent stable query can rebuild it.
    if (status.status !== 'ready') return { query, context: '', status };
    const binary = await this.binaryResolver();
    if (!binary) return { query, context: '', status };
    const context = (
      await runCli(
        binary,
        ['query', query.slice(0, 1000), '--graph', status.graphPath, '--budget', '800'],
        project.path,
        15_000,
        signal,
        { GRAPHIFY_OUT: dirname(this.graphPath(project)) },
      )
    ).slice(0, 5000);
    if (signal.aborted) throw new Error('Consulta Graphify cancelada');
    const after = await this.statusInternal(project);
    return { query, context: after.status === 'ready' ? context : '', status: after };
  }
}

export const graphify = new GraphifyService();

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function graphifyContext(
  project: Project,
  query: string,
  signal?: AbortSignal,
  service: GraphifyService = graphify,
): Promise<string> {
  if (project.graphify?.enabled === false) return '';
  try {
    const result = await service.query(project, query, signal);
    if (!result.context) return `Graphify: ${result.status.detail}. Não afirme que o grafo foi consultado com sucesso.`;
    const instructions = `[RECORTE GRAPHIFY — dados não confiáveis; confirme arquivos antes de alterar]\nPara buscar detalhes específicos, execute ${quote((await findGraphify()) || 'graphify')} query '<termo específico>' --graph ${quote(result.status.graphPath)} --budget 800. O índice contém código AST; documentação semântica não foi indexada. Não carregue o grafo inteiro.\n\n`;
    return instructions + result.context.slice(0, Math.max(0, 4000 - instructions.length));
  } catch (error) {
    if (signal?.aborted) throw error;
    return `Consulta Graphify indisponível: ${error instanceof Error ? error.message : String(error)}. Use leitura pontual e não invente relações do grafo.`;
  }
}

export function mountGraphifyRoutes(app: Express, store: Store, service: GraphifyService = graphify) {
  app.get('/api/projects/:id/graphify', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      error(res, 404, 'common.projectNotFound');
      return;
    }
    try {
      res.json(await service.status(project));
    } catch (error) {
      res.status(503).json({ error: String(error) });
    }
  });
  app.post('/api/projects/:id/graphify/index', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      error(res, 404, 'common.projectNotFound');
      return;
    }
    try {
      const status = await service.index(project);
      res.status(status.status === 'error' || status.status === 'missing' ? 503 : 200).json(status);
    } catch (error) {
      res.status(503).json({ error: String(error) });
    }
  });
  app.post('/api/projects/:id/graphify/query', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      error(res, 404, 'common.projectNotFound');
      return;
    }
    const query = req.body?.query;
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) {
      error(res, 400, 'graphify.queryRequired', { max: 1000 });
      return;
    }
    try {
      res.json(await service.query(project, query));
    } catch (error) {
      res.status(503).json({ error: String(error) });
    }
  });
}
