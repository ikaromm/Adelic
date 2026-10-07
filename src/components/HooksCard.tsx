import { CheckCircle2, LoaderCircle, Play, Plus, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Project } from '../../shared/contracts';
import {
  BLOCKED_COMMANDS_MAX,
  BLOCKED_PATTERN_MAX,
  HOOK_CHECKS_MAX,
  HOOK_COMMAND_MAX,
  HOOK_NAME_MAX,
  HOOK_TIMEOUT_DEFAULT,
  HOOK_TIMEOUT_MAX,
  HOOK_TIMEOUT_MIN,
  checkHeadline,
  type CheckResult,
  type ProjectHooks,
} from '../../shared/hooks';
import { api } from '../api';

interface CheckDraft {
  name: string;
  command: string;
  timeoutSec: string;
  enabled: boolean;
}
const toDraft = (hooks: ProjectHooks) => ({
  checks: hooks.afterEdit.map((c) => ({ ...c, timeoutSec: String(c.timeoutSec) })),
  blocked: hooks.blockedCommands.join('\n'),
  autoFix: hooks.autoFix,
});

/** First problem with the form, or '' (the API checks again). */
function draftError(checks: CheckDraft[], blocked: string[]) {
  for (const [i, check] of checks.entries()) {
    const n = i + 1;
    if (!check.name.trim() || check.name.length > HOOK_NAME_MAX)
      return `Verificação ${n}: nome obrigatório (até ${HOOK_NAME_MAX} caracteres)`;
    if (!check.command.trim() || check.command.length > HOOK_COMMAND_MAX)
      return `Verificação ${n}: comando obrigatório (até ${HOOK_COMMAND_MAX} caracteres)`;
    const timeout = Number(check.timeoutSec);
    if (!Number.isInteger(timeout) || timeout < HOOK_TIMEOUT_MIN || timeout > HOOK_TIMEOUT_MAX)
      return `Verificação ${n}: tempo limite de ${HOOK_TIMEOUT_MIN} a ${HOOK_TIMEOUT_MAX} segundos`;
  }
  if (blocked.length > BLOCKED_COMMANDS_MAX) return `Até ${BLOCKED_COMMANDS_MAX} comandos bloqueados`;
  if (blocked.some((p) => p.length > BLOCKED_PATTERN_MAX))
    return `Cada padrão bloqueado tem até ${BLOCKED_PATTERN_MAX} caracteres`;
  return '';
}

/**
 * "Verificações e bloqueios" (docs/specs/project-hooks.md): after-edit checks and blocked
 * commands of one project, saved only in Adelic, never read from the repository.
 */
