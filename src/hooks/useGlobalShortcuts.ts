import { useEffect, useRef } from 'react';

export interface Shortcuts {
  /** Ctrl/Cmd+K. */
  newConversation: () => void;
  /** Ctrl/Cmd+Shift+F (plain Ctrl+F stays the browser's find-in-page). */
  search: () => void;
  /** Ctrl/Cmd+P: command palette (replaces the browser's print dialog). */
  palette?: () => void;
  /** Escape: close overlays (forms, help, mobile drawer). */
  dismiss: () => void;
}

/** True for Ctrl+K / Cmd+K, independent of keyboard case. */
export const isNewConversationKey = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key'>) =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
/** True for Ctrl+Shift+F / Cmd+Shift+F. */
export const isSearchKey = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'key'>) =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f';
/** True for Ctrl+P / Cmd+P without Shift or Alt, and never while an IME is composing. */
export const isPaletteKey = (
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key' | 'isComposing'>,
) =>
  !event.isComposing &&
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey &&
  event.key.toLowerCase() === 'p';

/** Window-level shortcuts. Handlers are read from a ref, so they always see current state. */
export function useGlobalShortcuts(shortcuts: Shortcuts) {
  const current = useRef(shortcuts);
  current.current = shortcuts;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isNewConversationKey(event)) {
        event.preventDefault();
        current.current.newConversation();
      }
      if (isSearchKey(event)) {
        event.preventDefault();
        current.current.search();
      }
      if (current.current.palette && isPaletteKey(event)) {
        event.preventDefault();
        current.current.palette();
      }
      if (event.key === 'Escape') current.current.dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
