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
  type CheckResult,
  type ProjectHooks,
} from '../../shared/hooks';
import { api } from '../api';
import { t, useI18n } from '../i18n';

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
    const index = i + 1;
    if (!check.name.trim() || check.name.length > HOOK_NAME_MAX)
      return t('hooks.error.name', { index, max: HOOK_NAME_MAX });
    if (!check.command.trim() || check.command.length > HOOK_COMMAND_MAX)
      return t('hooks.error.command', { index, max: HOOK_COMMAND_MAX });
    const timeout = Number(check.timeoutSec);
    if (!Number.isInteger(timeout) || timeout < HOOK_TIMEOUT_MIN || timeout > HOOK_TIMEOUT_MAX)
      return t('hooks.error.timeout', { index, min: HOOK_TIMEOUT_MIN, max: HOOK_TIMEOUT_MAX });
  }
  if (blocked.length > BLOCKED_COMMANDS_MAX) return t('hooks.error.blockedCount', { max: BLOCKED_COMMANDS_MAX });
  if (blocked.some((p) => p.length > BLOCKED_PATTERN_MAX))
    return t('hooks.error.blockedLength', { max: BLOCKED_PATTERN_MAX });
  return '';
}

/** Test result line in the UI locale; pt-BR matches shared checkHeadline (the persisted activity text). */
export function checkResultHeadline(result: CheckResult) {
  const name = result.name;
  const seconds = result.durationMs === undefined ? undefined : Math.max(0, Math.round(result.durationMs / 1000));
  const detail = result.detail;
  switch (result.status) {
    case 'running':
      return t('hooks.result.running', { name });
    case 'passed':
      return seconds === undefined ? t('hooks.result.passed', { name }) : t('hooks.result.passedIn', { name, seconds });
    case 'failed':
      return t('hooks.result.failed', { name, code: result.exitCode ?? '?' });
    case 'timeout':
      return seconds === undefined
        ? t('hooks.result.timeout', { name })
        : t('hooks.result.timeoutIn', { name, seconds });
    case 'cancelled':
      return detail ? t('hooks.result.cancelledDetail', { name, detail }) : t('hooks.result.cancelled', { name });
    default:
      return detail ? t('hooks.result.errorDetail', { name, detail }) : t('hooks.result.error', { name });
  }
}

/**
 * "Verificações e bloqueios" (docs/specs/project-hooks.md): after-edit checks and blocked
 * commands of one project, saved only in Adelic, never read from the repository.
 */
export function HooksCard({ project }: { project: Project }) {
  const { t, tRich } = useI18n();
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
      setSaved(t('hooks.saved'));
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
          <h2 id={`${id}-title`}>{t('hooks.title')}</h2>
          <p>{t('hooks.detail', { project: project.name })}</p>
        </div>
      </div>
      {!loaded && !error && <p className="hooks-loading">{t('hooks.loading')}</p>}
      {loaded && (
        <form onSubmit={save} aria-label={t('hooks.form')}>
          <h3 className="hooks-subtitle">{t('hooks.afterEdit')}</h3>
          {checks.length === 0 && <p className="hooks-empty">{t('hooks.empty')}</p>}
          <ol className="hooks-checks">
            {checks.map((check, index) => {
              const result = results[index];
              const savedCheck = loaded.afterEdit[index];
              const unsaved =
                !savedCheck ||
                savedCheck.command !== check.command.trim() ||
                savedCheck.timeoutSec !== Number(check.timeoutSec);
              return (
                <li key={index} aria-label={t('hooks.check', { index: index + 1 })}>
                  <div className="hooks-check-row">
                    <label>
                      {t('hooks.name')}
                      <input
                        value={check.name}
                        maxLength={HOOK_NAME_MAX}
                        onChange={(e) => edit(index, { name: e.target.value })}
                        placeholder={t('hooks.namePlaceholder')}
                      />
                    </label>
                    <label className="hooks-timeout">
                      {t('hooks.timeout')}
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
                    {t('hooks.command')}
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
                      {t('hooks.enabled')}
                    </label>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={testing !== null || unsaved}
                      title={unsaved ? t('hooks.saveFirst') : undefined}
                      aria-label={t('hooks.testLabel', {
                        name: check.name || t('hooks.unnamed', { index: index + 1 }),
                      })}
                      onClick={() => void test(index)}
                    >
                      {testing === index ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}{' '}
                      {t('hooks.test')}
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      aria-label={t('hooks.removeLabel', {
                        name: check.name || t('hooks.unnamed', { index: index + 1 }),
                      })}
                      onClick={() => {
                        setSaved('');
                        setResults({});
                        setChecks((list) => list.filter((_, i) => i !== index));
                      }}
                    >
                      <Trash2 size={13} /> {t('hooks.remove')}
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
                        {checkResultHeadline(result)}
                      </summary>
                      <pre>{result.output || result.detail || t('hooks.noOutput')}</pre>
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
              <Plus size={15} /> {t('hooks.add')}
            </button>
          )}
          <div className="setting-row">
            <div>
              <strong>{t('hooks.autoFix')}</strong>
              <span>{t('hooks.autoFixDetail')}</span>
            </div>
            <button
              type="button"
              className={`toggle ${autoFix ? 'on' : ''}`}
              role="switch"
              aria-checked={autoFix}
              aria-label={t('hooks.autoFix')}
              onClick={() => {
                setSaved('');
                setAutoFix((value) => !value);
              }}
            >
              <span />
            </button>
          </div>
          <label className="hooks-blocked">
            <span className="hooks-subtitle">{t('hooks.blocked')}</span>
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
            <small>{tRich('hooks.blockedHint', { max: BLOCKED_COMMANDS_MAX, star: <code>*</code> })}</small>
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
              {saving && <LoaderCircle className="spin" size={15} />} {t('hooks.save')}
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
