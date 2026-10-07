import express, { type NextFunction, type Request, type Response } from 'express';
import { join, resolve } from 'node:path';

/**
 * Headers for the installable-app files (docs/specs/pwa.md). The worker and the manifest
 * must be revalidated on every load so a new version is noticed; the worker may control
 * the whole origin. Everything here is the public UI shell: the access guard (auth.ts)
 * runs before it and keeps /api behind the token.
 */
export function shellHeaders(res: Response, path: string) {
  const name = path.replace(/\\/g, '/').split('/').at(-1);
  if (name === 'sw.js') {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
  } else if (name === 'manifest.webmanifest') {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
  } else if (name?.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
}

/** Serves the built UI (static files, then index.html for client-side routes). */
export function webAssets(webDir: string) {
  const root = resolve(webDir);
  const files = express.static(root, { fallthrough: true, setHeaders: shellHeaders });
  return [
    files,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(root, 'index.html'), (error) => {
        if (error) next(error);
      });
    },
  ];
}
