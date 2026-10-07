// Pure service worker rules (docs/specs/pwa.md). Shared by the worker (src/pwa/sw.ts), the
// build step that lists the precache (vite.config.ts) and the unit tests, so the caching
// policy is decided in one place and tested without a browser.

/** Every cache this app creates starts with this prefix; anything else is left alone. */
export const CACHE_PREFIX = 'adelic-';
export const OFFLINE_URL = '/offline.html';

export type RequestKind = 'api' | 'navigation' | 'asset' | 'other';

export interface RequestLike {
  method: string;
  url: string;
  mode?: string;
  headers?: { has(name: string): boolean };
}

/** True for the API, including the event stream: never answered or stored by the worker. */
export function isApiPath(pathname: string) {
  return (
    pathname === '/api' || pathname.startsWith('/api/') || pathname === '/events' || pathname.startsWith('/events/')
  );
}

/**
 * Decides what the worker does with a request:
 * - api: the API and event stream; passed through untouched.
 * - navigation: page loads; network first, offline page when the network fails.
 * - asset: a file of the precached shell; served from the cache.
 * - other: everything else (non-GET, other origins, credentialed requests, unknown files);
 *   passed through untouched.
 */
export function classifyRequest(request: RequestLike, origin: string, precache: ReadonlySet<string>): RequestKind {
  if (request.method !== 'GET') return 'other';
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'other';
  }
  if (url.origin !== origin) return 'other';
  if (isApiPath(url.pathname)) return 'api';
  if (request.headers?.has('authorization')) return 'other';
  if (request.mode === 'navigate') return 'navigation';
  if (!url.search && precache.has(url.pathname)) return 'asset';
  return 'other';
}

export const cacheName = (version: string) => `${CACHE_PREFIX}shell-${version}`;

/** Caches from earlier versions of this app, deleted when a new worker activates. */
export const staleCaches = (names: readonly string[], version: string) =>
  names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== cacheName(version));

export interface ResponseLike {
  status: number;
  type: string;
  headers: { get(name: string): string | null };
}

/** Only plain, public, same-origin 200 responses may enter the cache. */
export function isCacheableResponse(response: ResponseLike) {
  if (response.status !== 200 || response.type !== 'basic') return false;
  if (response.headers.get('set-cookie')) return false;
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
  return !/\b(no-store|private)\b/.test(cacheControl);
}

/**
 * Turns the build output into the precache list: index.html, hashed assets and the public
 * shell files (offline page, manifest, icons). Source maps, the worker itself and anything
 * under /api are never listed.
 */
export function precacheEntries(fileNames: readonly string[]) {
  const urls = new Set<string>();
  for (const name of fileNames) {
    const path = '/' + name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (path.endsWith('.map') || path === '/sw.js' || isApiPath(path)) continue;
    urls.add(path);
  }
  urls.add(OFFLINE_URL);
  return [...urls].sort();
}
