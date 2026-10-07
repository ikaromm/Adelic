import { Router, type Request, type Response } from 'express';
import type { RemoteAccessState } from '../../shared/remote-access.js';
import { RemoteAccountSchema, RemoteFunnelSchema, parseBody } from '../../shared/schemas.js';
import type { FunnelService } from '../funnel.js';
import type { Store } from '../store.js';
import { LOCAL_ONLY, type AccessControl, accessOf, requestKind } from './auth.js';
import { error, errorStatus, message } from './common.js';

/** The loopback listener that receives Funnel traffic; started by the runtime on demand. */
export interface FunnelListener {
  /** Starts it when needed; resolves to the port it listens on. */
  ensure(): Promise<number>;
  listening(): boolean;
  port(): number;
}

/**
 * Tailscale Funnel switch (docs/specs/remote-access.md). Never turned on by itself: only an
 * explicit request from this computer, or at startup when the user had asked for it before
 * ("funnelWanted") and an account still exists.
 */
export class FunnelControl {
  lastError?: string;
  /** enable/disable/restore run one at a time, so a startup re-apply cannot undo a later "Desligar". */
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }
  constructor(
    private readonly store: Store,
    private readonly access: AccessControl,
    readonly service: FunnelService,
    readonly listener: FunnelListener | undefined,
  ) {}
  private save(wanted: boolean, port: number) {
    const settings = this.store.getSettings()!;
    this.store.setSettings({ ...settings, funnel: { wanted, port } });
  }
  /** Ports that earlier runs may have published, so a changed ADELIC_FUNNEL_PORT is still "ours". */
  private previousPort() {
    return this.store.getSettings()?.funnel?.port;
  }
  async status() {
    const port = this.listener?.port() ?? 0;
    return this.service.status(port, this.previousPort());
  }
  enable() {
    return this.serial(() => this.enableNow());
  }
  disable() {
    return this.serial(() => this.disableNow());
  }
  private async enableNow() {
    if (!this.listener)
      throw Object.assign(new Error('Este Adelic não tem a porta do Funnel configurada.'), { status: 409 });
    if (!this.access.accounts.hasAccount())
      throw Object.assign(new Error('Crie o usuário e a senha antes de publicar na internet.'), { status: 409 });
    const port = await this.listener.ensure();
    try {
      const state = await this.service.enable(port, this.previousPort());
      delete this.lastError;
      this.save(true, port);
      return state;
    } catch (e) {
      this.lastError = message(e);
      throw e;
    }
  }
  private async disableNow() {
    const port = this.listener?.port() ?? this.previousPort() ?? 0;
    this.save(false, port);
    try {
      const state = await this.service.disable(port, this.previousPort());
      delete this.lastError;
      return state;
    } catch (e) {
      this.lastError = message(e);
      throw e;
    }
  }
  /** Startup: re-applies Funnel (idempotent) only when it was wanted and an account exists. */
  restore() {
    return this.serial(async () => {
      const wanted = this.store.getSettings()?.funnel?.wanted === true;
      if (!wanted || !this.listener || !this.access.accounts.hasAccount()) return false;
      try {
        await this.enableNow();
        return true;
      } catch {
        return false; // lastError is shown in Settings; startup goes on.
      }
    });
  }
}

/** Settings › "Acesso remoto": account, sessions, last logins and the Funnel switch. */
export function remoteAccessRoutes(store: Store, access: AccessControl, funnel: FunnelControl) {
  const app = Router();
  const fail = (res: Response, e: unknown) => {
    const url = (e as { url?: string }).url;
    res.status(errorStatus(e) || 500).json({ error: message(e), ...(url ? { url } : {}) });
  };
  const state = (req: Request): RemoteAccessState => {
    const kind = accessOf(req).kind;
    const local = kind === 'local';
    const remote = access.remote;
    return {
      kind,
      account: access.accounts.account(),
      sessions: access.accounts.listSessions(access.sessionKey(req)),
      logins: access.accounts.listLogins(30),
      // The tailnet address is not shown to internet sessions.
      tailnet:
        remote && kind !== 'internet'
          ? {
              url: `http://${remote.bind.includes(':') ? `[${remote.bind}]` : remote.bind}:${remote.port}`,
              token: true,
            }
          : null,
      funnel: funnel.listener
        ? {
            port: funnel.listener.port(),
            listening: funnel.listener.listening(),
            wanted: store.getSettings()?.funnel?.wanted === true,
            // Tailscale error texts stay on this computer.
            ...(funnel.lastError && local ? { lastError: funnel.lastError } : {}),
          }
        : null,
      internetManualApproval: store.getSettings()?.internetManualApproval !== false,
    };
  };
  app.get('/api/remote-access', (req, res) => res.json(state(req)));
  // Credentials, Tailscale and the Funnel switch: this computer only. The guard refuses them
  // from remote clients already; each handler checks again.
  const local = (req: Request, res: Response) => {
    if (requestKind(req) === 'local') return true;
    error(res, 403, LOCAL_ONLY);
    return false;
  };
  app.put('/api/remote-access/account', async (req, res) => {
    if (!local(req, res)) return;
    const parsed = parseBody(RemoteAccountSchema, req.body, 'Usuário ou senha inválidos');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      await access.accounts.setAccount(parsed.data.username, parsed.data.password);
      access.closeStreams();
      res.json(state(req));
    } catch (e) {
      fail(res, e);
    }
  });
  app.delete('/api/remote-access/account', async (req, res) => {
    if (!local(req, res)) return;
    access.accounts.deleteAccount();
    access.closeStreams();
    // Without an account nobody can log in from the internet; unpublish too when it was on.
    if (store.getSettings()?.funnel?.wanted) await funnel.disable().catch(() => undefined);
    res.json(state(req));
  });
  app.delete('/api/remote-access/sessions/:id', (req, res) => {
    const key = access.accounts.revokeSession(String(req.params.id));
    if (!key) return error(res, 404, 'Sessão não encontrada');
    access.closeStreams(key);
    res.json(state(req));
  });
  app.post('/api/remote-access/sessions/revoke-all', (req, res) => {
    access.accounts.revokeAll();
    access.closeStreams();
    res.json(state(req));
  });
  app.get('/api/remote-access/tailscale', async (req, res) => {
    if (!local(req, res)) return;
    try {
      res.json(await funnel.status());
    } catch (e) {
      fail(res, e);
    }
  });
  app.put('/api/remote-access/funnel', async (req, res) => {
    if (!local(req, res)) return;
    const parsed = parseBody(RemoteFunnelSchema, req.body, 'enabled deve ser booleano');
    if (!parsed.ok) return error(res, 400, parsed.message);
    try {
      const tailscale = parsed.data.enabled ? await funnel.enable() : await funnel.disable();
      res.json({ tailscale, state: state(req) });
    } catch (e) {
      fail(res, e);
    }
  });
  return app;
}
