import { describe, expect, it } from 'vitest';
import { desktopResources, navigationPolicy, permissionPolicy, resolveDesktopDataDir } from '../desktop/policy.js';

describe('desktop resource and navigation policy', () => {
  it('uses absolute packaged resource paths regardless of the launch directory', () => {
    expect(desktopResources('/opt/adelic/.desktop/app')).toEqual({
      root: '/opt/adelic/.desktop/app',
      backend: '/opt/adelic/.desktop/app/backend.cjs',
      web: '/opt/adelic/.desktop/app/web',
      icon: '/opt/adelic/.desktop/app/icon.png',
    });
  });

  it('uses an absolute per-user data directory or the current default location', () => {
    expect(resolveDesktopDataDir('/tmp/adelic-data', '/home/example')).toBe('/tmp/adelic-data');
    expect(resolveDesktopDataDir(undefined, '/home/example')).toBe('/home/example/.local/share/adelic');
  });

  it('allows only the app origin inside the window', () => {
    expect(navigationPolicy('http://127.0.0.1:4317/chat', 'http://127.0.0.1:4317')).toBe('internal');
    expect(navigationPolicy('http://127.0.0.1:4318/', 'http://127.0.0.1:4317')).toBe('external');
  });

  it('classifies external web links for the system browser and blocks other schemes', () => {
    expect(navigationPolicy('https://example.com/docs', 'http://127.0.0.1:4317')).toBe('external');
    expect(navigationPolicy('file:///etc/passwd', 'http://127.0.0.1:4317')).toBe('blocked');
    expect(navigationPolicy('javascript:alert(1)', 'http://127.0.0.1:4317')).toBe('blocked');
    expect(navigationPolicy('not a URL', 'http://127.0.0.1:4317')).toBe('blocked');
  });

  it('grants only notifications, and only to the app origin', () => {
    const app = 'http://127.0.0.1:4317';
    expect(permissionPolicy('notifications', 'http://127.0.0.1:4317/', app)).toBe(true);
    expect(permissionPolicy('notifications', 'http://127.0.0.1:4317', app)).toBe(true);
    expect(permissionPolicy('notifications', 'https://example.com/', app)).toBe(false);
    expect(permissionPolicy('notifications', 'http://127.0.0.1:4318/', app)).toBe(false);
    expect(permissionPolicy('media', 'http://127.0.0.1:4317/', app)).toBe(false);
    expect(permissionPolicy('clipboard-read', 'http://127.0.0.1:4317/', app)).toBe(false);
    expect(permissionPolicy('notifications', 'http://127.0.0.1:4317/', '')).toBe(false);
  });
});
