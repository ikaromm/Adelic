import { build, Platform, Arch } from 'electron-builder';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Este build foi definido para Linux x86_64; outras arquiteturas ainda não foram validadas.');
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const artifacts = await build({
  targets: Platform.LINUX.createTarget(['AppImage'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.adelic.desktop', productName: 'Adelic',
    electronVersion: pkg.devDependencies.electron,
    directories: { app: join(root, '.desktop/app'), output: join(root, 'release'), buildResources: join(root, 'desktop/assets') },
    files: ['main.cjs', 'backend.cjs', '*.LEGAL.txt', 'icon.png', 'package.json', 'web/**/*', '!node_modules/**/*'], asar: true, npmRebuild: false,
    artifactName: '${productName}-${version}-linux-${arch}.${ext}',
    linux: { executableName: 'adelic', category: 'Development', syncDesktopName: true, icon: join(root, 'desktop/assets/icon.png'), desktop: { entry: { Name: 'Adelic', Comment: pkg.description, StartupWMClass: 'io.adelic.desktop' } } },
    toolsets: { appimage: '1.0.3' },
  },
});
for (const artifact of artifacts.filter(path => path.endsWith('.AppImage'))) {
  const hash = createHash('sha256').update(await readFile(artifact)).digest('hex');
  await writeFile(`${artifact}.sha256`, `${hash}  ${basename(artifact)}\n`);
  console.log(`Pacote: ${artifact}\nSHA-256: ${hash}`);
}
