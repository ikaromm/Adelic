import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createLocalProjectFolder, listLocalProjectFolders } from '../server/local-project-folders';
import { projectsRoutes } from '../server/http/projects';

const roots: string[] = [];
const tempDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), 'adelic-local-folders-'));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('lists only directories, resolves the selected parent and caps the returned list', () => {
  const root = tempDirectory();
  mkdirSync(join(root, 'folder'));
  writeFileSync(join(root, 'secret.txt'), 'private contents');
  symlinkSync(join(root, 'folder'), join(root, 'folder-link'));
  const result = listLocalProjectFolders(root);
  expect(result.path).toBe(root);
  expect(result.entries).toEqual([
    {
      name: 'folder',
      path: join(root, 'folder'),
      directory: true,
      readable: true,
      writable: true,
    },
  ]);
  expect(result.truncated).toBe(false);
  expect(result.readable).toBe(true);
  expect(result.writable).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret.txt');
  expect(JSON.stringify(result)).not.toContain('private contents');

  const many = tempDirectory();
  for (let index = 0; index < 110; index++) mkdirSync(join(many, `folder-${index}`));
  const capped = listLocalProjectFolders(many);
  expect(capped.entries).toHaveLength(100);
  expect(capped.truncated).toBe(true);
});

it('creates one child safely and refuses invalid names, existing targets and unknown parents', () => {
  const root = tempDirectory();
  const made = createLocalProjectFolder(root, 'new-project');
  expect(made.path).toBe(join(root, 'new-project'));
  expect(() => createLocalProjectFolder(root, 'new-project')).toThrow();
  const elsewhere = tempDirectory();
  symlinkSync(elsewhere, join(root, 'parent-link'));
  expect(createLocalProjectFolder(join(root, 'parent-link'), 'inside')).toEqual({ path: join(elsewhere, 'inside') });
  writeFileSync(join(root, 'existing-target'), 'leave it alone');
  symlinkSync(join(root, 'existing-target'), join(root, 'target-link'));
  expect(() => createLocalProjectFolder(root, 'target-link')).toThrow();
  expect(existsSync(join(root, 'existing-target'))).toBe(true);
  for (const invalid of ['', '.', '..', 'a/b', 'a\\b', '\0'])
    expect(() => createLocalProjectFolder(root, invalid)).toThrow();
  expect(() => createLocalProjectFolder(join(root, 'missing'), 'child')).toThrow();
  expect(existsSync(join(root, 'missing', 'child'))).toBe(false);
});

it('exposes local browsing only to a local request', async () => {
  const root = tempDirectory();
  mkdirSync(join(root, 'child'));
  const app = express();
  app.use(express.json());
  app.use(projectsRoutes({ store: {}, orchestrator: {}, providerList: {}, automations: {} } as never));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    const local = await fetch(
      `http://127.0.0.1:${address.port}/api/local-directories?path=${encodeURIComponent(root)}`,
    );
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({
      path: root,
      readable: true,
      writable: true,
      entries: [
        {
          name: 'child',
          path: join(root, 'child'),
          directory: true,
          readable: true,
          writable: true,
        },
      ],
      truncated: false,
    });
    const remote = await fetch(
      `http://127.0.0.1:${address.port}/api/local-directories?path=${encodeURIComponent(root)}`,
      {
        headers: { 'tailscale-user-login': 'someone@example.test' },
      },
    );
    expect(remote.status).toBe(403);
    const remoteCreate = await fetch(`http://127.0.0.1:${address.port}/api/local-directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tailscale-user-login': 'someone@example.test' },
      body: JSON.stringify({ parentPath: root, name: 'remote-created' }),
    });
    expect(remoteCreate.status).toBe(403);
    expect(existsSync(join(root, 'remote-created'))).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
