// Terminal command history per project, kept in localStorage. Only the command text is
// stored (never output), at most TERMINAL_HISTORY_MAX entries, most recent last.
import { TERMINAL_COMMAND_MAX, TERMINAL_HISTORY_MAX } from '../shared/terminal';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

export const historyKey = (projectId: string) => `adelic-terminal-history:${projectId}`;

const defaultStorage = (): KeyValueStore | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function loadHistory(projectId: string, storage: KeyValueStore | null = defaultStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(historyKey(projectId)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is string => typeof item === 'string' && item.trim() !== '' && item.length <= TERMINAL_COMMAND_MAX,
      )
      .slice(-TERMINAL_HISTORY_MAX);
  } catch {
    return [];
  }
}

/** Appends `command` (moving an earlier copy to the end) and returns the new history. */
export function recordHistory(
  projectId: string,
  command: string,
  storage: KeyValueStore | null = defaultStorage(),
): string[] {
  const current = loadHistory(projectId, storage);
  const text = command.trim();
  if (!text || text.length > TERMINAL_COMMAND_MAX) return current;
  const next = [...current.filter((item) => item !== text), text].slice(-TERMINAL_HISTORY_MAX);
  try {
    storage?.setItem(historyKey(projectId), JSON.stringify(next));
  } catch {
    /* Private mode or full storage: history is a convenience only. */
  }
  return next;
}