export function HooksCard({ project }: { project: Project }) {
  const id = useId();
  const [loaded, setLoaded] = useState<ProjectHooks | null>(null);
  const [checks, setChecks] = useState<CheckDraft[]>([]);
  const [blocked, setBlocked] = useState('');
  const [autoFix, setAutoFix] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, CheckResult | string>>({});

  useEffect(() => {
    let live = true;
    api
      .projectHooks(project.id)
      .then((hooks) => {
        if (!live) return;
        const draft = toDraft(hooks);
        setLoaded(hooks);
        setChecks(draft.checks);
        setBlocked(draft.blocked);
        setAutoFix(draft.autoFix);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [project.id]);

  const patterns = blocked
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const current: ProjectHooks = {
    afterEdit: checks.map((c) => ({
      name: c.name.trim(),
      command: c.command.trim(),
      timeoutSec: Number(c.timeoutSec),
      enabled: c.enabled,
    })),
    blockedCommands: [...new Set(patterns)],
    autoFix,
  };
  const dirty = loaded !== null && JSON.stringify(current) !== JSON.stringify(loaded);

  const edit = (index: number, patch: Partial<CheckDraft>) => {
    setSaved('');
    setChecks((list) => list.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    const problem = draftError(checks, current.blockedCommands);
    if (problem) return setError(problem);
    setSaving(true);
    setError('');
    try {
      const next = await api.saveProjectHooks(project.id, current);
      const draft = toDraft(next);
      setLoaded(next);
      setChecks(draft.checks);
      setBlocked(draft.blocked);
      setAutoFix(draft.autoFix);
      setResults({});
      setSaved('Verificações e bloqueios salvos.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function test(index: number) {
    setTesting(index);
    setResults((r) => ({ ...r, [index]: '' }));
    try {
      const result = await api.testProjectHook(project.id, index);
      setResults((r) => ({ ...r, [index]: result }));
    } catch (e) {
      setResults((r) => ({ ...r, [index]: (e as Error).message }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <section className="settings-card hooks-card" aria-labelledby={`${id}-title`}>
      <div className="settings-card-heading">
        <div className="settings-card-icon green">
          <ShieldCheck size={17} />
        </div>
        <div>
          <h2 id={`${id}-title`}>Verificações e bloqueios</h2>
          <p>
            {project.name} · as verificações rodam depois de uma execução que alterou arquivos, no mesmo sandbox dos
            agentes e sem rede. Ficam só no Adelic; nada é lido do repositório.
          </p>
        </div>
      </div>
      {!loaded && !error && <p className="hooks-loading">Carregando…</p>}
      {loaded && (
        <form onSubmit={save} aria-label="Verificações e bloqueios do projeto">
          <h3 className="hooks-subtitle">Verificar depois de alterações</h3>
          {checks.length === 0 && <p className="hooks-empty">Nenhuma verificação. Ex.: testes ou typecheck.</p>}
          <ol className="hooks-checks">
            {checks.map((check, index) => {
              const result = results[index];
              const savedCheck = loaded.afterEdit[index];
              const unsaved =
                !savedCheck ||
                savedCheck.command !== check.command.trim() ||
                savedCheck.timeoutSec !== Number(check.timeoutSec);
              return (
                <li key={index} aria-label={`Verificação ${index + 1}`}>
                  <div className="hooks-check-row">
                    <label>
                      Nome
                      <input
                        value={check.name}
                        maxLength={HOOK_NAME_MAX}
                        onChange={(e) => edit(index, { name: e.target.value })}
                        placeholder="testes"
                      />
                    </label>
                    <label className="hooks-timeout">
                      Tempo limite (s)
                      <input
                        type="number"
                        min={HOOK_TIMEOUT_MIN}
                        max={HOOK_TIMEOUT_MAX}
                        value={check.timeoutSec}
                        onChange={(e) => edit(index, { timeoutSec: e.target.value })}
                      />
                    </label>
                  </div>
                  <label>
                    Comando
                    <input
                      className="hooks-command"
                      value={check.command}
                      maxLength={HOOK_COMMAND_MAX}
                      spellCheck={false}
                      onChange={(e) => edit(index, { command: e.target.value })}
                      placeholder="npm test"
                    />
                  </label>
                  <div className="hooks-check-actions">
                    <label className="hooks-inline">
                      <input
                        type="checkbox"
                        checked={check.enabled}
                        onChange={(e) => edit(index, { enabled: e.target.checked })}
                      />
                      Ativa
                    </label>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={testing !== null || unsaved}
                      title={unsaved ? 'Salve antes de testar' : undefined}
                      aria-label={`Testar ${check.name || `verificação ${index + 1}`}`}
                      onClick={() => void test(index)}
                    >
                      {testing === index ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />} Testar
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label={`Remover ${check.name || `verificação ${index + 1}`}`}
                      onClick={() => {
                        setSaved('');
                        setResults({});
                        setChecks((list) => list.filter((_, i) => i !== index));
                      }}
                    >
                      <Trash2 size={13} /> Remover
                    </button>
                  </div>
                  {typeof result === 'string' && result && (
                    <div className="form-error" role="alert">
                      {result}
                    </div>
                  )}
                  {typeof result === 'object' && (
                    <details className={`hooks-result ${result.status === 'passed' ? 'passed' : 'failed'}`} open>
                      <summary role="status">
                        {result.status === 'passed' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                        {checkHeadline(result)}
                      </summary>
                      <pre>{result.output || result.detail || 'Sem saída.'}</pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ol>
          {checks.length < HOOK_CHECKS_MAX && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setSaved('');
                setChecks((list) => [
                  ...list,
                  { name: '', command: '', timeoutSec: String(HOOK_TIMEOUT_DEFAULT), enabled: true },
                ]);
              }}
            >
              <Plus size={15} /> Adicionar verificação
            </button>
          )}
          <div className="setting-row">
            <div>
              <strong>Corrigir automaticamente</strong>
              <span>Se uma verificação falhar, pede uma correção ao agente uma vez, na mesma conversa.</span>
            </div>
            <button
              type="button"
              className={`toggle ${autoFix ? 'on' : ''}`}
              role="switch"
              aria-checked={autoFix}
              aria-label="Corrigir automaticamente"
              onClick={() => {
                setSaved('');
                setAutoFix((value) => !value);
              }}
            >
              <span />
            </button>
          </div>
          <label className="hooks-blocked">
            <span className="hooks-subtitle">Comandos bloqueados</span>
            <textarea
              value={blocked}
              rows={4}
              spellCheck={false}
              onChange={(e) => {
                setSaved('');
                setBlocked(e.target.value);
              }}
              placeholder={'git push*\nrm -rf *'}
            />
            <small>
              Um padrão por linha (até {BLOCKED_COMMANDS_MAX}); <code>*</code> vale qualquer texto. O pedido de
              aprovação de um comando que combine é negado, mesmo no modo automático. Só acrescenta restrições.
            </small>
          </label>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {saved && (
            <div className="hooks-saved" role="status">
              {saved}
            </div>
          )}
          <div className="modal-actions">
            <button type="submit" className="primary-button" disabled={saving || !dirty}>
              {saving && <LoaderCircle className="spin" size={15} />} Salvar verificações
            </button>
          </div>
        </form>
      )}
      {!loaded && error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
