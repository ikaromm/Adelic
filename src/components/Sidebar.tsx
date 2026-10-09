import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Archive,
  ArrowUpCircle,
  Brain,
  CalendarClock,
  MessageSquare,
  Pin,
  Settings as SettingsIcon,
  MoreHorizontal,
} from 'lucide-react';
import { api, type UpdateInfo } from '../api';
import type { Project, ProjectFolder, Session } from '../../shared/contracts';
import { useI18n } from '../i18n';

export const SIDEBAR_LIMIT = 6;

export type SessionSidebarPatch = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  projectId?: string | null;
  folderId?: string | null;
};

/** Stable ordering: pinned conversations first, newest updated first within each group. */
export function sortSidebarSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const pinOrder = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
    return pinOrder || b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function SessionItem({
  session,
  selected,
  now,
  onSelect,
  projects = [],
  folders = [],
  onUpdate,
  disabled = false,
}: {
  session: Session;
  selected: boolean;
  now: number;
  onSelect: () => void;
  projects?: Project[];
  folders?: ProjectFolder[];
  onUpdate?: (patch: SessionSidebarPatch) => Promise<void>;
  disabled?: boolean;
}) {
  const { t, fmt } = useI18n();
  const title = session.title || t('sidebar.untitled');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveProjectId, setMoveProjectId] = useState(session.projectId ?? '');
  const [moveFolderId, setMoveFolderId] = useState(session.folderId ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = disabled || Boolean(session.activeRunId) || saving;
  const selectedProject = projects.find((project) => project.id === moveProjectId);
  const availableFolders = selectedProject ? folders.filter((folder) => folder.projectId === selectedProject.id) : [];

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!moveOpen) return;
    const select = document.querySelector<HTMLSelectElement>('.session-move-dialog select');
    select?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMoveOpen(false);
        triggerRef.current?.focus();
      }
    }
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.session-move-dialog select:not(:disabled), .session-move-dialog button:not(:disabled)',
        ),
      );
      if (!controls.length) return;
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault();
        controls[0].focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keydown', trap);
    };
  }, [moveOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node))
        setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && menuRef.current) {
        const items = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (items.length) {
          event.preventDefault();
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next].focus();
        }
      }
      if (event.key === 'Tab' && menuRef.current) {
        const items = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  function restoreFocus() {
    requestAnimationFrame(() => {
      const target =
        triggerRef.current ||
        document.querySelector<HTMLButtonElement>(`[data-session-id="${session.id}"] .session-item`) ||
        document.querySelector<HTMLButtonElement>('.new-chat-button');
      target?.focus();
    });
  }
  function closeMove() {
    setMoveOpen(false);
    restoreFocus();
  }

  async function update(patch: SessionSidebarPatch, closeMenu = true) {
    if (!onUpdate || busy) return false;
    setSaving(true);
    setError('');
    try {
      await onUpdate(patch);
      setError('');
      if (closeMenu) {
        setMenuOpen(false);
        restoreFocus();
      }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('sidebarActions.saveError'));
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function saveTitle() {
    const next = draft.trim();
    if (!next) {
      setError(t('sidebarActions.titleRequired'));
      return;
    }
    if (next === title) {
      setEditing(false);
      restoreFocus();
      setError('');
      return;
    }
    if (!onUpdate || busy) return;
    setSaving(true);
    setError('');
    try {
      await onUpdate({ title: next });
      setEditing(false);
      restoreFocus();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('sidebarActions.renameError'));
    } finally {
      setSaving(false);
    }
  }
  function openMove() {
    setMoveProjectId(session.projectId ?? '');
    setMoveFolderId(session.folderId ?? '');
    setError('');
    setMenuOpen(false);
    setMoveOpen(true);
  }
  async function confirmMove(event: FormEvent) {
    event.preventDefault();
    await update(
      { projectId: moveProjectId || null, folderId: moveProjectId ? moveFolderId || null : null },
      false,
    ).then((ok) => {
      if (ok) closeMove();
    });
  }

  return (
    <div className={`session-row ${selected ? 'selected' : ''}`} data-session-id={session.id}>
      {editing ? (
        <form
          className="session-rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTitle();
          }}
        >
          <input
            ref={inputRef}
            aria-label={t('sidebarActions.renameLabel')}
            maxLength={160}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setEditing(false);
                setDraft(title);
              }
            }}
          />
          <button type="submit" className="session-action-button" aria-label={t('sidebarActions.save')} disabled={busy}>
            {t('sidebarActions.save')}
          </button>
          <button
            type="button"
            className="session-action-button"
            aria-label={t('common.cancel')}
            onClick={() => {
              setEditing(false);
              setDraft(title);
            }}
          >
            {t('common.cancel')}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="session-item"
          aria-current={selected ? 'page' : undefined}
          title={title}
          onClick={onSelect}
        >
          {session.activeRunId ? (
            <span className="session-running" aria-hidden="true" />
          ) : session.archivedAt ? (
            <Archive size={14} className="session-icon session-archived-icon" aria-hidden="true" />
          ) : (
            <MessageSquare size={14} className="session-icon" aria-hidden="true" />
          )}
          <span className="session-title">{title}</span>
          {session.pinnedAt && (
            <>
              <Pin size={12} className="session-pin-icon" aria-hidden="true" />
              <span className="visually-hidden">{t('sidebarActions.pinned')}</span>
            </>
          )}
          {session.activeRunId && <span className="visually-hidden">{t('sidebar.running')}</span>}
          {session.archivedAt && <span className="visually-hidden">{t('sidebar.archivedConversation')}</span>}
          <time className="session-time" dateTime={session.updatedAt}>
            {fmt.relative(session.updatedAt, now)}
          </time>
        </button>
      )}
      {onUpdate && !editing && (
        <button
          ref={triggerRef}
          type="button"
          className="session-action-trigger"
          aria-label={t('sidebarActions.actionsFor', { title })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('sidebarActions.actions')}
          onClick={() => {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (rect) {
              const menuHeight = session.activeRunId || disabled ? 202 : 154;
              const below = rect.bottom + menuHeight + 4 <= window.innerHeight;
              setMenuPosition({
                top: below ? rect.bottom + 4 : Math.max(8, rect.top - menuHeight - 4),
                left: Math.max(8, Math.min(rect.right - 184, window.innerWidth - 192)),
              });
            }
            setMenuOpen((open) => !open);
          }}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      )}
      {menuOpen &&
        onUpdate &&
        createPortal(
          <div
            className="session-action-menu"
            style={{ top: menuPosition.top, left: menuPosition.left }}
            role="menu"
            aria-label={t('sidebarActions.actions')}
            ref={menuRef}
          >
            {busy && <p className="session-action-explanation">{t('sidebarActions.busy')}</p>}
            <button
              role="menuitem"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(title);
                setError('');
                setMenuOpen(false);
                setEditing(true);
              }}
            >
              {t('sidebarActions.rename')}
            </button>
            <button
              role="menuitem"
              type="button"
              disabled={busy}
              onClick={() => void update({ pinned: !session.pinnedAt })}
            >
              {t(session.pinnedAt ? 'sidebarActions.unpin' : 'sidebarActions.pin')}
            </button>
            <button
              role="menuitem"
              type="button"
              disabled={busy}
              onClick={() => void update({ archived: !session.archivedAt })}
            >
              {t(session.archivedAt ? 'sidebarActions.restore' : 'sidebarActions.archive')}
            </button>
            <button role="menuitem" type="button" disabled={busy} onClick={openMove}>
              {t('sidebarActions.move')}
            </button>
          </div>,
          document.body,
        )}
      {moveOpen &&
        createPortal(
          <div
            className="session-move-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeMove();
            }}
          >
            <form
              className="session-move-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="session-move-title"
              onSubmit={(event) => void confirmMove(event)}
            >
              <h2 id="session-move-title">{t('sidebarActions.moveDialogTitle')}</h2>
              <label>
                {t('sidebarActions.projectLabel')}
                <select
                  value={moveProjectId}
                  disabled={busy}
                  onChange={(event) => {
                    setMoveProjectId(event.target.value);
                    setMoveFolderId('');
                  }}
                >
                  <option value="">{t('sidebarActions.standalone')}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              {moveProjectId && (
                <label>
                  {t('sidebarActions.folderLabel')}
                  <select
                    value={moveFolderId}
                    disabled={busy}
                    onChange={(event) => setMoveFolderId(event.target.value)}
                  >
                    <option value="">{t('folders.projectRoot')}</option>
                    {availableFolders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {busy && <p className="session-action-explanation">{t('sidebarActions.busy')}</p>}
              {error && (
                <p className="session-action-error" role="alert">
                  {error}
                </p>
              )}
              <div className="session-move-dialog-buttons">
                <button type="button" onClick={closeMove}>
                  {t('common.cancel')}
                </button>
                <button type="submit" disabled={busy}>
                  {t('sidebarActions.confirmMove')}
                </button>
              </div>
            </form>
          </div>,
          document.body,
        )}
      {error && !moveOpen && (
        <p className="session-action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export type Page = 'chat' | 'activity' | 'automations' | 'memory' | 'settings' | 'git';

/** Footer navigation: Activity, Automations, Memory (with service status) and Settings. */
export function SidebarNav({
  page,
  goTo,
  memoryStatus,
  memoryReady,
}: {
  page: Page;
  goTo: (next: Page) => void;
  memoryStatus: string;
  memoryReady: boolean;
}) {
  const { t } = useI18n();
  return (
    <nav className="sidebar-footer" aria-label={t('sidebar.nav')}>
      <button
        className={`nav-item ${page === 'activity' ? 'active' : ''}`}
        aria-current={page === 'activity' ? 'page' : undefined}
        title={t('sidebar.activity')}
        onClick={() => goTo('activity')}
      >
        <Activity size={16} aria-hidden="true" />
        <span className="sidebar-label">{t('sidebar.activity')}</span>
      </button>
      <button
        className={`nav-item ${page === 'automations' ? 'active' : ''}`}
        aria-current={page === 'automations' ? 'page' : undefined}
        title={t('sidebar.automations')}
        onClick={() => goTo('automations')}
      >
        <CalendarClock size={16} aria-hidden="true" />
        <span className="sidebar-label">{t('sidebar.automations')}</span>
      </button>
      <button
        className={`nav-item ${page === 'memory' ? 'active' : ''}`}
        aria-current={page === 'memory' ? 'page' : undefined}
        title={t('sidebar.memoryTitle', { status: memoryStatus })}
        onClick={() => goTo('memory')}
      >
        <Brain size={16} aria-hidden="true" />
        <span className="sidebar-label">{t('sidebar.memory')}</span>
        <span className={`nav-status ${memoryReady ? 'ready' : 'muted'}`} aria-hidden="true" />
        <span className="visually-hidden">, {memoryStatus}</span>
      </button>
      <button
        className={`nav-item ${page === 'settings' ? 'active' : ''}`}
        aria-current={page === 'settings' ? 'page' : undefined}
        title={t('sidebar.settings')}
        onClick={() => goTo('settings')}
      >
        <SettingsIcon size={16} aria-hidden="true" />
        <span className="sidebar-label">{t('sidebar.settings')}</span>
      </button>
    </nav>
  );
}

/** Discreet link to a newer release; checks once per app start, only when enabled. */
export function UpdateNotice({ enabled }: { enabled: boolean }) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const { t } = useI18n();
  useEffect(() => {
    if (!enabled) return setUpdate(null);
    let active = true;
    api
      .updates()
      .then((result) => active && setUpdate(result))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled]);
  if (!update?.available || !update.url) return null;
  return (
    <a
      className="update-notice"
      href={update.url}
      target="_blank"
      rel="noreferrer"
      title={t('sidebar.updateTitle', { version: update.latest ?? '' })}
    >
      <ArrowUpCircle size={15} aria-hidden="true" />
      <span className="sidebar-label">{t('sidebar.update', { version: update.latest ?? '' })}</span>
    </a>
  );
}
