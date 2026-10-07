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

/** Media details Electron passes with a `media` permission request (`mediaTypes`) or check (`mediaType`). */
export interface MediaPermissionDetails {
  mediaTypes?: readonly string[];
  mediaType?: string;
}

/** True only for a request or check that asks for the microphone and nothing else. */
function audioOnly(media: MediaPermissionDetails | undefined) {
  if (!media) return false;
  if (media.mediaTypes !== undefined)
    return media.mediaTypes.length > 0 && media.mediaTypes.every((type) => type === 'audio');
  return media.mediaType === 'audio';
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
 * Web permissions granted to the window, only to the app's own origin: system notifications,
 * and the microphone for local voice dictation (`media` with audio only, docs/specs/voice.md).
 * Everything else (camera, screen capture, clipboard, geolocation…) stays denied.
 */
export function permissionPolicy(
  permission: string,
  requestingUrl: string,
  appUrl: string,
  media?: MediaPermissionDetails,
): boolean {
  if (!appUrl || navigationPolicy(requestingUrl, appUrl) !== 'internal') return false;
  if (permission === 'notifications') return true;
  if (permission === 'media') return audioOnly(media);
  return false;
}
