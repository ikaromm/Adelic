import { useEffect, useRef } from 'react';

export interface Shortcuts {
  /** Ctrl/Cmd+K. */
  newConversation: () => void;
  /** Ctrl/Cmd+Shift+F (plain Ctrl+F stays the browser's find-in-page). */
  search: () => void;
  /** Escape: close overlays (forms, help, mobile drawer). */
  dismiss: () => void;
}

/** True for Ctrl+K / Cmd+K, independent of keyboard case. */
export const isNewConversationKey = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key'>) =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
/** True for Ctrl+Shift+F / Cmd+Shift+F. */
export const isSearchKey = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'key'>) =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f';

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
      if (event.key === 'Escape') current.current.dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
