import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
 * Web permissions granted to the window: only system notifications, and only to the app's own
 * origin. Everything else (camera, clipboard, geolocation…) stays denied.
 */
export function permissionPolicy(permission: string, requestingUrl: string, appUrl: string): boolean {
  if (permission !== 'notifications' || !appUrl) return false;
  return navigationPolicy(requestingUrl, appUrl) === 'internal';
}
