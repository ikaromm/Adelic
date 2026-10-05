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
