// "Atualizar Adelic" in the desktop AppImage (docs/specs/self-update.md), with a local plain
// HTTP release server (tests only: the production policy accepts github.com over https).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../shared/contracts.js';
import { SelfUpdateService, type UpdateGuard } from '../server/self-update.js';
import {
  GITHUB_POLICY,
  appImageCheck,
  assetName,
  parseChecksum,
  type AppImageOptions,
} from '../server/self-update-appimage.js';

const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(4096, 7)]);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Fake {
  base: string;
  /** Asset served for the next version. */
  body: Buffer;
  /** Checksum served (defaults to the real one). */
  sum?: string;
  /** Redirect the asset to this absolute URL. */
  redirect?: string;
  hits: string[];
}

async function releaseServer(version = '99.0.0') {
  const fake: Fake = { base: '', body: ELF, hits: [] };
  const name = assetName(version);
  const server: Server = createServer((req, res) => {
    fake.hits.push(req.url!);
    if (req.url === '/api/latest')
      return res.end(
        JSON.stringify({
          tag_name: `v${version}`,
          html_url: `${fake.base}/releases/tag/v${version}`,
          assets: [
            { name, browser_download_url: `${fake.base}/download/v${version}/${name}`, size: fake.body.length },
            { name: `${name}.sha256`, browser_download_url: `${fake.base}/download/v${version}/${name}.sha256` },
          ],
        }),
      );
    if (req.url === `/download/v${version}/${name}.sha256`)
      return res.end(`${fake.sum ?? createHash('sha256').update(fake.body).digest('hex')}  ${name}\n`);
    if (req.url === `/download/v${version}/${name}`) {
      if (fake.redirect) {
        res.writeHead(302, { location: fake.redirect });
        return res.end();
      }
      return res.end(fake.body);
    }
    if (req.url === '/cdn/asset') return res.end(fake.body);
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  fake.base = `http://127.0.0.1:${address.port}`;
  cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
  return fake;
}

function installed(content = 'old appimage') {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-appimage-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'Adelic.AppImage');
  writeFileSync(path, content, { mode: 0o755 });
  return { dir, path };
}

function options(fake: Fake, path: string, extra: Partial<AppImageOptions> = {}): AppImageOptions {
  // Only the latest-release call is redirected to the fake API; downloads use the URLs it lists.
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return fetch(url.startsWith('https://api.github.com/') ? `${fake.base}/api/latest` : url, init);
  }) as typeof fetch;
  return {
    path,
    fetcher,
    current: '0.4.0',
    policy: { prefix: `${fake.base}/download/`, redirectHosts: [new URL(fake.base).host], allowHttp: true },
    ...extra,
  };
}

const guard = (): UpdateGuard & { released: ReturnType<typeof vi.fn> } => {
  const released = vi.fn();
  return { released, block: () => undefined, begin: () => released };
};

async function run(appImage: AppImageOptions) {
  const restart = vi.fn();
  const updater = new SelfUpdateService({ kind: 'appimage', appImage, restart });
  const g = guard();
  const status = await updater.check({} as Settings, g);
  if (status.canApply) await updater.apply({} as Settings, g, { target: status.target });
  for (let i = 0; i < 200 && updater.progress().state === 'running'; i++) await new Promise((d) => setTimeout(d, 20));
  return { status, progress: updater.progress(), restart, released: g.released };
}

const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.includes('.update-'));

