import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'linux') throw new Error('O pacote desktop atual é somente para Linux.');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = join(root, '.desktop/app');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const options = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  sourcemap: false, legalComments: 'external', logLevel: 'info',
};
await build({ ...options, entryPoints: [join(root, 'desktop/main.ts')], outfile: join(stage, 'main.cjs'), external: ['electron'] });
await build({ ...options, entryPoints: [join(root, 'server/desktop-entry.ts')], outfile: join(stage, 'backend.cjs'), external: ['vite'] });
await cp(join(root, 'dist'), join(stage, 'web'), { recursive: true });
await cp(join(root, 'desktop/assets/icon.png'), join(stage, 'icon.png'));
await writeFile(join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, description: pkg.description,
  author: pkg.author, private: true, main: 'main.cjs', desktopName: 'io.adelic.desktop',
}, null, 2) + '\n');
console.log(`Desktop preparado em ${stage}`);
