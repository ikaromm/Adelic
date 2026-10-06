import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASES_URL, checkForUpdate, isNewer, resetUpdateCache } from '../server/updates.js';
import pkg from '../package.json' with { type: 'json' };

const reply = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
beforeEach(() => resetUpdateCache());

describe('update check', () => {
  it('compares X.Y.Z versions numerically and rejects malformed ones', () => {
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.4.1', '0.4.0')).toBe(true);
    expect(isNewer('0.4.0', '0.4.0')).toBe(false);
    expect(isNewer('0.3.9', '0.4.0')).toBe(false);
    for (const bad of ['latest', '1.0', 'v1.0.0-beta', '']) expect(isNewer(bad, '0.1.0')).toBe(false);
  });
  it('reports a newer release with its page, sending one anonymous GET to GitHub', async () => {
    const fetcher = reply({
      tag_name: 'v99.0.0',
      html_url: 'https://github.com/ikaromm/Adelic/releases/tag/v99.0.0',
      published_at: '2027-01-01T00:00:00Z',
    });
    const status = await checkForUpdate({ fetcher });
    expect(status).toMatchObject({
      current: pkg.version,
      latest: '99.0.0',
      available: true,
      url: expect.stringContaining('/v99.0.0'),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RELEASES_URL);
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['accept', 'user-agent']);
    await checkForUpdate({ fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('ignores drafts, prereleases and the same version', async () => {
    for (const body of [
      { tag_name: 'v99.0.0', html_url: 'https://x.y/z', prerelease: true },
      { tag_name: 'v99.0.0', html_url: 'https://x.y/z', draft: true },
      { tag_name: `v${pkg.version}`, html_url: 'https://x.y/z' },
    ]) {
      resetUpdateCache();
      expect((await checkForUpdate({ fetcher: reply(body) })).available).toBe(false);
    }
  });
  it('fails softly with a message on HTTP errors, bad payloads and network errors', async () => {
    expect((await checkForUpdate({ fetcher: reply({}, 403) })).error).toMatch(/HTTP 403/);
    resetUpdateCache();
    expect((await checkForUpdate({ fetcher: reply({ tag_name: 1 }) })).error).toMatch(/verificar atualizações/);
    resetUpdateCache();
    const status = await checkForUpdate({ fetcher: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) });
    expect(status).toMatchObject({ available: false, error: expect.stringMatching(/fetch failed/) });
  });
});

describe('releases URL override', () => {
  it('only honours loopback overrides', async () => {
    const fetcher = reply({ tag_name: 'v0.0.1', html_url: 'https://x.y/z' });
    for (const [override, expected] of [
      ['http://127.0.0.1:9/latest', 'http://127.0.0.1:9/latest'],
      ['https://evil.example/latest', RELEASES_URL],
      ['not a url', RELEASES_URL],
    ]) {
      resetUpdateCache();
      process.env.ADELIC_RELEASES_URL = override;
      await checkForUpdate({ fetcher });
      expect((fetcher.mock.calls.at(-1) as unknown as [string])[0]).toBe(expected);
    }
    delete process.env.ADELIC_RELEASES_URL;
  });
});
