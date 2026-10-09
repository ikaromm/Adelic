import { expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { remoteHostsRoutes } from '../server/http/remote-hosts';

it('lets a probed alias use its configured port when HTTP omits a port', async () => {
  const ports: (number | undefined)[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    remoteHostsRoutes({
      orchestrator: {
        remoteHosts: {
          probe: async (target: string, port?: number) => {
            ports.push(port);
            return { target, port: port ?? 2222 };
          },
        },
      },
    } as never),
  );
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/remote-hosts/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'configured-alias' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ target: 'configured-alias', port: 2222 });
    expect(ports).toEqual([undefined]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('allows initial SSH browsing at root while rejecting relative and empty paths', async () => {
  const roots: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    remoteHostsRoutes({
      store: { getRemoteHost: () => ({ id: 'host' }) },
      orchestrator: {
        remoteHosts: {
          call: async (_host: unknown, root: string) => {
            roots.push(root);
            return { entries: [{ name: 'home', path: 'home', directory: true }], truncated: false };
          },
        },
      },
    } as never),
  );
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    const endpoint = `http://127.0.0.1:${address.port}/api/remote-hosts/host/directories`;
    expect((await fetch(`${endpoint}?path=%2F`)).status).toBe(200);
    expect((await fetch(`${endpoint}?path=relative`)).status).toBe(400);
    expect((await fetch(`${endpoint}?path=`)).status).toBe(400);
    expect(roots).toEqual(['/']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
