import { useEffect, useState } from 'react';
import { ArrowUp, Folder, FolderPlus, LoaderCircle } from 'lucide-react';
import { api } from '../api';
import { useI18n } from '../i18n';

type Entry = { name: string; path: string; directory: true };

/** Local-only picker. It lists directory names and never reads folder contents. */
export function LocalFolderPicker({ path, onPathChange }: { path: string; onPathChange: (path: string) => void }) {
  const { t } = useI18n();
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [currentAccess, setCurrentAccess] = useState({ readable: false, writable: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [createdMessage, setCreatedMessage] = useState(false);

  const load = async (requestedPath?: string, select = false) => {
    setBusy(true);
    setError('');
    setCreatedMessage(false);
    try {
      const result = await api.localDirectories(requestedPath);
      setCurrentPath(result.path);
      setCurrentAccess({ readable: result.readable, writable: result.writable });
      setEntries(result.entries.filter((entry) => entry.directory));
      setTruncated(result.truncated);
      if (select) onPathChange(result.path);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // Initialize once from the server's HOME directory; manual paths remain untouched afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createFolder = async () => {
    setBusy(true);
    setError('');
    setCreatedMessage(false);
    try {
      const result = await api.createLocalDirectory(currentPath, folderName);
      setFolderName('');
      await load(result.path, true);
      setCreatedMessage(true);
    } catch (cause) {
      setError((cause as Error).message);
      setBusy(false);
    }
  };

  const parentPath = currentPath.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
  return (
    <div className="local-directory-browser">
      <div className="remote-directory-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load(path.trim() || undefined)}
          disabled={busy}
        >
          {busy ? <LoaderCircle className="spin" size={14} /> : <Folder size={14} />} {t('projectForm.localBrowse')}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load(parentPath)}
          disabled={busy || !currentPath || currentPath === '/'}
        >
          <ArrowUp size={13} /> {t('projectForm.localParent')}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load(currentPath, true)}
          disabled={busy || !currentPath}
        >
          {t('projectForm.localSelectCurrent')}
        </button>
      </div>
      {currentPath && <small className="local-directory-path">{currentPath}</small>}
      {currentPath && (
        <small className="local-directory-access">
          {t(
            currentAccess.readable
              ? currentAccess.writable
                ? 'projectForm.localAccessReadWrite'
                : 'projectForm.localAccessReadOnly'
              : currentAccess.writable
                ? 'projectForm.localAccessWriteOnly'
                : 'projectForm.localAccessNone',
          )}
        </small>
      )}
      {error && <small className="error-text">{error}</small>}
      {createdMessage && <small>{t('projectForm.localFolderCreated')}</small>}
      <div className="remote-directory-list" aria-label={t('projectForm.localDirectories')}>
        {entries.map((entry) => (
          <button key={entry.path} type="button" onClick={() => void load(entry.path)} disabled={busy}>
            <Folder size={13} /> {entry.name}
          </button>
        ))}
        {!busy && entries.length === 0 && !error && <small>{t('projectForm.localNoDirectories')}</small>}
        {truncated && <small>{t('projectForm.localFolderLimit')}</small>}
      </div>
      <div className="local-directory-create">
        <input
          value={folderName}
          onChange={(event) => setFolderName(event.target.value)}
          placeholder={t('projectForm.localFolderName')}
          aria-label={t('projectForm.localFolderName')}
          maxLength={120}
        />
        <button
          type="button"
          className="secondary-button"
          onClick={() => void createFolder()}
          disabled={busy || !currentPath || !folderName.trim()}
        >
          <FolderPlus size={14} /> {t('projectForm.localCreateFolder')}
        </button>
      </div>
    </div>
  );
}
