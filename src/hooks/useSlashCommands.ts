import { useCallback, useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { CommandEntry } from '../../shared/commands';
import { api } from '../api';

const MAX_SUGGESTIONS = 8;

/** The name prefix being typed while the message is only `/prefix` (no space yet); else undefined. */
export function slashQuery(value: string): string | undefined {
  const match = /^\/([a-z0-9-]{0,32})$/i.exec(value);
  return match ? match[1].toLowerCase() : undefined;
}

/** Winning commands whose name starts with `query`, then those whose description mentions it. */
export function filterCommands(commands: CommandEntry[], query: string, limit = MAX_SUGGESTIONS) {
  const active = commands.filter((c) => c.active);
  const byName = active.filter((c) => c.name.startsWith(query));
  const folded = (text: string) =>
    text
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const byDescription = query
    ? active.filter((c) => !c.name.startsWith(query) && folded(c.description).includes(folded(query)))
    : [];
  return [...byName, ...byDescription].slice(0, limit);
}

export type SlashKeyAction = 'next' | 'previous' | 'complete' | 'close' | null;
/** What a key does while the command list is open; null lets the composer handle it. */
export function slashKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'> & { isComposing?: boolean },
  open: boolean,
): SlashKeyAction {
  if (!open || event.isComposing || event.altKey) return null;
  if (event.key === 'ArrowDown') return 'next';
  if (event.key === 'ArrowUp') return 'previous';
  if (event.key === 'Escape') return 'close';
  if (event.key === 'Tab' && !event.shiftKey) return 'complete';
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) return 'complete';
  return null;
}

/**
 * Suggestions for saved commands in the composer (docs/specs/saved-commands.md). Typing `/`
 * at the start of the message opens a listbox; arrows move, Enter or Tab completes
 * `/name `, Escape closes until the text changes. Expansion happens on the server.
 */
export function useSlashCommands(projectId: string | null | undefined, value: string, setValue: (v: string) => void) {
  const [loaded, setLoaded] = useState<{ key: string; commands: CommandEntry[] }>({ key: '', commands: [] });
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listboxId = useId();
  const query = slashQuery(value);
  const typing = query !== undefined;
  const key = projectId ?? '';

  // Fetched each time the list opens (cheap, local), so commands saved in Settings show up.
  useEffect(() => {
    if (!typing) return;
    let current = true;
    api
      .commands(projectId)
      .then((list) => current && setLoaded({ key, commands: list.commands }))
      .catch(() => {
        /* No suggestions: `/name` is still sent and expanded by the server. */
      });
    return () => {
      current = false;
    };
  }, [typing, key, projectId]);
  const items = useMemo(
    () => (query === undefined || loaded.key !== key ? [] : filterCommands(loaded.commands, query)),
    [loaded, key, query],
  );
  const open = query !== undefined && dismissed !== value && items.length > 0;
  const index = Math.min(activeIndex, Math.max(0, items.length - 1));
  useEffect(() => setActiveIndex(0), [query]);

  const select = useCallback(
    (command: CommandEntry) => {
      setValue(`/${command.name} `);
      setDismissed(null);
    },
    [setValue],
  );
  /** Handles the key when the list is open; returns true when the composer must ignore it. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = slashKeyAction({ ...event, isComposing: event.nativeEvent.isComposing }, open);
    if (!action) return false;
    event.preventDefault();
    if (action === 'next') setActiveIndex((index + 1) % items.length);
    else if (action === 'previous') setActiveIndex((index - 1 + items.length) % items.length);
    else if (action === 'close') {
      // Keep Escape from also closing other overlays.
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      setDismissed(value);
    } else select(items[index]);
    return true;
  };
  const optionId = (i: number) => `${listboxId}-option-${i}`;
  return {
    open,
    items,
    activeIndex: index,
    listboxId,
    optionId,
    select,
    onKeyDown,
    setActiveIndex,
    /** ARIA for the composer: an autocomplete textbox controlling the listbox. */
    inputProps: {
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? listboxId : undefined,
      'aria-activedescendant': open ? optionId(index) : undefined,
    },
  };
}
