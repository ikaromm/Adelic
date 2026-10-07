import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { validatePreviewUrl } from '../shared/terminal.js';

export type NavigationPolicy = 'internal' | 'external' | 'blocked';

export function resolveDesktopDataDir(override?: string, home = homedir()) {
  return resolve(override || join(home, '.local', 'share', 'adelic'));
}

export function desktopResources(appPath: string) {
  const root = resolve(appPath);
  return {
    root,
    backend: join(root, 'backend.cjs'),
    web: join(root, 'web'),
    icon: join(root, 'icon.png'),
  };
}

export function navigationPolicy(target: string, appUrl: string): NavigationPolicy {
  let targetUrl: URL;
  let appOrigin: string;
  try {
    targetUrl = new URL(target);
    appOrigin = new URL(appUrl).origin;
  } catch {
    return 'blocked';
  }

  if (targetUrl.origin === appOrigin) return 'internal';
  if (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:') return 'external';
  return 'blocked';
}

/**
 * Sub-frame navigations: the app's own pages, or the local preview (docs/specs/terminal-preview.md),
 * which accepts only loopback http(s) dev servers other than the Adelic itself. Anything else
 * inside a frame is blocked; top-level windows keep `navigationPolicy`.
 */
export function subframeNavigationAllowed(target: string, appUrl: string): boolean {
  if (navigationPolicy(target, appUrl) === 'internal') return true;
  return Boolean(appUrl) && validatePreviewUrl(target, appUrl).ok;
}

/**
 * Web permissions granted to the window: only system notifications, and only to the app's own
 * origin. Everything else (camera, clipboard, geolocation…) stays denied.
 */
export function permissionPolicy(permission: string, requestingUrl: string, appUrl: string): boolean {
  if (permission !== 'notifications' || !appUrl) return false;
  return navigationPolicy(requestingUrl, appUrl) === 'internal';
}
