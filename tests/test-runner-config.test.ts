import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('test runner scripts', () => {
  it('loads Vite config without writing to dependencies and caps concurrency', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const viteConfig = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');

    for (const script of ['test', 'coverage']) {
      expect(packageJson.scripts[script]).toContain('--configLoader runner');
    }
    expect(viteConfig).toContain('    maxWorkers: 2,');
  });
});
