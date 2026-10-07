import { BookOpen, Pencil, Plus, Terminal, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  COMMAND_DESCRIPTION_MAX,
  COMMAND_TEMPLATE_MAX,
  commandFieldsError,
  type CommandEntry,
  type CommandList,
  type CommandMode,
} from '../../shared/commands';
import type { Project } from '../../shared/contracts';
import { api } from '../api';

const sourceLabel: Record<CommandEntry['source'], string> = {
  builtin: 'Embutido',
  global: 'Global',
  repo: 'Do repositório',
  project: 'Do projeto',
};
const modeLabel: Record<CommandMode, string> = { fast: 'Rápido', balanced: 'Equilibrado', deep: 'Completo' };

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
    const problem = commandFieldsError(draft);
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
  const scopeName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'projeto';

  return (
    <section className="settings-card commands-card" aria-labelledby={`${formId}-title`}>
      <div className="settings-card-heading">
        <div className="settings-card-icon blue">
          <Terminal size={17} />
        </div>
        <div>
          <h2 id={`${formId}-title`}>Comandos</h2>
          <p>
            Digite <code>/nome</code> no início da mensagem. O texto depois do nome entra no lugar de{' '}
            <code>{'{{args}}'}</code>. Ordem: projeto, repositório, global e embutido.
          </p>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <strong>Ver comandos de</strong>
          <span>Comandos do repositório vêm de .adelic/commands/*.md e só podem ser lidos aqui.</span>
        </div>
        <select
          aria-label="Ver comandos de"
          value={viewProject}
          onChange={(event) => {
            setViewProject(event.target.value);
            setDraft(null);
          }}
        >
          <option value="">Somente globais</option>
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
      <ul className="commands-list" aria-label="Comandos disponíveis">
        {list?.commands.map((command) => (
          <li key={`${command.source}:${command.id}`} className={command.active ? undefined : 'shadowed'}>
            <div className="command-row-main">
              <strong>/{command.name}</strong>
              <span className="command-badge">{sourceLabel[command.source]}</span>
              {command.mode && <span className="command-badge">{modeLabel[command.mode]}</span>}
              {!command.active && <span className="command-badge muted">Substituído</span>}
            </div>
            <span className="command-description">
              {command.description || 'Sem descrição.'}
              {command.file && <> · {command.file}</>}
            </span>
            <div className="command-actions">
              {command.readOnly ? (
                <details>
                  <summary>
                    <BookOpen size={13} aria-hidden="true" /> Ver modelo
                  </summary>
                  <pre>{command.template}</pre>
                </details>
              ) : confirmDelete === command.id ? (
                <>
                  <button type="button" className="danger-button" onClick={() => void remove(command.id)}>
                    Confirmar exclusão
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setConfirmDelete('')}>
                    Manter
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ghost-button"
                    aria-label={`Editar /${command.name}`}
                    onClick={() => startEdit(command)}
                  >
                    <Pencil size={13} /> Editar
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    aria-label={`Excluir /${command.name}`}
                    onClick={() => setConfirmDelete(command.id)}
                  >
                    <Trash2 size={13} /> Excluir
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {list && list.issues.length > 0 && (
        <div className="command-issues" role="status">
          <strong>Arquivos ignorados</strong>
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
        <form className="command-form" onSubmit={save} aria-label={draft.id ? 'Editar comando' : 'Novo comando'}>
          <div className="command-form-heading">
            <strong>{draft.id ? `Editar /${draft.name}` : 'Novo comando'}</strong>
            <button type="button" className="icon-button" aria-label="Fechar formulário" onClick={() => setDraft(null)}>
              <X size={15} />
            </button>
          </div>
          <label>
            Nome
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })}
              placeholder="ex.: revisar-pr"
              maxLength={32}
              spellCheck={false}
              autoFocus
            />
          </label>
          <label>
            Descrição
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={COMMAND_DESCRIPTION_MAX}
            />
          </label>
          <label>
            Modelo
            <textarea
              value={draft.template}
              onChange={(e) => setDraft({ ...draft, template: e.target.value })}
              rows={5}
              maxLength={COMMAND_TEMPLATE_MAX}
              placeholder="Revise {{args}} e aponte problemas concretos."
            />
            <small>
              {draft.template.length}/{COMMAND_TEMPLATE_MAX}
            </small>
          </label>
          <div className="command-form-row">
            <label>
              Modo nesta execução
              <select
                value={draft.mode}
                onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}
              >
                <option value="">Modo da conversa</option>
                <option value="fast">Rápido</option>
                <option value="balanced">Equilibrado (Auto)</option>
                <option value="deep">Completo</option>
              </select>
            </label>
            <label>
              Escopo
              <select
                value={draft.scope}
                disabled={Boolean(draft.id)}
                onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
              >
                <option value="">Global</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    Projeto: {p.name}
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
              Cancelar
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {draft.id ? 'Salvar comando' : `Criar comando ${draft.scope ? `em ${scopeName(draft.scope)}` : 'global'}`}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="secondary-button" onClick={startNew}>
          <Plus size={15} /> Novo comando
        </button>
      )}
    </section>
  );
}
