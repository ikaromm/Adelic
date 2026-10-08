import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopObservation, recentDesktopObservations } from '../desktop/observability';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-desktop-observability-'));
  dirs.push(dir);
  return dir;
}
describe('desktop telemetry survives unavailable backend', () => {
  it('records exit failure locally and replays only allowed metadata', () => {
    const dir = fixture();
    const event = desktopObservation(dir, 'desktop.backend.exit', 'error');
    const file = join(dir, 'logs', 'desktop.trace.ndjson');
    const injected = { ...event, prompt: 'secret', attributes: { token: 'secret' } };
    writeFileSync(
      file,
      JSON.stringify(injected) + '\n' + JSON.stringify({ name: 'arbitrary.secret', status: 'error' }) + '\n',
    );
    expect(recentDesktopObservations(dir)).toEqual([event]);
    expect(JSON.stringify(recentDesktopObservations(dir))).not.toContain('secret');
  });
  it('bounds replay and rotates oversized logs without deleting unrelated data', () => {
    const dir = fixture();
    for (let i = 0; i < 25; i++) desktopObservation(dir, 'desktop.ready', 'success');
    expect(recentDesktopObservations(dir)).toHaveLength(20);
    const file = join(dir, 'logs', 'desktop.trace.ndjson');
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    const event = desktopObservation(dir, 'desktop.window.ready', 'success', 12);
    expect(existsSync(file + '.1')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(event);
    expect(recentDesktopObservations(dir)).toEqual([event]);
  });
});
