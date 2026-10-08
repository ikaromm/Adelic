import { FolderInput } from 'lucide-react';
import type { ProjectFolder } from '../../shared/contracts';
import { useI18n } from '../i18n';

function folderOptions(
  folders: ProjectFolder[],
  parentId: string | null = null,
  depth = 0,
): { id: string; label: string }[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .flatMap((folder) => [
      { id: folder.id, label: `${'　'.repeat(depth)}${folder.name}` },
      ...folderOptions(folders, folder.id, depth + 1),
    ]);
}

/** Move this conversation between its project's virtual folders without changing its path. */
export function SessionFolderMenu({
  folders,
  folderId,
  disabled,
  onMove,
}: {
  folders: ProjectFolder[];
  folderId?: string | null;
  disabled: boolean;
  onMove: (folderId: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="session-folder-menu">
      <FolderInput size={15} aria-hidden="true" />
      <span className="visually-hidden">{t('folders.move')}</span>
      <select
        aria-label={t('folders.move')}
        value={folderId || ''}
        disabled={disabled || folders.length === 0}
        title={t('folders.move')}
        onChange={(event) => onMove(event.target.value || null)}
      >
        <option value="">{t('folders.projectRoot')}</option>
        {folderOptions(folders).map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.label}
          </option>
        ))}
      </select>
    </label>
  );
}
