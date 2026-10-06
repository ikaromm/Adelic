#!/usr/bin/env node
// Prepares a release locally: bumps the version, closes the CHANGELOG section,
// creates docs/releases/vX.Y.Z.md from it, commits and tags. Pushing the tag starts
// .github/workflows/release.yml, which builds the AppImage and publishes the GitHub Release.
//
//   npm run release -- 0.4.0            # prepare commit + tag (no push)
//   npm run release -- 0.4.0 --push     # also push develop and the tag
//   npm run release -- 0.4.0 --dry-run  # show what would change
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--'));
const push = args.includes('--push');
const dryRun = args.includes('--dry-run');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail('informe a versão no formato X.Y.Z');
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cmp = (a, b) =>
  a
    .split('.')
    .map(Number)
    .reduce((r, n, i) => r || n - Number(b.split('.')[i]), 0);
if (cmp(version, pkg.version) <= 0) fail(`a versão ${version} precisa ser maior que a atual (${pkg.version})`);
if (git('status', '--porcelain')) fail('há alterações não commitadas; commite ou descarte antes');
if (git('tag', '--list', `v${version}`)) fail(`a tag v${version} já existe`);

const changelogPath = join(root, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8').replace(
  '## Não publicado\n\n_Nada ainda._\n\n',
  '## Não publicado\n\n',
);
const unreleased = changelog.match(/## Não publicado\n\n([\s\S]*?)(?=\n## )/);
if (!unreleased || !unreleased[1].trim()) fail('o CHANGELOG não tem itens em "## Não publicado"');
const today = new Date().toISOString().slice(0, 10);
const notes = unreleased[1].trim();
// The empty "Não publicado" heading stays on top for the next entries.
const nextChangelog = changelog.replace(
  '## Não publicado\n\n',
  `## Não publicado\n\n_Nada ainda._\n\n## ${version} — ${today}\n\n`,
);
const releaseDoc = join(root, 'docs/releases', `v${version}.md`);
if (existsSync(releaseDoc)) fail(`${releaseDoc} já existe`);
const doc = `# Adelic v${version}

${today} — Linux x86_64, aplicativo local em 127.0.0.1.

${notes}

Instale o AppImage junto com o arquivo \`.sha256\` e, opcionalmente, \`install-linux.sh\`. A atualização preserva o histórico em \`~/.local/share/adelic/adelic.sqlite\`; se o esquema mudar, uma cópia da base é gravada antes em \`~/.local/share/adelic/backups/\`. [Instruções Linux](../desktop-linux.md).

O SHA-256 do AppImage é publicado junto com a release.
`;

console.log(`release: ${pkg.version} → ${version}`);
console.log(
  `  CHANGELOG: "${version} — ${today}" com ${notes.split('\n').filter((l) => l.startsWith('- ')).length} itens`,
);
console.log(`  notas: docs/releases/v${version}.md`);
if (dryRun) process.exit(0);

execFileSync('npm', ['version', version, '--no-git-tag-version'], { cwd: root, stdio: 'ignore' });
writeFileSync(changelogPath, nextChangelog);
writeFileSync(releaseDoc, doc);
git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md', releaseDoc);
git('commit', '-m', `release: v${version}`);
git('tag', '-a', `v${version}`, '-m', `Adelic v${version}`);
console.log(`release: commit e tag v${version} criados`);
if (push) {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('push', 'origin', branch);
  git('push', 'origin', `v${version}`);
  console.log(`release: enviado; o workflow "Release" vai gerar e publicar o AppImage`);
} else console.log(`release: para publicar, rode git push origin HEAD && git push origin v${version}`);
