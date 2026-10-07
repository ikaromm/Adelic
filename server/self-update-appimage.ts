// AppImage half of "Atualizar Adelic" (docs/specs/self-update.md). Downloads the release
// asset next to $APPIMAGE, checks it against the release's .sha256 and the ELF magic, then
// renames it over the running file, keeping the old one as `<name>.previous`.
//
// What this proves: the file is the one the release lists, intact. It does not prove the
// release itself is genuine (the checksum comes from the same release); the build
// attestation (`gh attestation verify`) is not checked here.
import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, link, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { UpdateStepId } from '../shared/contracts.js';
import { isNewer, latestRelease } from './updates.js';
import pkg from '../package.json' with { type: 'json' };

export const MAX_APPIMAGE_BYTES = 500 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4096;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/** Where downloads may come from. Production is fixed; tests pass a local one. */
export interface DownloadPolicy {
  /** The asset and checksum URLs must start with this. */
  prefix: string;
  /** Hosts a redirect may lead to (always https, unless `allowHttp`). */
  redirectHosts: string[];
  allowHttp?: boolean;
}
export const GITHUB_POLICY: DownloadPolicy = {
  prefix: 'https://github.com/ikaromm/Adelic/releases/download/',
  redirectHosts: ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
};

export interface AppImageOptions {
  /** The running AppImage (default $APPIMAGE). */
  path?: string;
  fetcher?: typeof fetch;
  /** Tests only: a local release server. */
  policy?: DownloadPolicy;
  maxBytes?: number;
  /** Current version (default package.json). */
  current?: string;
}

export interface AppImageRelease {
  latest: string;
  url: string;
  available: boolean;
  path: string;
  writable: boolean;
  asset: { name: string; url: string; size?: number };
  checksum: { url: string };
}

export const assetName = (version: string) => `Adelic-${version}-linux-x86_64.AppImage`;

async function writable(path: string) {
  try {
    await access(dirname(path), constants.W_OK);
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The latest release and whether this AppImage can be replaced by it. */
export async function appImageCheck(options: AppImageOptions = {}): Promise<AppImageRelease> {
  const path = options.path ?? process.env.APPIMAGE;
  if (!path) throw new Error('APPIMAGE não definido');
  const current = options.current ?? pkg.version;
  const release = await latestRelease(options.fetcher);
  const latest = release.tag_name.replace(/^v/, '');
  const name = assetName(latest);
  const asset = release.assets?.find((a) => a.name === name);
  const checksum = release.assets?.find((a) => a.name === `${name}.sha256`);
  const usable = !release.draft && !release.prerelease && isNewer(release.tag_name, current);
  if (usable && (!asset || !checksum)) throw new Error(`a release ${latest} não tem ${name} e ${name}.sha256`);
  return {
    latest,
    url: release.html_url,
    available: usable,
    path,
    writable: await writable(path),
    asset: { name, url: asset?.browser_download_url ?? '', size: asset?.size },
    checksum: { url: checksum?.browser_download_url ?? '' },
  };
}

function allowed(url: URL, policy: DownloadPolicy, first: boolean) {
  if (url.username || url.password) return false;
  if (first) return url.href.startsWith(policy.prefix);
  const protocols = policy.allowHttp ? ['https:', 'http:'] : ['https:'];
  return protocols.includes(url.protocol) && policy.redirectHosts.includes(url.host);
}

/** GET following at most 5 redirects, each one checked against the policy. */
async function download(href: string, options: AppImageOptions, signal: AbortSignal): Promise<Response> {
  const policy = options.policy ?? GITHUB_POLICY;
  const fetcher = options.fetcher ?? fetch;
  let url = new URL(href);
  if (!allowed(url, policy, true)) throw new Error(`endereço de download não permitido: ${url.origin}`);
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetcher(url.href, {
      redirect: 'manual',
      signal,
      headers: { accept: 'application/octet-stream', 'user-agent': `adelic/${pkg.version}` },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`redirecionamento sem destino (HTTP ${response.status})`);
      url = new URL(location, url);
      if (!allowed(url, policy, false)) throw new Error(`redirecionamento para um endereço não permitido: ${url.host}`);
      continue;
    }
    if (!response.ok) throw new Error(`download respondeu HTTP ${response.status}`);
    return response;
  }
  throw new Error('redirecionamentos demais');
}

async function readSmall(response: Response, limit: number) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('arquivo de checksum grande demais');
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('arquivo de checksum grande demais');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `<64 hex>  <name>` as written by scripts/package-linux.mjs and sha256sum. */
export function parseChecksum(text: string, name: string) {
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match && basename(match[2]) === name) return match[1].toLowerCase();
  }
  throw new Error(`o checksum não lista ${name}`);
}

export interface StepRunner {
  step<T>(id: UpdateStepId, work: () => Promise<T>): Promise<T>;
  log(text: string): void;
}

/** Download, verify and swap. The running AppImage stays untouched until the final rename. */
export async function applyAppImage(release: AppImageRelease, options: AppImageOptions = {}, runner: StepRunner) {
  const maxBytes = options.maxBytes ?? MAX_APPIMAGE_BYTES;
  const target = release.path;
  const temp = join(dirname(target), `.${basename(target)}.update-${randomBytes(6).toString('hex')}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const { digest, expected } = await runner.step('download', async () => {
      const sums = await download(release.checksum.url, options, controller.signal);
      const expected = parseChecksum(await readSmall(sums, MAX_CHECKSUM_BYTES), release.asset.name);
      const response = await download(release.asset.url, options, controller.signal);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes || (release.asset.size ?? 0) > maxBytes)
        throw new Error(`o AppImage passa do limite de ${Math.round(maxBytes / 1024 / 1024)} MB`);
      runner.log(`Baixando ${release.asset.name}${declared ? ` (${Math.round(declared / 1024 / 1024)} MB)` : ''}…\n`);
      const hash = createHash('sha256');
      const out = createWriteStream(temp, { flags: 'wx', mode: 0o600 });
      const opened = new Promise<void>((done, fail) => out.once('open', () => done()).once('error', fail));
      await opened;
      let size = 0;
      try {
        const reader = response.body!.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`o AppImage passa do limite de ${Math.round(maxBytes / 1024 / 1024)} MB`);
          }
          hash.update(value);
          if (!out.write(value)) await new Promise<void>((done) => out.once('drain', () => done()));
        }
      } finally {
        await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
      }
      runner.log(`${size} bytes recebidos\n`);
      return { digest: hash.digest('hex'), expected };
    });
    await runner.step('verify', async () => {
      if (digest !== expected) throw new Error('o SHA-256 do download não confere com o da release');
      const file = await open(temp, 'r');
      try {
        const magic = Buffer.alloc(4);
        await file.read(magic, 0, 4, 0);
        if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
          throw new Error('o arquivo baixado não é um executável ELF');
      } finally {
        await file.close();
      }
      runner.log(`SHA-256 confere: ${digest}\n`);
    });
    await runner.step('replace', async () => {
      await chmod(temp, 0o755);
      const previous = `${target}.previous`;
      await rm(previous, { force: true });
      // A hard link keeps the old file while the rename swaps the new one in atomically.
      await link(target, previous).catch(() => copyFile(target, previous));
      await rename(temp, target);
      runner.log(`${basename(target)} substituído; a versão anterior ficou em ${basename(previous)}\n`);
    });
  } finally {
    clearTimeout(timer);
    await rm(temp, { force: true }).catch(() => undefined);
  }
}
