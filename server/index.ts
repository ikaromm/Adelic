import express, { type NextFunction, type Request, type Response } from 'express';
import { execFileSync } from 'node:child_process';
import type { ProviderRegistry } from '../shared/contracts.js';
import { memoryIntegration, memoryIntegrationSnapshot } from './memory.js';
import { Orchestrator } from './orchestrator.js';
import { Store } from './store.js';
import { GraphifyService, graphify, mountGraphifyRoutes } from './graphify.js';
import { error, message, originGuard } from './http/common.js';
import type { BackendContext } from './http/context.js';
import type { RetryPolicy } from './retry.js';
import { accessGuard, authRoutes, type RemoteAccess } from './http/auth.js';
import { commandsRoutes } from './http/commands.js';
import { diagnosticsRoutes } from './http/diagnostics.js';
import { memoryRoutes } from './http/memory.js';
import { projectsRoutes } from './http/projects.js';
import { plansRoutes } from './http/plans.js';
import { runsRoutes } from './http/runs.js';
import { isAttachmentUpload, sessionsRoutes } from './http/sessions.js';
import { settingsRoutes } from './http/settings.js';
import { isVoiceUpload, voiceRoutes } from './http/voice.js';
import { VoiceService } from './voice.js';

export function createBackend(
  store: Store,
  providers: ProviderRegistry,
  graphifyService: GraphifyService = graphify,
  // Optional remote access (token-protected); see server/http/auth.ts. Off by default.
  remote?: RemoteAccess,
  // Test hook for the retry delays (production uses DEFAULT_RETRY).
  retryOverrides?: Partial<RetryPolicy>,
  // Local voice dictation (server/voice.ts); tests inject fake command runners.
  voice: VoiceService = new VoiceService(),
) {
  const app = express();
  app.disable('x-powered-by');
  // Attachment and dictation uploads carry base64 data: those routes parse their own larger
  // body, after the access guard, so unauthenticated requests never get the bigger parsers.
  const json = express.json({ limit: '128kb', strict: true });
  app.use((req, res, next) => (isAttachmentUpload(req) || isVoiceUpload(req) ? next() : json(req, res, next)));
  const orchestrator = new Orchestrator(store, providers, undefined, graphifyService, providerList, retryOverrides);
  let providersCache: { at: number; value: Awaited<ReturnType<typeof providers.list>> } | undefined;
  let providersPending: Promise<Awaited<ReturnType<typeof providers.list>>> | undefined;
  async function providerList() {
    if (providersCache && Date.now() - providersCache.at <= 10000) return providersCache.value;
    if (!providersPending)
      providersPending = providers
        .list()
        .then((value) => {
          providersCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          providersPending = undefined;
        });
    return providersPending;
  }
  let jail: string | undefined;
  function jailIntegration() {
    if (!jail) {
      try {
        jail = execFileSync('which', ['ai-jail'], {
          encoding: 'utf8',
          timeout: 300,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        jail = '';
      }
    }
    return {
      id: 'ai-jail',
      name: 'ai-jail',
      kind: 'sandbox' as const,
      status: jail ? ('planned' as const) : ('missing' as const),
      detail: jail
        ? 'ai-jail instalado, mas não usado: os runtimes usam o bubblewrap do Adelic (docs/specs/ai-jail.md)'
        : 'ai-jail não encontrado; os runtimes usam o bubblewrap do Adelic (docs/specs/ai-jail.md)',
    };
  }
  function integrations() {
    return [
      memoryIntegrationSnapshot(),
      jailIntegration(),
      {
        id: 'runtime-tools',
        name: 'Ferramentas dos runtimes',
        kind: 'tool' as const,
        status: 'ready' as const,
        detail: 'Capacidades declaradas individualmente por cada provedor',
      },
    ];
  }
  app.use(authRoutes(remote));
  app.use(accessGuard(remote, originGuard));
  app.get('/api/bootstrap', async (_req, res) => {
    try {
      const [providersResult] = await Promise.all([providerList(), memoryIntegration()]);
      res.json(store.bootstrap(providersResult, integrations()));
    } catch (e) {
      error(res, 500, message(e));
    }
  });
  const context: BackendContext = { store, orchestrator, providerList };
  app.use(projectsRoutes(context));
  app.use(sessionsRoutes(context));
  app.use(runsRoutes(context));
  app.use(plansRoutes(context));
  app.use(settingsRoutes(context));
  app.use(commandsRoutes(context));
  app.use(memoryRoutes(context));
  app.use(diagnosticsRoutes(context));
  app.use(voiceRoutes(context, voice));
  app.get('/api/health', async (_req, res) => {
    res.json({
      status: 'ok',
      providers: (await providerList()).map((p) => ({ id: p.id, status: p.status, available: p.available })),
      memory: (await memoryIntegration()).status,
      jail: jailIntegration().status === 'planned' ? 'installed' : 'missing',
    });
  });
  app.get('/api/export', (_req, res) => res.json(store.exportData()));
  mountGraphifyRoutes(app, store, graphifyService);
  app.use('/api', (req, res) => error(res, 404, 'Endpoint não encontrado'));
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => error(res, 400, message(e)));
  return { app, orchestrator, graphify: graphifyService };
}