describe('AppImage update', () => {
  it('downloads, verifies, swaps atomically keeping .previous, and restarts', async () => {
    const fake = await releaseServer();
    const { dir, path } = installed();
    const { status, progress, restart } = await run(options(fake, path));
    expect(status).toMatchObject({
      kind: 'appimage',
      available: true,
      canApply: true,
      target: '99.0.0',
      release: { latest: '99.0.0', writable: true },
    });
    expect(progress.state).toBe('restarting');
    expect(progress.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(readFileSync(path).equals(ELF)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readFileSync(`${path}.previous`, 'utf8')).toBe('old appimage');
    expect(restart).toHaveBeenCalledTimes(1);
    expect(leftovers(dir)).toEqual([]);
  });

  it('follows an allowed redirect', async () => {
    const fake = await releaseServer();
    fake.redirect = `${fake.base}/cdn/asset`;
    const { path } = installed();
    expect((await run(options(fake, path))).progress.state).toBe('restarting');
    expect(fake.hits).toContain('/cdn/asset');
  });

  it('rejects a redirect to a host outside the policy', async () => {
    const fake = await releaseServer();
    fake.redirect = 'http://example.invalid/asset';
    const { path } = installed();
    const { progress, restart, released } = await run(options(fake, path));
    expect(progress).toMatchObject({ state: 'failed', error: expect.stringMatching(/não permitido: example.invalid/) });
    expect(readFileSync(path, 'utf8')).toBe('old appimage');
    expect(restart).not.toHaveBeenCalled();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('rejects a SHA-256 mismatch and leaves the installed file alone', async () => {
    const fake = await releaseServer();
    fake.sum = 'a'.repeat(64);
    const { dir, path } = installed();
    const { progress, restart } = await run(options(fake, path));
    expect(progress).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/SHA-256 do download não confere/),
    });
    expect(progress.steps.find((s) => s.id === 'verify')?.status).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe('old appimage');
    expect(existsSync(`${path}.previous`)).toBe(false);
    expect(leftovers(dir)).toEqual([]);
    expect(restart).not.toHaveBeenCalled();
  });

  it('rejects a file that is not ELF even when its checksum matches', async () => {
    const fake = await releaseServer();
    fake.body = Buffer.from('#!/bin/sh\necho não sou um AppImage\n');
    const { path } = installed();
    const { progress } = await run(options(fake, path));
    expect(progress).toMatchObject({ state: 'failed', error: expect.stringMatching(/não é um executável ELF/) });
    expect(readFileSync(path, 'utf8')).toBe('old appimage');
  });

  it('stops a download over the size cap', async () => {
    const fake = await releaseServer();
    const { dir, path } = installed();
    const { progress } = await run(options(fake, path, { maxBytes: 1024 }));
    expect(progress).toMatchObject({ state: 'failed', error: expect.stringMatching(/limite de/) });
    expect(readFileSync(path, 'utf8')).toBe('old appimage');
    expect(leftovers(dir)).toEqual([]);
  });

  it('explains when the AppImage cannot be replaced, and links to the release', async () => {
    const fake = await releaseServer();
    const { dir, path } = installed();
    chmodSync(dir, 0o555);
    cleanup.push(() => chmodSync(dir, 0o755));
    const { status } = await run(options(fake, path));
    expect(status).toMatchObject({ available: true, canApply: false, release: { writable: false } });
    expect(status.blocked).toMatch(/Sem permissão para substituir/);
    expect(status.releaseUrl).toBe('https://github.com/ikaromm/Adelic/releases');
    const updater = new SelfUpdateService({ kind: 'appimage', appImage: options(fake, path) });
    await updater.check({} as Settings, guard());
    await expect(updater.apply({} as Settings, guard(), {})).rejects.toMatchObject({ status: 409 });
  });

  it('does not offer prereleases or the same version', async () => {
    const { path } = installed();
    for (const body of [
      { tag_name: 'v99.0.0', html_url: 'https://x.y/z', prerelease: true },
      { tag_name: 'v0.4.0', html_url: 'https://x.y/z' },
    ]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
      expect((await appImageCheck({ path, fetcher, current: '0.4.0' })).available).toBe(false);
    }
  });

  it('refuses a release without the AppImage or its checksum', async () => {
    const { path } = installed();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://x.y/z' })));
    await expect(appImageCheck({ path, fetcher, current: '0.4.0' })).rejects.toThrow(/não tem Adelic-99.0.0/);
    const updater = new SelfUpdateService({ kind: 'appimage', appImage: { path, fetcher, current: '0.4.0' } });
    expect((await updater.check({} as Settings, guard())).error).toMatch(/não tem Adelic-99.0.0/);
  });

  it('accepts only the project release URLs over https in production', async () => {
    const { path } = installed();
    const name = assetName('99.0.0');
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.github.com/'))
        return new Response(
          JSON.stringify({
            tag_name: 'v99.0.0',
            html_url: 'https://github.com/ikaromm/Adelic/releases/tag/v99.0.0',
            assets: [
              { name, browser_download_url: `https://evil.example/${name}` },
              { name: `${name}.sha256`, browser_download_url: `https://evil.example/${name}.sha256` },
            ],
          }),
        );
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    const { progress } = await run({ path, fetcher, current: '0.4.0' });
    expect(progress).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/endereço de download não permitido/),
    });
    expect(GITHUB_POLICY.prefix).toBe('https://github.com/ikaromm/Adelic/releases/download/');
    expect(GITHUB_POLICY.allowHttp).toBeUndefined();
  });

  it('parses sha256sum lines for the right file only', () => {
    const sum = 'b'.repeat(64);
    expect(parseChecksum(`${sum}  Adelic-1.0.0-linux-x86_64.AppImage\n`, 'Adelic-1.0.0-linux-x86_64.AppImage')).toBe(
      sum,
    );
    expect(parseChecksum(`${sum.toUpperCase()} *release/Adelic.AppImage`, 'Adelic.AppImage')).toBe(sum);
    expect(() => parseChecksum(`${sum}  outro.AppImage`, 'Adelic.AppImage')).toThrow(/não lista/);
    expect(() => parseChecksum('xyz  Adelic.AppImage', 'Adelic.AppImage')).toThrow();
  });
});
