import { useMemo, useState } from 'react';
import { ChevronDown, Folder, FolderPlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Project, ProjectFolder, Session } from '../../shared/contracts';
import { useI18n } from '../i18n';
import { SessionItem, sortSidebarSessions, type SessionSidebarPatch } from './Sidebar';

/** Project-local virtual folders; they only organize the sidebar and do not touch disk paths. */
export function ProjectFolders({
  folders,
  sessions,
  selectedSession,
  now,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  disabled = false,
  projects = [],
  allFolders = folders,
  onSessionUpdate,
}: {
  folders: ProjectFolder[];
  sessions: Session[];
  projects?: Project[];
  allFolders?: ProjectFolder[];
  onSessionUpdate?: (sessionId: string, patch: SessionSidebarPatch) => Promise<void>;
  selectedSession: string;
  now: number;
  onSelect: (sessionId: string) => void;
  onCreate: (name: string, parentId: string | null) => Promise<ProjectFolder | void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(folders.map((folder) => folder.id)));
  const [newParentId, setNewParentId] = useState<string | null | undefined>(undefined);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const sessionsByFolder = useMemo(() => {
    const grouped = new Map<string | null, Session[]>();
    for (const session of sortSidebarSessions(sessions)) {
      const key = session.folderId ?? null;
      grouped.set(key, [...(grouped.get(key) || []), session]);
    }
    return grouped;
  }, [sessions]);
  const childrenByFolder = useMemo(() => {
    const grouped = new Map<string | null, ProjectFolder[]>();
    for (const folder of folders) grouped.set(folder.parentId, [...(grouped.get(folder.parentId) || []), folder]);
    return grouped;
  }, [folders]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveCreate() {
    const name = newName.trim();
    if (!name || newParentId === undefined) return;
    setSaving(true);
    try {
      const created = await onCreate(name, newParentId);
      setNewName('');
      setNewParentId(undefined);
      setExpanded((current) => {
        const next = new Set(current);
        if (newParentId) next.add(newParentId);
        if (created) next.add(created.id);
        return next;
      });
    } catch {
      // The app displays the server error beside the conversation.
    } finally {
      setSaving(false);
    }
  }

  async function saveRename(id: string) {
    const name = renameValue.trim();
    if (!name) return;
    setSaving(true);
    try {
      await onRename(id, name);
      setRenaming(null);
    } catch {
      // Keep the edit field open so the name can be corrected or retried.
    } finally {
      setSaving(false);
    }
  }

  async function deleteFolder(folder: ProjectFolder, hasChildren: boolean, items: Session[]) {
    if (
      disabled ||
      saving ||
      deletingFolderId ||
      hasChildren ||
      items.some((session) => session.activeRunId) ||
      !window.confirm(t('folders.deleteConfirm', { name: folder.name }))
    )
      return;
    setDeletingFolderId(folder.id);
    try {
      await onDelete(folder.id);
    } catch {
      // The app displays backend errors beside the conversation.
    } finally {
      setDeletingFolderId(null);
    }
  }

  function renderCreate() {
    return (
      <form
        className="project-folder-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveCreate();
        }}
      >
        <input
          autoFocus
          aria-label={t('folders.name')}
          maxLength={80}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t('folders.namePlaceholder')}
        />
        <button
          type="submit"
          className="icon-button"
          disabled={saving || !newName.trim()}
          aria-label={t('folders.create')}
        >
          <FolderPlus size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={saving}
          onClick={() => setNewParentId(undefined)}
          aria-label={t('common.cancel')}
        >
          <X size={14} />
        </button>
      </form>
    );
  }

  function renderFolder(folder: ProjectFolder) {
    const isOpen = expanded.has(folder.id);
    const children = childrenByFolder.get(folder.id) || [];
    const items = sessionsByFolder.get(folder.id) || [];
    const hasChildren = children.length > 0;
    const hasRunningSession = items.some((session) => session.activeRunId);
    const deleteDisabled = disabled || saving || deletingFolderId !== null || hasChildren || hasRunningSession;
    const deleteTitle = hasChildren
      ? t('folders.deleteHasChildren')
      : hasRunningSession
        ? t('folders.deleteRunning')
        : t('folders.deleteNamed', { name: folder.name });
    return (
      <div className="project-folder-node" key={folder.id}>
        <div className="project-folder-row">
          <button
            type="button"
            className="project-folder-toggle"
            aria-expanded={isOpen}
            onClick={() => toggle(folder.id)}
          >
            <ChevronDown size={13} className={isOpen ? '' : 'collapsed'} aria-hidden="true" />
            <Folder size={14} aria-hidden="true" />
            <span>{folder.name}</span>
          </button>
          {renaming === folder.id && (
            <input
              className="project-folder-rename"
              autoFocus
              aria-label={t('folders.rename')}
              maxLength={80}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveRename(folder.id);
                }
                if (event.key === 'Escape') setRenaming(null);
              }}
            />
          )}
          <span className="project-folder-count">{items.length + children.length}</span>
          <button
            type="button"
            className="icon-button project-folder-action"
            aria-label={t('folders.createChild', { name: folder.name })}
            title={t('folders.createChild', { name: folder.name })}
            onClick={() => {
              setNewName('');
              setNewParentId(folder.id);
              setExpanded((current) => new Set(current).add(folder.id));
            }}
          >
            <Plus size={13} />
          </button>
          {renaming === folder.id ? (
            <button
              type="button"
              className="icon-button project-folder-action"
              aria-label={t('folders.saveRename')}
              disabled={saving || !renameValue.trim()}
              onClick={() => void saveRename(folder.id)}
            >
              <FolderPlus size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button project-folder-action"
              aria-label={t('folders.renameNamed', { name: folder.name })}
              title={t('folders.renameNamed', { name: folder.name })}
              onClick={() => {
                setRenaming(folder.id);
                setRenameValue(folder.name);
              }}
            >
              <Pencil size={12} />
            </button>
          )}
          <button
            type="button"
            className="icon-button project-folder-action danger"
            aria-label={t('folders.deleteNamed', { name: folder.name })}
            title={deleteTitle}
            disabled={deleteDisabled}
            onClick={() => void deleteFolder(folder, hasChildren, items)}
          >
            <Trash2 size={12} />
          </button>
        </div>
        {isOpen && (
          <div className="project-folder-contents">
            {newParentId === folder.id && renderCreate()}
            {items.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                selected={session.id === selectedSession}
                now={now}
                onSelect={() => onSelect(session.id)}
                projects={projects}
                folders={allFolders}
                onUpdate={onSessionUpdate ? (patch) => onSessionUpdate(session.id, patch) : undefined}
                disabled={disabled}
              />
            ))}
            {children.map((child) => renderFolder(child))}
          </div>
        )}
      </div>
    );
  }

  const rootSessions = sessionsByFolder.get(null) || [];
  const rootFolders = childrenByFolder.get(null) || [];
  return (
    <div className="project-folder-tree" aria-label={t('folders.tree')}>
      <div className="project-folder-tree-heading">
        <span>{t('folders.title')}</span>
        <button
          type="button"
          className="icon-button"
          aria-label={t('folders.createRoot')}
          title={t('folders.createRoot')}
          onClick={() => {
            setNewName('');
            setNewParentId(null);
          }}
        >
          <FolderPlus size={14} />
        </button>
      </div>
      {newParentId === null && renderCreate()}
      {rootSessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          selected={session.id === selectedSession}
          now={now}
          onSelect={() => onSelect(session.id)}
          projects={projects}
          folders={allFolders}
          onUpdate={onSessionUpdate ? (patch) => onSessionUpdate(session.id, patch) : undefined}
          disabled={disabled}
        />
      ))}
      {rootFolders.map((folder) => renderFolder(folder))}
    </div>
  );
}
