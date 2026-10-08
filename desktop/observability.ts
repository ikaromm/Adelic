import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ObservationInput } from '../shared/observability.js';

export type DesktopObservationName = 'desktop.ready' | 'desktop.window.ready' | 'desktop.backend.exit';
/** Persist main-process failures even when the backend is unavailable. No text or arbitrary attributes. */
export function desktopObservation(
  dataDir: string,
  name: DesktopObservationName,
  status: 'success' | 'error',
  durationMs?: number,
): ObservationInput {
  const event: ObservationInput = {
    id: randomUUID(),
    at: new Date().toISOString(),
    name,
    component: 'desktop',
    status,
    ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
  };
  try {
    const dir = join(dataDir, 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'desktop.trace.ndjson');
    if (existsSync(file) && statSync(file).size > 1024 * 1024) {
      for (let i = 2; i >= 0; i--) {
        const source = i ? `${file}.${i}` : file;
        if (existsSync(source)) renameSync(source, `${file}.${i + 1}`);
      }
    }
    appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch {
    /* Logging cannot stop desktop startup or shutdown. */
  }
  return event;
}
export function recentDesktopObservations(dataDir: string): ObservationInput[] {
  try {
    const file = join(dataDir, 'logs', 'desktop.trace.ndjson');
    if (statSync(file).size > 2 * 1024 * 1024) return [];
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .slice(-20)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as ObservationInput;
          if (
            !['desktop.ready', 'desktop.window.ready', 'desktop.backend.exit'].includes(value.name) ||
            !['success', 'error'].includes(value.status ?? '') ||
            typeof value.id !== 'string' ||
            typeof value.at !== 'string'
          )
            return [];
          return [
            {
              id: value.id,
              at: value.at,
              name: value.name,
              component: 'desktop',
              status: value.status,
              ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
                ? { durationMs: Math.max(0, value.durationMs) }
                : {}),
            },
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
