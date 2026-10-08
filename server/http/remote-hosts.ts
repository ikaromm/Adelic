import { Router } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { RemoteHost } from '../../shared/remote-hosts.js';
import type { BackendContext } from './context.js';
import { requestKind } from './auth.js';
import { error } from './common.js';
import { sshConfigAliases } from '../remote/ssh-config.js';

const target = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.@:[\]-]+$/)
  .refine((s) => !s.startsWith('-'));
const port = z.number().int().min(1).max(65535);
const absolute = z
  .string()
  .min(2)
  .max(4096)
  .refine((s) => s.startsWith('/') && !s.includes('\0'));
const probeSchema = z.object({ target, port: port.optional() }).strict();
const hostSchema = probeSchema
  .extend({
    port: port.default(22),
    name: z.string().trim().min(1).max(100),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    hostKey: z.string().min(40).max(4096),
    runnerPath: absolute,
  })
  .strict();
/** Host management and direct browsing are local actions; the SSH side is always untrusted. */
export function remoteHostsRoutes({ store, orchestrator }: BackendContext) {
  const app = Router();
  app.use('/api/remote-hosts', (req, res, next) => {
    if (requestKind(req) !== 'local') return error(res, 403, 'remotehosts.localOnly');
    next();
  });
  app.get('/api/remote-hosts', (_req, res) => res.json(store.listRemoteHosts()));
  app.get('/api/remote-hosts/ssh-config', async (_req, res) => {
    try {
      res.json({ aliases: await sshConfigAliases() });
    } catch (e) {
      error(res, 409, e as Error);
    }
  });
  app.post('/api/remote-hosts/probe', async (req, res) => {
    const parsed = probeSchema.safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'remotehosts.invalid');
    try {
      res.json(await orchestrator.remoteHosts.probe(parsed.data.target, parsed.data.port));
    } catch (e) {
      error(res, 409, e as Error);
    }
  });
  app.post('/api/remote-hosts', (req, res) => {
    const parsed = hostSchema.safeParse(req.body);
    if (!parsed.success) return error(res, 400, 'remotehosts.invalid');
    const fields = parsed.data.hostKey.trim().split(/\s+/);
    const key = fields.length === 2 ? fields[1] : fields[2];
    const kind = fields.length === 2 ? fields[0] : fields[1];
    if (
      !key ||
      !kind ||
      !['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'].includes(kind)
    )
      return error(res, 400, 'remotehosts.invalid');
    const decoded = Buffer.from(key, 'base64');
    const fingerprint = 'SHA256:' + createHash('sha256').update(decoded).digest('base64').replace(/=+$/, '');
    if (decoded.length < 32 || fingerprint !== parsed.data.fingerprint) return error(res, 400, 'remotehosts.invalid');
    const host: RemoteHost = {
      ...parsed.data,
      hostKey: `${kind} ${key}`,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    res.status(201).json(store.putRemoteHost(host));
  });
  for (const action of ['test', 'install', 'disconnect'] as const) {
    app.post(`/api/remote-hosts/:id/${action}`, async (req, res) => {
      const host = store.getRemoteHost(req.params.id);
      if (!host) return error(res, 404, 'remotehosts.notFound');
      try {
        const result =
          action === 'disconnect'
            ? await orchestrator.disconnectRemoteHost(host.id)
            : await orchestrator.remoteHosts[action](host);
        res.json({
          ok: true,
          detail: result
            ? JSON.stringify(result)
            : action === 'install'
              ? 'Executor instalado sem credenciais.'
              : 'Conexões SSH encerradas.',
        });
      } catch (e) {
        error(res, 409, e as Error);
      }
    });
  }
  app.delete('/api/remote-hosts/:id', async (req, res) => {
    const host = store.getRemoteHost(req.params.id);
    if (!host) return error(res, 404, 'remotehosts.notFound');
    if (store.listProjects().some((p) => p.remote?.hostId === host.id)) return error(res, 409, 'remotehosts.inUse');
    await orchestrator.remoteHosts.disconnect(host.id);
    store.deleteRemoteHost(host.id);
    res.json({});
  });
  app.get('/api/remote-hosts/:id/directories', async (req, res) => {
    const host = store.getRemoteHost(req.params.id);
    if (!host) return error(res, 404, 'remotehosts.notFound');
    const path = absolute.safeParse(req.query.path);
    if (!path.success) return error(res, 400, 'remotehosts.invalid');
    try {
      res.json(
        await orchestrator.remoteHosts.call(host, path.data, 'list', { path: '.' }, new AbortController().signal),
      );
    } catch (e) {
      error(res, 409, e as Error);
    }
  });
  app.get('/api/projects/:id/remote-git', async (req, res) => {
    if (requestKind(req) !== 'local') return error(res, 403, 'remotehosts.localOnly');
    const project = store.getProject(req.params.id);
    if (!project?.remote) return error(res, 409, 'remotehosts.unsupported');
    const host = store.getRemoteHost(project.remote.hostId);
    if (!host) return error(res, 404, 'remotehosts.notFound');
    const operation = z.enum(['status', 'diff', 'log']).safeParse(req.query.operation);
    if (!operation.success) return error(res, 400, 'remotehosts.invalid');
    try {
      const result = (await orchestrator.remoteHosts.call(
        host,
        project.remote.path,
        'git',
        { operation: operation.data },
        new AbortController().signal,
      )) as { stdout: string; stderr: string; exitCode: number };
      res.json({ output: result.stdout || result.stderr, exitCode: result.exitCode });
    } catch (e) {
      error(res, 409, e as Error);
    }
  });
  return app;
}
