import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Brain, Folder, FolderPlus, LoaderCircle, Plus, Shield, X } from 'lucide-react';
import type { GraphifyConfig, OrchestrationConfig } from '../../shared/contracts';
import type { RemoteHost } from '../../shared/remote-hosts';
import { api } from '../api';
import { useI18n } from '../i18n';
import { LocalFolderPicker } from './LocalFolderPicker';

/** Lowercase ASCII slug used as the default memory project id. */
export function projectSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function resolveRemoteEntryPath(base: string, relative: string) {
  const parts = base.split('/').filter(Boolean);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export interface NewProject {
  name: string;
  path?: string;
  remote?: { hostId: string; path: string };
  memoryWorkspace: string;
  memoryProject: string;
  orchestration?: OrchestrationConfig;
  graphify?: GraphifyConfig;
}

/** "Novo projeto" dialog. Owns its fields; the caller creates the project and closes it. */
export function ProjectForm({
  busy,
  error,
  onSubmit,
  onClose,
  hidden = false,
  onConfigureSSH,
}: {
  busy: boolean;
  error: string;
  onSubmit: (project: NewProject) => void;
  onClose: () => void;
  hidden?: boolean;
  onConfigureSSH?: () => void;
}) {
  const { t } = useI18n();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const browseRequestRef = useRef(0);
  const invalidateBrowse = () => {
    browseRequestRef.current += 1;
    setDirectoriesBusy(false);
    setDirectoriesError('');
  };
  useEffect(() => {
    if (!hidden) nameInputRef.current?.focus();
  }, [hidden]);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [memoryWorkspace, setMemoryWorkspace] = useState('pessoal');
  const [memoryProject, setMemoryProject] = useState('');
  const [kind, setKind] = useState<'local' | 'remote'>('local');
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [hostId, setHostId] = useState('');
  const [directories, setDirectories] = useState<{ name: string; path: string; directory: boolean }[]>([]);
  const [directoriesError, setDirectoriesError] = useState('');
  const [directoriesBusy, setDirectoriesBusy] = useState(false);
  const [browsing, setBrowsing] = useState(true);
  const [folderSelected, setFolderSelected] = useState(false);
  const [profile, setProfile] = useState<'standard' | 'light'>('standard');
  // The memory id follows the name until the user edits it.
  const [customId, setCustomId] = useState(false);
  useEffect(() => {
    if (hidden) return;
    let active = true;
    void api
      .remoteHosts()
      .then((next) => {
        if (!active) return;
        setHosts(next);
        setHostId((current) => (next.some((host) => host.id === current) ? current : next[0]?.id || ''));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [hidden]);
  const browse = async (nextPath: string, select = false) => {
    if (!hostId) return;
    const requestId = ++browseRequestRef.current;
    setDirectoriesBusy(true);
    setBrowsing(!select);
    setFolderSelected(false);
    setDirectoriesError('');
    try {
      const result = await api.remoteDirectories(hostId, nextPath);
      if (browseRequestRef.current !== requestId) return;
      setPath(nextPath);
      setDirectories(result.entries.filter((entry) => entry.directory));
      setFolderSelected(select);
    } catch (error) {
      if (browseRequestRef.current === requestId) setDirectoriesError((error as Error).message);
    } finally {
      if (browseRequestRef.current === requestId) setDirectoriesBusy(false);
    }
  };
  useEffect(() => {
    if (!hidden && kind === 'remote' && hostId) void browse(path || '/');
    return () => {
      browseRequestRef.current += 1;
    };
    // Browsing is initiated when selecting the remote mode or host, not on every path keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, hostId, hidden]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      name: name.trim(),
      ...(kind === 'remote' ? { remote: { hostId, path: path.trim() } } : { path: path.trim() }),
      memoryWorkspace: memoryWorkspace.trim(),
      memoryProject: memoryProject.trim() || projectSlug(name),
      ...(kind === 'local'
        ? {
            orchestration:
              profile === 'standard'
                ? { enabled: true, maxWorkers: 2 as const, review: true }
                : { enabled: false, maxWorkers: 1 as const, review: false },
            graphify: { enabled: profile === 'standard' },
          }
        : {}),
    });
  };
  return (
    <div
      hidden={hidden}
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-form-title"
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div className="project-avatar" aria-hidden="true">
            <FolderPlus size={17} />
          </div>
          <div>
            <h2 id="project-form-title">{t('projectForm.title')}</h2>
            <p>{t(kind === 'remote' ? 'projectForm.remoteDetail' : 'projectForm.detail')}</p>
          </div>
          <button type="button" className="icon-button" aria-label={t('projectForm.close')} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <label>
          {t('projectForm.name')}
          <input
            ref={nameInputRef}
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!customId) setMemoryProject(projectSlug(event.target.value));
            }}
            placeholder={t('projectForm.namePlaceholder')}
            required
          />
        </label>
        <label>
          {t('projectForm.location')}
          <select
            value={kind}
            onChange={(event) => {
              invalidateBrowse();
              setKind(event.target.value as 'local' | 'remote');
              setPath('');
              setDirectories([]);
              setBrowsing(true);
              setFolderSelected(false);
            }}
          >
            <option value="local">{t('projectForm.local')}</option>
            <option value="remote">{t('projectForm.remote')}</option>
          </select>
        </label>
        {kind === 'local' ? (
          <>
            <label>
              {t('projectForm.path')}
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={t('projectForm.pathPlaceholder')}
                required
              />
            </label>
            <LocalFolderPicker path={path} onPathChange={setPath} />
            <fieldset className="project-profile-options">
              <legend>{t('projectForm.profile')}</legend>
              <label>
                <input
                  type="radio"
                  name="project-profile"
                  value="standard"
                  checked={profile === 'standard'}
                  onChange={() => setProfile('standard')}
                />
                <span>
                  <strong>{t('projectForm.profileStandard')}</strong>
                  <small>{t('projectForm.profileStandardDetail')}</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="project-profile"
                  value="light"
                  checked={profile === 'light'}
                  onChange={() => setProfile('light')}
                />
                <span>
                  <strong>{t('projectForm.profileLight')}</strong>
                  <small>{t('projectForm.profileLightDetail')}</small>
                </span>
              </label>
            </fieldset>
          </>
        ) : (
          <>
            {onConfigureSSH && (
              <button type="button" className="secondary-button" onClick={onConfigureSSH} disabled={busy}>
                {t('projectForm.configureSSH')}
              </button>
            )}
            <label>
              {t('projectForm.host')}
              <select
                value={hostId}
                onChange={(event) => {
                  invalidateBrowse();
                  setHostId(event.target.value);
                  setPath('');
                  setDirectories([]);
                  setBrowsing(true);
                  setFolderSelected(false);
                }}
                required
              >
                {hosts.length === 0 && <option value="">{t('projectForm.noHosts')}</option>}
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name} · {host.target}:{host.port} · {t('projectForm.hostStateUnknown')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('projectForm.remotePath')}
              <input
                value={path}
                onChange={(event) => {
                  invalidateBrowse();
                  setPath(event.target.value);
                  setFolderSelected(false);
                }}
                placeholder="/home/user/project"
                required
              />
            </label>
            <div className="remote-directory-browser">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void browse(path || '/')}
                disabled={!hostId || directoriesBusy}
              >
                {directoriesBusy ? <LoaderCircle className="spin" size={14} /> : <Folder size={14} />}{' '}
                {t('projectForm.browse')}
              </button>
              {directoriesError && (
                <div className="error-text" role="alert">
                  {directoriesError}
                  <button type="button" className="secondary-button" onClick={() => void browse(path || '/')}>
                    {t('projectForm.retryBrowse')}
                  </button>
                </div>
              )}
              {browsing ? (
                <div className="remote-directory-list" aria-label={t('projectForm.directories')}>
                  {directories.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => void browse(resolveRemoteEntryPath(path || '/', entry.path))}
                    >
                      <Folder size={13} /> {entry.name}
                    </button>
                  ))}
                  {!directoriesBusy && directories.length === 0 && !directoriesError && (
                    <small>{t('projectForm.noDirectories')}</small>
                  )}
                </div>
              ) : (
                <small className="remote-folder-selected">
                  {folderSelected ? t('projectForm.folderSelected') : t('projectForm.currentPath', { path })}
                </small>
              )}
              <div className="remote-directory-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    const parent = path.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
                    void browse(parent);
                  }}
                  disabled={!hostId || directoriesBusy}
                >
                  <ArrowUp size={13} /> {t('projectForm.parent')}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void browse(path || '/', true)}
                  disabled={!hostId || directoriesBusy || !path.startsWith('/') || path === '/'}
                >
                  {t('projectForm.selectCurrent')}
                </button>
              </div>
            </div>
          </>
        )}
        <div className="memory-scope-modal">
          <div>
            <Brain size={14} /> {t('projectForm.memoryScope')}
          </div>
          <label>
            {t('projectForm.workspace')}
            <input
              value={memoryWorkspace}
              onChange={(event) => setMemoryWorkspace(event.target.value)}
              placeholder="pessoal"
              required
            />
          </label>
          <label>
            {t('projectForm.memoryProject')}
            <input
              value={memoryProject}
              onChange={(event) => {
                setMemoryProject(event.target.value);
                setCustomId(true);
              }}
              placeholder={t('projectForm.memoryProjectPlaceholder')}
              required
            />
          </label>
          <small>{t('projectForm.memoryProjectHint')}</small>
        </div>
        <div className="modal-note">
          <Shield size={14} /> {t(kind === 'remote' ? 'projectForm.remotePermission' : 'projectForm.permission')}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {t('projectForm.cancel')}
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={
              busy ||
              !name.trim() ||
              !path.trim() ||
              (kind === 'remote' && (!hostId || !path.startsWith('/') || path === '/')) ||
              !memoryWorkspace.trim() ||
              !memoryProject.trim()
            }
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} {t('projectForm.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
