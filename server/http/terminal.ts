import { Router, type Request, type Response } from 'express';
import { TerminalRunSchema, TerminalStopSchema, parseBody } from '../../shared/schemas.js';
import {
  TERMINAL_MAX_RUNNING,
  TERMINAL_TIMEOUT_DEFAULT_SEC,
  type TerminalCommand,
  type TerminalState,
} from '../../shared/terminal.js';
import type { Store } from '../store.js';
import type { TerminalService } from '../terminal.js';
import { requestKind } from './auth.js';
import { error, errorStatus, message } from './common.js';
import type { BackendContext } from './context.js';

export const TERMINAL_REMOTE_DISABLED =
  'O terminal está desativado no acesso remoto. Ative "Permitir terminal pelo acesso remoto" em Configurações, neste computador.';
export const TERMINAL_INTERNET_DISABLED =
  'O terminal nunca fica disponível pelo acesso pela internet (Tailscale Funnel). Use este computador ou a tailnet.';

/**
 * Tailnet clients may use the terminal only after the opt-in setting; internet clients
 * (Tailscale Funnel) never can (docs/specs/remote-access.md).
 */
export function terminalAccess(req: Request, store: Store) {
  const kind = requestKind(req);
  const remote = kind !== 'local';
  const enabled = kind === 'local' || (kind === 'tailnet' && store.getSettings()?.terminalRemote === true);
  const reason = kind === 'internet' ? TERMINAL_INTERNET_DISABLED : TERMINAL_REMOTE_DISABLED;
  return { remote, enabled, ...(enabled ? {} : { reason }) };
}

/** Integrated command runner (docs/specs/terminal-preview.md). Commands never reach a model. */
export function terminalRoutes({ store }: BackendContext, terminal: TerminalService) {
  const app = Router();
  const allowed = (req: Request, res: Response) => {
    const access = terminalAccess(req, store);
    if (!access.enabled) error(res, 403, access.reason!);
    return access.enabled;
  };
  const project = (req: Request, res: Response) => {
    const found = store.getProject(String(req.params.id));
    if (!found) error(res, 404, 'Projeto não encontrado');
    return found;
  };
  const owned = (req: Request, res: Response): TerminalCommand | undefined => {
    const command = terminal.get(String(req.params.id));
    if (!command) error(res, 404, 'Comando não encontrado');
    return command;
  };

  app.get('/api/projects/:id/terminal', (req, res) => {
    const p = project(req, res);
    if (!p) return;
    const access = terminalAccess(req, store);
    const state: TerminalState = {
      ...access,
      sandbox: store.getSettings()!.sandbox,
      maxRunning: TERMINAL_MAX_RUNNING,
      // Output stays on this computer unless the remote opt-in is on.
      commands: access.enabled ? terminal.list(p.id) : [],
    };
    res.json(state);
  });
  app.post('/api/projects/:id/terminal', async (req, res) => {
    if (!allowed(req, res)) return;
    const p = project(req, res);
    if (!p) return;
    const parsed = parseBody(TerminalRunSchema, req.body, 'Comando inválido');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      const started = await terminal.start({
        projectId: p.id,
        cwd: p.path,
        command: parsed.data.command,
        // The sandbox is read when the command starts, like an agent run.
        sandbox: store.getSettings()!.sandbox,
        timeoutMs: (parsed.data.timeoutSec ?? TERMINAL_TIMEOUT_DEFAULT_SEC) * 1000,
      });
      res.status(202).json({ id: started.id, command: started });
    } catch (e) {
      error(res, errorStatus(e) || 500, message(e));
    }
  });
  app.get('/api/projects/:id/terminal/events', (req, res) => {
    if (!allowed(req, res)) return;
    const p = project(req, res);
    if (!p) return;
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // Snapshot and subscription happen in the same tick, so no output is lost or repeated.
    res.write(`data: ${JSON.stringify({ type: 'snapshot', commands: terminal.list(p.id) })}\n\n`);
    const unsubscribe = terminal.subscribe(p.id, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
  app.get('/api/terminal/:id', (req, res) => {
    if (!allowed(req, res)) return;
    const command = owned(req, res);
    if (command) res.json(command);
  });
  app.post('/api/terminal/:id/stop', async (req, res) => {
    if (!allowed(req, res)) return;
    const parsed = parseBody(TerminalStopSchema, req.body, 'Envie um corpo JSON vazio ({})');
    if (!parsed.ok) return error(res, 400, parsed.message);
    if (!owned(req, res)) return;
    res.json(await terminal.stop(String(req.params.id)));
  });
  return app;
}
