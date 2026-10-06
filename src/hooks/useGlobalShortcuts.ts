import { useEffect, useRef } from 'react';

export interface Shortcuts {
  /** Ctrl/Cmd+K. */
  newConversation: () => void;
  /** Escape: close overlays (forms, help, mobile drawer). */
  dismiss: () => void;
}

/** True for Ctrl+K / Cmd+K, independent of keyboard case. */
export const isNewConversationKey = (event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'key'>) =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';

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
      if (event.key === 'Escape') current.current.dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
