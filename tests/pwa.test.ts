import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  cacheName,
  classifyRequest,
  isApiPath,
  isCacheableResponse,
  OFFLINE_URL,
  precacheEntries,
  staleCaches,
} from '../src/pwa/sw-core';
import {
  installWorker,
  SKIP_WAITING,
  type ExtendableEventLike,
  type FetchEventLike,
  type MessageEventLike,
} from '../src/pwa/sw';
import { shouldRegister } from '../src/pwa/client';

const root = resolve(import.meta.dirname, '..');
const ORIGIN = 'https://adelic.tail.ts.net';
const shell = new Set(['/index.html', '/assets/main-abc.js', '/icons/icon-192.png', OFFLINE_URL]);
const req = (path: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}) => ({
  method: init.method ?? 'GET',
  url: path.startsWith('http') ? path : ORIGIN + path,
  mode: init.mode,
  headers: new Headers(init.headers),
});

/** Reads width and height from a PNG's IHDR chunk. */
function pngSize(file: string) {
  const data = readFileSync(file);
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(data.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe('web app manifest', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
  const tokens = readFileSync(join(root, 'src/styles/tokens.css'), 'utf8');

  it('declares an installable standalone app in pt-BR', () => {
    expect(manifest).toMatchObject({
      name: 'Adelic',
      short_name: 'Adelic',
      lang: 'pt-BR',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest.description).toMatch(/agentes de IA/);
  });

  it('uses the dark theme background token for theme and background colours', () => {
    const appBg = /--app-bg:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1];
    expect(appBg).toBeDefined();
    expect(manifest.theme_color).toBe(appBg);
    expect(manifest.background_color).toBe(appBg);
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain(`<meta name="theme-color" content="${appBg}" />`);
  });

  it('lists 192 and 512 icons plus a maskable one, each a PNG of the declared size', () => {
    const sizes = manifest.icons.map((icon: { sizes: string; purpose: string }) => `${icon.sizes} ${icon.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192 any', '512x512 any', '512x512 maskable']));
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(pngSize(join(root, 'public', icon.src))).toEqual({ width, height });
    }
  });

  it('is linked from index.html with an Apple touch icon', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const apple = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
    expect(apple).toBeDefined();
    expect(pngSize(join(root, 'public', apple!))).toEqual({ width: 180, height: 180 });
  });

  it('keeps every committed icon referenced', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const referenced = new Set([
      ...manifest.icons.map((icon: { src: string }) => icon.src),
      /apple-touch-icon" href="([^"]+)"/.exec(html)![1],
    ]);
    for (const file of readdirSync(join(root, 'public/icons'))) expect(referenced).toContain(`/icons/${file}`);
  });
});

describe('service worker request classification', () => {
  it('never handles the API or the event stream, whatever the request looks like', () => {
    for (const path of ['/api/bootstrap', '/api/events', '/api', '/api/auth/status?x=1', '/events'])
      expect(classifyRequest(req(path), ORIGIN, shell)).toBe('api');
    expect(classifyRequest(req('/api/sessions', { mode: 'navigate' }), ORIGIN, shell)).toBe('api');
    expect(isApiPath('/apiary')).toBe(false);
  });

  it('passes through non-GET, other origins, credentialed and unknown requests', () => {
    expect(classifyRequest(req('/assets/main-abc.js', { method: 'POST' }), ORIGIN, shell)).toBe('other');
    expect(classifyRequest(req('/', { method: 'HEAD', mode: 'navigate' }), ORIGIN, shell)).toBe('other');
    expect(classifyRequest(req('https://example.com/assets/main-abc.js'), ORIGIN, shell)).toBe('other');
    expect(classifyRequest(req('/assets/main-abc.js', { headers: { authorization: 'Bearer x' } }), ORIGIN, shell)).toBe(
      'other',
    );
    expect(classifyRequest(req('/assets/unknown.js'), ORIGIN, shell)).toBe('other');
    expect(classifyRequest(req('/assets/main-abc.js?v=2'), ORIGIN, shell)).toBe('other');
    expect(classifyRequest({ method: 'GET', url: 'not a url' }, ORIGIN, shell)).toBe('other');
  });

  it('separates page loads from shell assets', () => {
    expect(classifyRequest(req('/', { mode: 'navigate' }), ORIGIN, shell)).toBe('navigation');
    expect(classifyRequest(req('/conversa/1', { mode: 'navigate' }), ORIGIN, shell)).toBe('navigation');
    expect(classifyRequest(req('/assets/main-abc.js', { mode: 'cors' }), ORIGIN, shell)).toBe('asset');
    expect(classifyRequest(req('/icons/icon-192.png'), ORIGIN, shell)).toBe('asset');
  });
});

describe('service worker caches', () => {
  it('versions cache names and deletes only stale caches of this app', () => {
    expect(cacheName('v2')).toBe('adelic-shell-v2');
    expect(staleCaches(['adelic-shell-v1', 'adelic-shell-v2', 'other-app', 'adelic-x'], 'v2')).toEqual([
      'adelic-shell-v1',
      'adelic-x',
    ]);
  });

  it('stores only plain public 200 responses', () => {
    const res = (status: number, headers: Record<string, string> = {}, type = 'basic') => ({
      status,
      type,
      headers: new Headers(headers),
    });
    expect(isCacheableResponse(res(200))).toBe(true);
    expect(isCacheableResponse(res(200, { 'cache-control': 'public, max-age=0' }))).toBe(true);
    expect(isCacheableResponse(res(404))).toBe(false);
    expect(isCacheableResponse(res(200, {}, 'opaque'))).toBe(false);
    expect(isCacheableResponse(res(200, { 'cache-control': 'private, max-age=3600' }))).toBe(false);
    expect(isCacheableResponse(res(200, { 'cache-control': 'no-store' }))).toBe(false);
    // Headers drops set-cookie in fetch responses, so fake a header bag that still has it.
    expect(
      isCacheableResponse({ status: 200, type: 'basic', headers: { get: (n) => (n === 'set-cookie' ? 'a=1' : null) } }),
    ).toBe(false);
  });

  it('builds the precache from the build output, without maps, the worker or the API', () => {
    expect(
      precacheEntries(['index.html', 'assets\\main-abc.js', 'assets/main-abc.js.map', 'sw.js', 'api/x', 'icons/i.png']),
    ).toEqual(['/assets/main-abc.js', '/icons/i.png', '/index.html', OFFLINE_URL]);
  });
});

/** A minimal ServiceWorkerGlobalScope: listeners, an in-memory CacheStorage and a fetch stub. */
function fakeScope(network: (request: Request) => Promise<Response>) {
  const stores = new Map<string, Map<string, Response>>();
  const listeners: Record<string, (event: never) => void> = {};
  const cache = (name: string) => {
    const entries = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, entries);
    return {
      put: async (key: string, response: Response) => void entries.set(key, response),
      match: async (key: string) => entries.get(key)?.clone(),
    };
  };
  const scope = {
    location: { origin: ORIGIN },
    caches: {
      open: async (name: string) => cache(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    } as unknown as CacheStorage,
    // Same-origin fetch responses are "basic"; a constructed Response says "default".
    fetch: vi.fn(async (input: Request | string) => {
      const response = await network(typeof input === 'string' ? new Request(ORIGIN + input) : input);
      return Object.defineProperty(response, 'type', { value: 'basic' });
    }),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
    addEventListener: (type: string, listener: (event: never) => void) => void (listeners[type] = listener),
  };
  const waitFor = async (type: 'install' | 'activate') => {
    let pending: Promise<unknown> = Promise.resolve();
    (listeners[type] as (e: ExtendableEventLike) => void)({ waitUntil: (p) => (pending = p) });
    await pending;
  };
  const dispatchFetch = (request: Request) => {
    let response: Promise<Response> | undefined;
    (listeners.fetch as (e: FetchEventLike) => void)({
      request,
      respondWith: (r) => (response = r),
      waitUntil: () => undefined,
    });
    return response;
  };
  const message = (data: unknown) => (listeners.message as (e: MessageEventLike) => void)({ data });
  return { scope, stores, waitFor, dispatchFetch, message };
}

const navigation = (path: string, method = 'GET') => {
  const request = new Request(ORIGIN + path, { method });
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
};

describe('service worker lifecycle', () => {
  const config = { version: 'v2', precache: ['/index.html', '/assets/main-abc.js', OFFLINE_URL] };

  it('precaches the shell without cookies and waits for the user before taking over', async () => {
    const fake = fakeScope(async (request) => new Response(`body of ${new URL(request.url).pathname}`));
    installWorker(fake.scope, config);
    await fake.waitFor('install');
    expect([...fake.stores.get('adelic-shell-v2')!.keys()]).toEqual(config.precache);
    for (const [request] of fake.scope.fetch.mock.calls as [Request][]) {
      expect(request.credentials).toBe('omit');
      expect(request.cache).toBe('reload');
    }
    expect(fake.scope.skipWaiting).not.toHaveBeenCalled();
    fake.message({ type: 'something-else' });
    fake.message(null);
    expect(fake.scope.skipWaiting).not.toHaveBeenCalled();
    fake.message({ type: SKIP_WAITING });
    expect(fake.scope.skipWaiting).toHaveBeenCalledOnce();
  });

  it('fails the install instead of caching an error page', async () => {
    const fake = fakeScope(async () => new Response('nope', { status: 500 }));
    installWorker(fake.scope, config);
    await expect(fake.waitFor('install')).rejects.toThrow(/500/);
  });

  it('removes old caches on activate and claims open pages', async () => {
    const fake = fakeScope(async () => new Response('x'));
    installWorker(fake.scope, config);
    await fake.scope.caches.open('adelic-shell-v1');
    await fake.scope.caches.open('someone-else');
    await fake.waitFor('install');
    await fake.waitFor('activate');
    expect([...fake.stores.keys()].sort()).toEqual(['adelic-shell-v2', 'someone-else']);
    expect(fake.scope.clients.claim).toHaveBeenCalled();
  });

  it('serves shell assets from the cache, navigations from the network, and the offline page as fallback', async () => {
    let online = true;
    const fake = fakeScope(async (request) => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response(`network ${new URL(request.url).pathname}`);
    });
    installWorker(fake.scope, config);
    await fake.waitFor('install');
    fake.scope.fetch.mockClear();
    expect(await (await fake.dispatchFetch(new Request(ORIGIN + '/assets/main-abc.js')))!.text()).toBe(
      'network /assets/main-abc.js',
    );
    expect(fake.scope.fetch).not.toHaveBeenCalled();
    expect(await (await fake.dispatchFetch(navigation('/conversa/1')))!.text()).toBe('network /conversa/1');
    // Navigations are not stored.
    expect(fake.stores.get('adelic-shell-v2')!.has('/conversa/1')).toBe(false);
    online = false;
    expect(await (await fake.dispatchFetch(navigation('/conversa/1')))!.text()).toBe('network /offline.html');
  });

  it('falls back to the network for an evicted asset and to a network error without an offline page', async () => {
    const fake = fakeScope(async () => {
      throw new TypeError('offline');
    });
    installWorker(fake.scope, { version: 'v3', precache: ['/assets/a.js'] });
    await expect(fake.dispatchFetch(new Request(ORIGIN + '/assets/a.js'))).rejects.toThrow('offline');
    const response = await fake.dispatchFetch(navigation('/'));
    expect(response!.type).toBe('error');
  });

  it('leaves API, event stream and non-GET requests to the browser', () => {
    const fake = fakeScope(async () => new Response('x'));
    installWorker(fake.scope, config);
    expect(fake.dispatchFetch(new Request(ORIGIN + '/api/bootstrap'))).toBeUndefined();
    expect(fake.dispatchFetch(navigation('/api/export'))).toBeUndefined();
    expect(fake.dispatchFetch(new Request(ORIGIN + '/api/events'))).toBeUndefined();
    expect(fake.dispatchFetch(navigation('/', 'POST'))).toBeUndefined();
    expect(fake.scope.fetch).not.toHaveBeenCalled();
  });
});

describe('service worker registration', () => {
  const base = {
    production: true,
    secureContext: true,
    hasServiceWorker: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36',
  };
  it('registers only in production, in a secure context and outside Electron', () => {
    expect(shouldRegister(base)).toBe(true);
    expect(shouldRegister({ ...base, production: false })).toBe(false);
    expect(shouldRegister({ ...base, secureContext: false })).toBe(false);
    expect(shouldRegister({ ...base, hasServiceWorker: false })).toBe(false);
    expect(
      shouldRegister({
        ...base,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Electron/44.5.1 Safari/537.36',
      }),
    ).toBe(false);
  });
});
