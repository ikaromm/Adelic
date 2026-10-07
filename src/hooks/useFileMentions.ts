import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { activeMention, formatMention } from '../../shared/mentions';
import { api } from '../api';
import { slashKeyAction } from './useSlashCommands';

const FETCH_DELAY_MS = 120;
const FETCH_LIMIT = 50;

/**
 * Replaces the mention being typed (from its `@` through the rest of the word under the caret)
 * with `@path ` (quoted when the path has spaces). Returns the new value and caret.
 */
export function insertMention(value: string, start: number, caret: number, path: string) {
  const rest = value.slice(caret);
  // Swallow the remainder of the token under the caret (and a closing quote), not the next word.
  const tail = /^[^\s]*/.exec(rest)![0].length;
  const inserted = `${formatMention(path)} `;
  const after = value.slice(caret + tail).replace(/^ /, '');
  return { value: value.slice(0, start) + inserted + after, caret: start + inserted.length };
}

export type MentionPopupState =
  | { kind: 'closed' }
  | { kind: 'no-project' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'list' };

/**
 * `@file` autocomplete in the composer (docs/specs/mentions.md). Typing `@` at the start of
 * the message or after whitespace opens a listbox of the conversation project's files, ranked
 * by the server as the user types. Arrows move, Enter or Tab insert `@path `, Escape closes
 * until the text changes. Disabled while another composer popup (saved commands) is open.
 */
export function useFileMentions(
  projectId: string | null | undefined,
  value: string,
  setValue: (v: string) => void,
  textarea: RefObject<HTMLTextAreaElement | null>,
  disabled = false,
) {
  const [caret, setCaret] = useState<number | null>(null);
  const [result, setResult] = useState<{ key: string; projectId: string; files: string[]; error?: string } | null>(
    null,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const listboxId = useId();

  // The caret is read from the textarea on every selection change; a stale value (after an
  // outside edit) is clamped so the mention under it is recomputed safely.
  const position = caret === null ? value.length : Math.min(caret, value.length);
  const mention = disabled || dismissed === value ? undefined : activeMention(value, position);
  const query = mention?.query;
  const key = `${projectId ?? ''}\0${query ?? ''}`;

  useEffect(() => {
    if (query === undefined || !projectId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api
        .projectFiles(projectId, query, FETCH_LIMIT, controller.signal)
        .then((list) => setResult({ key, projectId, files: list.files }))
        .catch((e: Error) => {
          if (!controller.signal.aborted) setResult({ key, projectId, files: [], error: e.message });
        });
    }, FETCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, projectId, query]);
  // Keeps the previous results on screen while the next query loads.
  const items = result && query !== undefined && result.projectId === projectId ? result.files : [];
  const fresh = result?.key === key;
  const state: MentionPopupState =
    query === undefined
      ? { kind: 'closed' }
      : !projectId
        ? { kind: 'no-project' }
        : result?.error && fresh
          ? { kind: 'error', message: result.error }
          : items.length
            ? { kind: 'list' }
            : fresh
              ? { kind: 'empty' }
              : { kind: 'loading' };
  const open = state.kind === 'list';
  const index = Math.min(activeIndex, Math.max(0, items.length - 1));
  useEffect(() => setActiveIndex(0), [query]);

  // After inserting, put the caret right after the mention (React would leave it at the end).
  useLayoutEffect(() => {
    const element = textarea.current;
    if (pendingCaret.current === null || !element) return;
    element.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [value, textarea]);

  const select = useCallback(
    (path: string) => {
      if (!mention) return;
      const next = insertMention(value, mention.start, position, path);
      pendingCaret.current = next.caret;
      setDismissed(null);
      setValue(next.value);
    },
    [mention, value, position, setValue],
  );
  /** Handles the key while the popup is shown; returns true when the composer must ignore it. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (state.kind === 'closed') return false;
    const action = slashKeyAction({ ...event, isComposing: event.nativeEvent.isComposing }, true);
    // Without options only Escape is taken; Enter still sends the message as typed.
    if (!action || (!open && action !== 'close')) return false;
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
    /** True while options are listed (the listbox exists). */
    open,
    state,
    items,
    activeIndex: index,
    listboxId,
    optionId,
    select,
    onKeyDown,
    setActiveIndex,
    /** Wire to the textarea's onChange and onSelect: the caret decides the active mention. */
    trackCaret: (event: { currentTarget: HTMLTextAreaElement }) => setCaret(event.currentTarget.selectionStart),
    inputProps: {
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? listboxId : undefined,
      'aria-activedescendant': open ? optionId(index) : undefined,
    },
  };
}
