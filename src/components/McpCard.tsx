import { Pencil, Plus, Server, ShieldAlert, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { Project } from '../../shared/contracts';
import {
  MCP_ARG_MAX,
  MCP_DESCRIPTION_MAX,
  MCP_SECRET_MASK,
  MCP_WARNING,
  mcpFieldsError,
  mcpLines,
  type McpEnvSource,
  type McpServerView,
  type ProjectMcpReport,
} from '../../shared/mcp';
import { api } from '../api';

const providerName: Record<string, string> = { codex: 'Codex', kiro: 'Kiro', claude: 'Claude', opencode: 'OpenCode' };

interface EnvDraft {
  name: string;
  from: McpEnvSource;
  value: string;
  /** A literal already stored on the server (its value is never sent back). */
  stored: boolean;
}
interface Draft {
  id?: string;
  name: string;
  description: string;
  command: string;
  args: string;
  env: EnvDraft[];
  tools: string;
}

const emptyDraft = (): Draft => ({ name: '', description: '', command: '', args: '', env: [], tools: '' });

/**
 * "Servidores MCP" in Settings (docs/specs/mcp-catalog.md): the catalog (opt-in, empty by
 * default), the selected project's toggles and which servers each provider would use.
 */
export function McpCard({
  project,
  onProjectUpdated,
}: {
  project?: Project;
  onProjectUpdated: (project: Project) => void;
}) {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [report, setReport] = useState<ProjectMcpReport | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [toggling, setToggling] = useState(false);
  const titleId = useId();
  const projectId = project?.id;

  const reload = useCallback(async () => {
    try {
      const [list, projectReport] = await Promise.all([
        api.mcpServers(),
        projectId ? api.projectMcp(projectId) : Promise.resolve(null),
      ]);
      setServers(list.servers);
      setReport(projectReport);
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const startEdit = (server: McpServerView) => {
    setFormError('');
    setDraft({
      id: server.id,
      name: server.name,
      description: server.description,
      command: server.command,
      args: server.args.join('\n'),
      env: server.env.map((item) => ({ name: item.name, from: item.from, value: '', stored: Boolean(item.set) })),
      tools: (server.tools ?? []).join('\n'),
    });
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const fields = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      command: draft.command.trim(),
      args: draft.args.split('\n').filter((line) => line.trim() !== ''),
      env: draft.env.map((item) => ({
        name: item.name.trim(),
        from: item.from,
        ...(item.from === 'literal' && item.value ? { value: item.value } : {}),
        stored: item.stored,
      })),
      tools: mcpLines(draft.tools),
    };
    const problem = mcpFieldsError(fields);
    if (problem) return setFormError(problem);
    setSaving(true);
    try {
      const body = {
        name: fields.name,
        description: fields.description,
        command: fields.command,
        args: fields.args,
        env: fields.env.map(({ stored: _stored, ...item }) => item),
      };
      if (draft.id) await api.updateMcpServer(draft.id, { ...body, tools: fields.tools.length ? fields.tools : null });
      else await api.createMcpServer({ ...body, ...(fields.tools.length ? { tools: fields.tools } : {}) });
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
      await api.deleteMcpServer(id);
      await reload();
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }
  async function toggle(id: string, on: boolean) {
    if (!project) return;
    const current = project.enabledMcp ?? [];
    const enabled = on ? [...current, id] : current.filter((item) => item !== id);
    setToggling(true);
    try {
      const result = await api.setProjectMcp(project.id, enabled);
      onProjectUpdated(result.project);
      setReport(result.report);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setToggling(false);
    }
  }
  const setEnv = (index: number, patch: Partial<EnvDraft>) =>
    draft && setDraft({ ...draft, env: draft.env.map((item, i) => (i === index ? { ...item, ...patch } : item)) });

  return (
    <section className="settings-card mcp-card" aria-labelledby={titleId}>
      <div className="settings-card-heading">
        <div className="settings-card-icon amber">
          <Server size={17} />
        </div>
        <div>
          <h2 id={titleId}>Servidores MCP</h2>
          <p>
            Catálogo local, desligado por padrão. Cada projeto escolhe quais servidores usar; conversas avulsas nunca
            usam MCP. Somente servidores locais (stdio) nesta versão.
          </p>
        </div>
      </div>
      <div className="mcp-warning" role="note">
        <ShieldAlert size={15} aria-hidden="true" />
        <span>
          {MCP_WARNING}. As chamadas de ferramentas continuam pedindo aprovação; nada é aprovado automaticamente.
        </span>
      </div>
      {loadError && (
        <div className="inline-notice error-notice" role="alert">
          {loadError}
        </div>
      )}
      {servers && servers.length === 0 && <p className="muted-empty">Nenhum servidor MCP cadastrado.</p>}
      <ul className="mcp-list" aria-label="Servidores MCP cadastrados">
        {servers?.map((server) => {
          const enabled = project?.enabledMcp?.includes(server.id) ?? false;
          return (
            <li key={server.id}>
              <div className="mcp-row-main">
                <strong>{server.name}</strong>
                <span className="command-badge">stdio</span>
                {server.tools?.length ? (
                  <span className="command-badge">
                    {server.tools.length}{' '}
                    {server.tools.length === 1 ? 'ferramenta permitida' : 'ferramentas permitidas'}
                  </span>
                ) : null}
              </div>
              <span className="mcp-detail">{server.description || 'Sem descrição.'}</span>
              <code className="mcp-command">{[server.command, ...server.args].join(' ')}</code>
              {server.env.length > 0 && (
                <span className="mcp-detail">
                  Variáveis:{' '}
                  {server.env
                    .map((item) =>
                      item.from === 'literal'
                        ? `${item.name}=${MCP_SECRET_MASK}`
                        : `${item.name} (do ambiente do Adelic)`,
                    )
                    .join(', ')}
                </span>
              )}
              <div className="mcp-actions">
                {project && (
                  <button
                    type="button"
                    className={`toggle small ${enabled ? 'on' : ''}`}
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`Usar ${server.name} em ${project.name}`}
                    disabled={toggling}
                    onClick={() => void toggle(server.id, !enabled)}
                  >
                    <span />
                  </button>
                )}
                {confirmDelete === server.id ? (
                  <>
                    <button type="button" className="danger-button" onClick={() => void remove(server.id)}>
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
                      aria-label={`Editar ${server.name}`}
                      onClick={() => startEdit(server)}
                    >
                      <Pencil size={13} /> Editar
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label={`Excluir ${server.name}`}
                      onClick={() => setConfirmDelete(server.id)}
                    >
                      <Trash2 size={13} /> Excluir
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {project && report && (
        <div className="mcp-report" aria-label={`Servidores MCP por agente em ${project.name}`} role="group">
          <strong>Em {project.name}, por agente</strong>
          <ul>
            {report.providers.map((provider) => (
              <li key={provider.providerId}>
                <span className="mcp-report-name">{providerName[provider.providerId] ?? provider.providerId}</span>
                <span>{provider.servers.length ? provider.servers.join(', ') : 'nenhum'}</span>
                <small>{provider.detail}</small>
              </li>
            ))}
          </ul>
          {report.servers
            .filter((server) => !server.commandFound || server.missingEnv.length)
            .map((server) => (
              <p className="mcp-detail" key={server.id}>
                {server.name}:{' '}
                {[
                  server.commandFound ? '' : 'comando não encontrado',
                  server.missingEnv.length
                    ? `variáveis ausentes no ambiente do Adelic: ${server.missingEnv.join(', ')}`
                    : '',
                ]
                  .filter(Boolean)
                  .join('; ')}
              </p>
            ))}
          <small className="mcp-detail">
            O Kiro pode carregar outros servidores da própria configuração; o Adelic isola o KIRO_HOME e bloqueia a
            execução quando o Kiro relata um servidor fora da lista, mas depende desse relato.
          </small>
        </div>
      )}
      {draft ? (
        <form
          className="command-form mcp-form"
          onSubmit={save}
          aria-label={draft.id ? 'Editar servidor MCP' : 'Novo servidor MCP'}
        >
          <div className="command-form-heading">
            <strong>{draft.id ? `Editar ${draft.name}` : 'Novo servidor MCP'}</strong>
            <button type="button" className="icon-button" aria-label="Fechar formulário" onClick={() => setDraft(null)}>
              <X size={15} />
            </button>
          </div>
          <label>
            Nome
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase() })}
              placeholder="ex.: docs-locais"
              maxLength={48}
              spellCheck={false}
              autoFocus
            />
          </label>
          <label>
            Descrição
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              maxLength={MCP_DESCRIPTION_MAX}
            />
          </label>
          <label>
            Comando
            <input
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="/usr/bin/meu-servidor ou um nome do PATH"
              spellCheck={false}
            />
            <small>Um nome do PATH é trocado pelo caminho absoluto ao salvar.</small>
          </label>
          <label>
            Argumentos (um por linha)
            <textarea
              value={draft.args}
              onChange={(e) => setDraft({ ...draft, args: e.target.value })}
              rows={3}
              spellCheck={false}
              maxLength={20 * (MCP_ARG_MAX + 1)}
            />
          </label>
          <fieldset className="mcp-env">
            <legend>Variáveis de ambiente</legend>
            {draft.env.map((item, index) => (
              <div className="mcp-env-row" key={index}>
                <input
                  aria-label={`Nome da variável ${index + 1}`}
                  value={item.name}
                  onChange={(e) => setEnv(index, { name: e.target.value })}
                  placeholder="NOME"
                  spellCheck={false}
                />
                <select
                  aria-label={`Origem da variável ${index + 1}`}
                  value={item.from}
                  onChange={(e) => setEnv(index, { from: e.target.value as McpEnvSource, value: '' })}
                >
                  <option value="adelic-env">Repassar do Adelic</option>
                  <option value="literal">Valor fixo</option>
                </select>
                {item.from === 'literal' && (
                  <input
                    type="password"
                    aria-label={`Valor da variável ${index + 1}`}
                    value={item.value}
                    onChange={(e) => setEnv(index, { value: e.target.value })}
                    placeholder={item.stored ? `${MCP_SECRET_MASK} (manter)` : 'valor'}
                    autoComplete="off"
                  />
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remover variável ${index + 1}`}
                  onClick={() => setDraft({ ...draft, env: draft.env.filter((_, i) => i !== index) })}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="ghost-button"
              onClick={() =>
                setDraft({ ...draft, env: [...draft.env, { name: '', from: 'adelic-env', value: '', stored: false }] })
              }
            >
              <Plus size={13} /> Adicionar variável
            </button>
            <small>Prefira repassar o nome de uma variável do Adelic. Valores fixos não são exibidos depois.</small>
          </fieldset>
          <label>
            Ferramentas permitidas (uma por linha; vazio = todas)
            <textarea
              value={draft.tools}
              onChange={(e) => setDraft({ ...draft, tools: e.target.value })}
              rows={2}
              spellCheck={false}
            />
          </label>
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
              {draft.id ? 'Salvar servidor' : 'Criar servidor'}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setFormError('');
            setDraft(emptyDraft());
          }}
        >
          <Plus size={15} /> Novo servidor MCP
        </button>
      )}
    </section>
  );
}
