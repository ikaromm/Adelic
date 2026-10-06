import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };

// Checks GitHub for a newer Adelic release. Opt-in (Settings): it sends one anonymous GET
// to api.github.com and nothing else. It never downloads or installs; the UI links to the
// release page, where the AppImage is verified with its SHA-256 as usual.

export const RELEASES_URL = 'https://api.github.com/repos/ikaromm/Adelic/releases/latest';
/** Tests may point the check at a local server; anything that is not loopback is ignored. */
function releasesUrl() {
  const override = process.env.ADELIC_RELEASES_URL;
  if (!override) return RELEASES_URL;
  try {
    const url = new URL(override);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? url.href : RELEASES_URL;
  } catch {
    return RELEASES_URL;
  }
}
const ReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().url(),
  name: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  url?: string;
  publishedAt?: string;
  checkedAt: string;
  error?: string;
}

const parse = (version: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : undefined;
};
/** True when `latest` is a strictly newer X.Y.Z than `current`; malformed versions never are. */
export function isNewer(latest: string, current: string) {
  const a = parse(latest),
    b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

let cache: { at: number; value: UpdateStatus } | undefined;
const TTL = 6 * 60 * 60_000;

export async function checkForUpdate(options: { force?: boolean; fetcher?: typeof fetch } = {}): Promise<UpdateStatus> {
  if (!options.force && cache && Date.now() - cache.at < TTL) return cache.value;
  const current = pkg.version;
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let value: UpdateStatus;
  try {
    const response = await (options.fetcher ?? fetch)(releasesUrl(), {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `adelic/${current}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub respondeu HTTP ${response.status}`);
    const release = ReleaseSchema.parse(await response.json());
    const usable = !release.draft && !release.prerelease;
    value = {
      current,
      latest: release.tag_name.replace(/^v/, ''),
      available: usable && isNewer(release.tag_name, current),
      url: release.html_url,
      publishedAt: release.published_at ?? undefined,
      checkedAt,
    };
  } catch (e) {
    const reason = controller.signal.aborted ? 'sem resposta em 5 s' : e instanceof Error ? e.message : String(e);
    value = { current, available: false, checkedAt, error: `Não foi possível verificar atualizações: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
  // Failures are cached briefly, successes for TTL.
  cache = { at: value.error ? Date.now() - TTL + 10 * 60_000 : Date.now(), value };
  return value;
}

export function resetUpdateCache() {
  cache = undefined;
}
