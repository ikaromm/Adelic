// Service worker logic (docs/specs/pwa.md). `installWorker` wires the listeners on a scope so
// the same code runs in the browser (src/pwa/sw-entry.ts, bundled to /sw.js by
// vite.config.ts) and in unit tests against a fake scope.
import { cacheName, classifyRequest, isCacheableResponse, OFFLINE_URL, staleCaches } from './sw-core';

export interface WorkerConfig {
  /** Content hash of the shell; a new value means a new worker and a new cache. */
  version: string;
  /** Absolute paths of the shell files (see precacheEntries). */
  precache: readonly string[];
}

export interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
export interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
export interface MessageEventLike {
  data: unknown;
}

/** The subset of ServiceWorkerGlobalScope the worker uses (the DOM lib has no worker types). */
export interface WorkerScope {
  location: { origin: string };
  caches: CacheStorage;
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

/** Message the page sends after the user accepts "Atualização disponível — Recarregar". */
export const SKIP_WAITING = 'adelic:skip-waiting';

export function installWorker(scope: WorkerScope, config: WorkerConfig) {
  const name = cacheName(config.version);
  const shell = new Set(config.precache);

  scope.addEventListener('install', (event) => {
    // No skipWaiting here: a new version waits until the user accepts the update toast.
    event.waitUntil(
      (async () => {
        const cache = await scope.caches.open(name);
        for (const path of shell) {
          // Fresh from the server, without cookies: the cached shell is the public one.
          const response = await scope.fetch(
            new Request(new URL(path, scope.location.origin), { cache: 'reload', credentials: 'omit' }),
          );
          if (!isCacheableResponse(response)) throw new Error(`Falha ao guardar ${path}: ${response.status}`);
          await cache.put(path, response);
        }
      })(),
    );
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const names = await scope.caches.keys();
        await Promise.all(staleCaches(names, config.version).map((stale) => scope.caches.delete(stale)));
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown } | null;
    if (data && data.type === SKIP_WAITING) void scope.skipWaiting();
  });

  scope.addEventListener('fetch', (event) => {
    const kind = classifyRequest(event.request, scope.location.origin, shell);
    // api / other: no respondWith, so the browser handles the request as if there were no worker.
    if (kind === 'asset') {
      const path = new URL(event.request.url).pathname;
      event.respondWith(
        (async () => (await (await scope.caches.open(name)).match(path)) ?? scope.fetch(event.request))(),
      );
    } else if (kind === 'navigation') {
      // Network first and never stored; the offline page only when the network fails.
      event.respondWith(
        scope.fetch(event.request).catch(async () => {
          const offline = await (await scope.caches.open(name)).match(OFFLINE_URL);
          return offline ?? Response.error();
        }),
      );
    }
  });
}
