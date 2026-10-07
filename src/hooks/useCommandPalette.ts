import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommandEntry } from '../../shared/commands';
import { api } from '../api';
import { buildActions, type PaletteAction, type PaletteCallbacks, type PaletteState } from '../palette/actions';
import { loadRecents, recordRecent } from '../palette/recents';

/** Downloads the conversation export (the same endpoint as the topbar button). */
export function downloadExport(sessionId: string, format: 'md' | 'json') {
  const link = document.createElement('a');
  link.href = `/api/sessions/${encodeURIComponent(sessionId)}/export${format === 'json' ? '?format=json' : ''}`;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * State of the command palette (Ctrl/Cmd+P): open/close with focus restore, saved commands
 * fetched on open, recent selections, and the action list built from the app state.
 */
export function useCommandPalette({
  state,
  projectId,
  callbacks,
}: {
  state: Omit<PaletteState, 'commands'>;
  /** Project of the open conversation, for project and repository commands. */
  projectId: string | null | undefined;
  callbacks: PaletteCallbacks;
}) {
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<CommandEntry[]>([]);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const returnFocus = useRef<HTMLElement | null>(null);
  const latest = useRef(callbacks);
  latest.current = callbacks;

  const show = useCallback(() => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body)
      returnFocus.current = document.activeElement;
    setRecents(loadRecents());
    setOpen(true);
  }, []);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    const target = returnFocus.current;
    returnFocus.current = null;
    if (restoreFocus && target?.isConnected) target.focus();
  }, []);
  const toggle = useCallback(() => (open ? close() : show()), [open, close, show]);

  // Fetched on each open (cheap, local), so commands saved in Settings show up.
  useEffect(() => {
    if (!open) return;
    let current = true;
    api
      .commands(projectId)
      .then((list) => current && setCommands(list.commands))
      .catch(() => current && setCommands([]));
    return () => {
      current = false;
    };
  }, [open, projectId]);

  // Callbacks are read through a ref, so the list only rebuilds when the state changes.
  const proxy = useMemo<PaletteCallbacks>(
    () => ({
      newConversation: () => latest.current.newConversation(),
      search: () => latest.current.search(),
      goTo: (page) => latest.current.goTo(page),
      toggleSidebar: () => latest.current.toggleSidebar(),
      exportConversation: (id, format) => latest.current.exportConversation(id, format),
      openConversation: (id) => latest.current.openConversation(id),
      openProject: (id) => latest.current.openProject(id),
      setModel: (providerId, model) => latest.current.setModel(providerId, model),
      setMode: (mode) => latest.current.setMode(mode),
      insertCommand: (name) => latest.current.insertCommand(name),
    }),
    [],
  );
  // Built on every render while open (a few hundred objects at most), so it never goes stale.
  const actions = open ? buildActions({ ...state, commands }, proxy) : [];

  /** Runs an enabled action: focus goes back first, so the action may move it elsewhere. */
  const run = useCallback(
    (action: PaletteAction) => {
      if (action.disabled) return;
      setRecents(recordRecent(action.id));
      close(true);
      action.run();
    },
    [close],
  );

  return { open, show, close, toggle, actions, recents, run };
}
