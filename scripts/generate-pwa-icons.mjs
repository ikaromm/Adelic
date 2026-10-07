// Regenerates the PWA icons in public/icons/ from the brand mark (public/favicon.svg, the
// thicker-stroke variant that reads well at small sizes). Needs `rsvg-convert` (librsvg);
// the PNGs are committed, so this only runs when the mark changes:
//   node scripts/generate-pwa-icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'public/icons');
mkdirSync(out, { recursive: true });
const source = readFileSync(join(root, 'public/favicon.svg'), 'utf8').replace(/<!--[\s\S]*?-->\s*/, '');
const background = /<rect [^>]*fill="([^"]+)"[^>]*\/>/.exec(source)?.[1];
if (!background) throw new Error('favicon.svg mudou: fundo não encontrado');
const mark = source
  .replace(/<rect [^>]*\/>/, '')
  .match(/<(line|circle) [^>]*\/>/g)
  .join('');

// "any": the mark as drawn, rounded square included.
const rounded = source;
// Full-bleed square (launchers and iOS apply their own mask). The mark is scaled down so it
// stays inside the maskable safe zone, a circle of 40% of the icon size around the centre.
const square = (scale) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
  `<rect width="512" height="512" fill="${background}"/>` +
  `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${mark}</g></svg>`;

const icons = [
  ['icon-192.png', 192, rounded],
  ['icon-512.png', 512, rounded],
  ['icon-maskable-512.png', 512, square(0.8)],
  ['apple-touch-icon.png', 180, square(0.88)],
];
for (const [name, size, svg] of icons) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', join(out, name)], { input: svg });
  console.log(`public/icons/${name} (${size}×${size})`);
}
