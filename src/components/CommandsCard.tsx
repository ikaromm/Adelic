import { BookOpen, Pencil, Plus, Terminal, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  COMMAND_DESCRIPTION_MAX,
  COMMAND_MESSAGES,
  COMMAND_RESERVED,
  COMMAND_TEMPLATE_MAX,
  commandFieldsError,
  type CommandEntry,
  type CommandList,
  type CommandMode,
} from '../../shared/commands';
import type { Project } from '../../shared/contracts';
import { api } from '../api';
import { t, useI18n } from '../i18n';

const sourceKey = {
  builtin: 'commandsCard.source.builtin',
  global: 'commandsCard.source.global',
  repo: 'commandsCard.source.repo',
  project: 'commandsCard.source.project',
} as const satisfies Record<CommandEntry['source'], string>;
const modeKey = {
  fast: 'commandsCard.mode.fast',
  balanced: 'commandsCard.mode.balanced',
  deep: 'commandsCard.mode.deep',
} as const satisfies Record<CommandMode, string>;

/** commandFieldsError in the UI locale: the shared function returns the server's pt-BR text. */
function fieldsError(fields: { name: string; description: string; template: string }) {
  const problem = commandFieldsError(fields);
  if (problem === COMMAND_MESSAGES.name) return t('commandsCard.error.name');
  if (problem === COMMAND_RESERVED) return t('commandsCard.error.reserved');
  if (problem === COMMAND_MESSAGES.description)
    return t('commandsCard.error.description', { max: COMMAND_DESCRIPTION_MAX });
  if (problem === COMMAND_MESSAGES.template) return t('commandsCard.error.template', { max: COMMAND_TEMPLATE_MAX });
  return problem;
}

interface Draft {
  id?: string;
  name: string;
  description: string;
  template: string;
  mode: CommandMode | '';
  /** '' = global; otherwise the project id. Fixed once the command exists. */
  scope: string;
}

/**
 * "Comandos" card in Settings: user commands (global or per project) can be created,
 * edited and deleted; built-ins and repository files are listed read-only.
 */
