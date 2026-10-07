// Recent command-palette selections, kept in localStorage. Only action ids are stored
// (e.g. "conversation:<id>", "mode:fast"): never titles, message text or command bodies.

export const RECENTS_KEY = 'adelic-palette-recent';
export const RECENTS_MAX = 20;
/** Shape of a palette action id: a lowercase kind, a colon and a short opaque reference. */
const ACTION_ID = /^[a-z]+:[\w:.@/-]{1,160}$/;

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/** The browser's localStorage; null outside a browser or when access is blocked. */
const defaultStorage = (): KeyValueStore | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Most recent first; anything malformed in storage is dropped. */
export function loadRecents(storage: KeyValueStore | null = defaultStorage()): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((id): id is string => typeof id === 'string' && ACTION_ID.test(id));
    return [...new Set(ids)].slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

/** Moves `id` to the front, keeps at most RECENTS_MAX ids and returns the new list. */
export function recordRecent(id: string, storage: KeyValueStore | null = defaultStorage()): string[] {
  const current = loadRecents(storage);
  if (!ACTION_ID.test(id)) return current;
  const next = [id, ...current.filter((item) => item !== id)].slice(0, RECENTS_MAX);
  try {
    storage?.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* Private mode or full storage: recents are a convenience only. */
  }
  return next;
}