export function CommandsCard({ projects, project }: { projects: Project[]; project?: Project }) {
  const { t, tRich } = useI18n();
  const [viewProject, setViewProject] = useState(project?.id ?? '');
  const [list, setList] = useState<CommandList | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  const formId = useId();

  const reload = useCallback(async () => {
    try {
      setList(await api.commands(viewProject || null));
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, [viewProject]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const startNew = () => {
    setFormError('');
    setDraft({ name: '', description: '', template: '', mode: '', scope: viewProject });
  };
  const startEdit = (command: CommandEntry) => {
    setFormError('');
    setDraft({
      id: command.id,
      name: command.name,
      description: command.description,
      template: command.template,
      mode: command.mode ?? '',
      scope: command.projectId ?? '',
    });
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const problem = fieldsError(draft);
    if (problem) return setFormError(problem);
    setSaving(true);
    try {
      const fields = { name: draft.name, description: draft.description.trim(), template: draft.template };
      if (draft.id) await api.updateCommand(draft.id, { ...fields, mode: draft.mode || null });
      else
        await api.createCommand({
          ...fields,
          ...(draft.mode ? { mode: draft.mode } : {}),
          projectId: draft.scope || null,
        });
      setDraft(null);
      await reload();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function remove(id: string) {
    setConfirmDelete('');
    try {
      await api.deleteCommand(id);
      await reload();
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }
  const scopeName = (id: string) => projects.find((p) => p.id === id)?.name ?? t('commandsCard.projectFallback');

  return (
    <section className="settings-card commands-card" aria-labelledby={`${formId}-title`}>
      <div className="settings-card-heading">
        <div className="settings-card-icon blue">
          <Terminal size={17} />
        </div>
        <div>
          <h2 id={`${formId}-title`}>{t('commandsCard.title')}</h2>
          <p>
            {tRich('commandsCard.detail', {
              slash: <code>{t('commandsCard.slashName')}</code>,
              args: <code>{'{{args}}'}</code>,
            })}
          </p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>{t('commandsCard.view')}</strong>
          <span>{t('commandsCard.viewDetail')}</span>
        </div>
        <select
          aria-label={t('commandsCard.view')}
          value={viewProject}
          onChange={(event) => {
            setViewProject(event.target.value);
            setDraft(null);
          }}
        >
          <option value="">{t('commandsCard.globalOnly')}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {loadError && (
        <div className="inline-notice error-notice" role="alert">
          {loadError}
        </div>
      )}
      <ul className="commands-list" aria-label={t('commandsCard.list')}>
        {list?.commands.map((command) => (
          <li key={`${command.source}:${command.id}`} className={command.active ? undefined : 'shadowed'}>
            <div className="command-row-main">
              <strong>/{command.name}</strong>
              <span className="command-badge">{t(sourceKey[command.source])}</span>
              {command.mode && <span className="command-badge">{t(modeKey[command.mode])}</span>}
              {!command.active && <span className="command-badge muted">{t('commandsCard.shadowed')}</span>}
            </div>
            <span className="command-description">
              {command.description || t('commandsCard.noDescription')}
              {command.file && <> · {command.file}</>}
            </span>
            <div className="command-actions">
              {command.readOnly ? (
                <details>
                  <summary>
                    <BookOpen size={13} aria-hidden="true" /> {t('commandsCard.viewTemplate')}
                  </summary>
                  <pre>{command.template}</pre>
                </details>
              ) : confirmDelete === command.id ? (
                <>
                  <button type="button" className="danger-button" onClick={() => void remove(command.id)}>
                    {t('commandsCard.confirmDelete')}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setConfirmDelete('')}>
                    {t('commandsCard.keep')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ghost-button"
                    aria-label={t('commandsCard.editLabel', { name: command.name })}
                    onClick={() => startEdit(command)}
                  >
                    <Pencil size={13} /> {t('commandsCard.edit')}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    aria-label={t('commandsCard.deleteLabel', { name: command.name })}
                    onClick={() => setConfirmDelete(command.id)}
                  >
                    <Trash2 size={13} /> {t('commandsCard.delete')}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {list && list.issues.length > 0 && (
        <div className="command-issues" role="status">
          <strong>{t('commandsCard.issues')}</strong>
          <ul>
            {list.issues.map((issue) => (
              <li key={issue.file}>
                <code>{issue.file}</code>: {issue.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {draft ? (
        <form
          className="command-form"
          onSubmit={save}
          aria-label={draft.id ? t('commandsCard.editForm') : t('commandsCard.new')}
        >
          <div className="command-form-heading">
            <strong>{draft.id ? t('commandsCard.editLabel', { name: draft.name }) : t('commandsCard.new')}</strong>
            <button
              type="button"
              className="icon-button"
              aria-label={t('commandsCard.closeForm')}
              onClick={() => setDraft(null)}
            >
              <X size={15} />
            </button>
          </div>
          <label>
            {t('commandsCard.name')}
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })}
              placeholder={t('commandsCard.namePlaceholder')}
              maxLength={32}
              spellCheck={false}
              autoFocus
            />
          </label>
          <label>
            {t('commandsCard.description')}
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={COMMAND_DESCRIPTION_MAX}
            />
          </label>
          <label>
            {t('commandsCard.template')}
            <textarea
              value={draft.template}
              onChange={(e) => setDraft({ ...draft, template: e.target.value })}
              rows={5}
              maxLength={COMMAND_TEMPLATE_MAX}
              placeholder={t('commandsCard.templatePlaceholder')}
            />
            <small>
              {draft.template.length}/{COMMAND_TEMPLATE_MAX}
            </small>
          </label>
          <div className="command-form-row">
            <label>
              {t('commandsCard.runMode')}
              <select
                value={draft.mode}
                onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}
              >
                <option value="">{t('commandsCard.conversationMode')}</option>
                <option value="fast">{t('commandsCard.mode.fast')}</option>
                <option value="balanced">{t('commandsCard.balancedAuto')}</option>
                <option value="deep">{t('commandsCard.mode.deep')}</option>
              </select>
            </label>
            <label>
              {t('commandsCard.scope')}
              <select
                value={draft.scope}
                disabled={Boolean(draft.id)}
                onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
              >
                <option value="">{t('commandsCard.scopeGlobal')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t('commandsCard.scopeProject', { name: p.name })}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {formError && (
            <div className="form-error" role="alert">
              {formError}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => setDraft(null)}>
              {t('commandsCard.cancel')}
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {draft.id
                ? t('commandsCard.save')
                : draft.scope
                  ? t('commandsCard.createIn', { project: scopeName(draft.scope) })
                  : t('commandsCard.createGlobal')}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="secondary-button" onClick={startNew}>
          <Plus size={15} /> {t('commandsCard.new')}
        </button>
      )}
    </section>
  );
}
