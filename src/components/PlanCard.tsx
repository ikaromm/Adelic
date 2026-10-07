import { useState } from 'react';
import {
  Check,
  CircleStop,
  ClipboardList,
  FileDown,
  LoaderCircle,
  Pencil,
  Play,
  RotateCcw,
  Square,
  SquareCheck,
  SquareMinus,
  SquareX,
  StepForward,
  Trash2,
  X,
} from 'lucide-react';
import type { Plan, PlanTask } from '../../shared/contracts';
import { Markdown } from '../Markdown';
import type { usePlans } from '../hooks/usePlans';
import { t, useI18n, type MessageKey } from '../i18n';

type PlansApi = ReturnType<typeof usePlans>;

const planStatusLabel: Record<Plan['status'], MessageKey> = {
  draft: 'plans.status.draft',
  approved: 'plans.status.approved',
  executing: 'plans.status.executing',
  done: 'plans.status.done',
  rejected: 'plans.status.rejected',
};
const planTaskStatusLabel: Record<PlanTask['status'], MessageKey> = {
  pending: 'plans.task.pending',
  running: 'plans.task.running',
  done: 'plans.task.done',
  failed: 'plans.task.failed',
  skipped: 'plans.task.skipped',
};
const taskIcon: Record<PlanTask['status'], typeof Square> = {
  pending: Square,
  running: LoaderCircle,
  done: SquareCheck,
  failed: SquareX,
  skipped: SquareMinus,
};

/** Counts for the card header ("1 de 2 tarefas concluídas"). */
export function planProgress(plan: Plan) {
  const finished = plan.tasks.filter((task) => task.status === 'done' || task.status === 'skipped').length;
  return plan.tasks.length ? t('plans.progress', { finished, count: plan.tasks.length }) : '';
}

/**
 * A plan written by a read-only planning run (docs/specs/plan-mode.md): requirements, design
 * and the task checklist, editable as Markdown, with approve / next task / discard / save.
 */
export function PlanCard({
  plan,
  api,
  busy,
  canSave,
}: {
  plan: Plan;
  api: PlansApi;
  /** A run is active in this conversation: only "stop after the current task" is available. */
  busy: boolean;
  /** The conversation is linked to a project (saving needs a project folder). */
  canSave: boolean;
}) {
  const { t, tRich } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan.markdown);
  const [pending, setPending] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const closed = plan.status === 'rejected';
  const executing = plan.status === 'executing';
  const locked = busy || executing || Boolean(pending);
  const runnable = plan.tasks.some((task) => task.status === 'pending' || task.status === 'failed');
  const titleId = `plan-${plan.id}-title`;
  const run = async (key: string, work: () => Promise<unknown>) => {
    setPending(key);
    try {
      await work();
    } finally {
      setPending('');
    }
  };
  const save = (overwrite: boolean) =>
    run('save', async () => {
      const result = await api.save(plan.id, overwrite);
      if (result === 'exists') return setConfirmOverwrite(true);
      setConfirmOverwrite(false);
      if (result) setSavedNote(t('plans.savedAt', { path: result.path }));
    });
  return (
    <section className={`plan-card ${plan.status}`} aria-labelledby={titleId}>
      <header className="plan-card-header">
        <span className="plan-card-icon" aria-hidden="true">
          <ClipboardList size={15} />
        </span>
        <div className="plan-card-heading">
          <strong id={titleId}>{plan.title}</strong>
          <span className="plan-card-meta">
            <span className={`plan-status-badge ${plan.status}`}>{t(planStatusLabel[plan.status])}</span>
            {planProgress(plan) && <span>{planProgress(plan)}</span>}
          </span>
        </div>
        {!closed && !editing && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('plans.edit')}
            title={t('plans.editTitle')}
            disabled={locked}
            onClick={() => {
              setDraft(plan.markdown);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
          </button>
        )}
      </header>

      {editing ? (
        <div className="plan-editor">
          <label className="visually-hidden" htmlFor={`plan-${plan.id}-markdown`}>
            {t('plans.markdown')}
          </label>
          <textarea
            id={`plan-${plan.id}-markdown`}
            className="plan-editor-input"
            value={draft}
            rows={14}
            maxLength={60000}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <p className="plan-hint">{tRich('plans.editorHint', { format: <code>- [ ] …</code> })}</p>
          <div className="plan-actions">
            <button type="button" className="secondary-button" onClick={() => setEditing(false)}>
              <X size={14} /> {t('plans.cancel')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!draft.trim() || locked}
              onClick={() =>
                void run('edit', async () => {
                  if (await api.edit(plan.id, draft)) setEditing(false);
                })
              }
            >
              {pending === 'edit' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {t('plans.save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="plan-body">
          {plan.requirements && (
            <details className="plan-section" open={plan.status === 'draft'}>
              <summary>{t('plans.requirements')}</summary>
              <Markdown>{plan.requirements}</Markdown>
            </details>
          )}
          {plan.design && (
            <details className="plan-section" open={plan.status === 'draft'}>
              <summary>{t('plans.design')}</summary>
              <Markdown>{plan.design}</Markdown>
            </details>
          )}
          <div className="plan-section plan-tasks-section">
            <h3 className="plan-section-title">{t('plans.tasks')}</h3>
            {plan.tasks.length ? (
              <ol className="plan-tasks" aria-label={t('plans.tasksList')}>
                {plan.tasks.map((task, index) => (
                  <PlanTaskRow
                    key={task.id}
                    task={task}
                    position={index + 1}
                    disabled={locked || closed}
                    onStatus={(status) => void run(`task-${task.id}`, () => api.setTask(plan.id, task.id, status))}
                  />
                ))}
              </ol>
            ) : (
              <p className="plan-empty" role="status">
                {t('plans.noTasks')}
              </p>
            )}
          </div>
        </div>
      )}

      {plan.error && !editing && (
        <p className="plan-error" role="alert">
          {plan.error}
        </p>
      )}

      {!editing && !closed && (
        <div className="plan-actions">
          {executing ? (
            plan.stopRequested ? (
              <span className="plan-hint" role="status">
                {t('plans.stopping')}
              </span>
            ) : (
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(pending)}
                onClick={() => void run('stop', () => api.stop(plan.id))}
              >
                <CircleStop size={14} /> {t('plans.stop')}
              </button>
            )
          ) : (
            <>
              {runnable && (
                <>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={locked}
                    onClick={() => void run('all', () => api.approve(plan.id, 'all'))}
                  >
                    {pending === 'all' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{' '}
                    {plan.status === 'draft' ? t('plans.approve') : t('plans.continue')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => void run('next', () => api.approve(plan.id, 'next'))}
                  >
                    <StepForward size={14} /> {t('plans.next')}
                  </button>
                </>
              )}
              {canSave && plan.status !== 'draft' && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={Boolean(pending)}
                  onClick={() => void save(false)}
                >
                  <FileDown size={14} /> {t('plans.saveToProject')}
                </button>
              )}
              {plan.status !== 'done' && (
                <button
                  type="button"
                  className="ghost-button plan-discard"
                  disabled={locked}
                  onClick={() => void run('discard', () => api.discard(plan.id))}
                >
                  <Trash2 size={14} /> {t('plans.discard')}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {confirmOverwrite && (
        <div className="plan-confirm" role="alertdialog" aria-label={t('plans.overwrite')}>
          <span>
            <strong>{t('plans.overwriteTitle')}</strong>
            <small>{t('plans.overwriteHint')}</small>
          </span>
          <div className="plan-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirmOverwrite(false)}>
              {t('plans.keepFile')}
            </button>
            <button type="button" className="danger-button" disabled={Boolean(pending)} onClick={() => void save(true)}>
              {t('plans.replace')}
            </button>
          </div>
        </div>
      )}
      {savedNote && !confirmOverwrite && (
        <p className="plan-hint" role="status">
          {savedNote}
        </p>
      )}
    </section>
  );
}

function PlanTaskRow({
  task,
  position,
  disabled,
  onStatus,
}: {
  task: PlanTask;
  position: number;
  disabled: boolean;
  onStatus: (status: 'skipped' | 'pending') => void;
}) {
  const { t } = useI18n();
  const Icon = taskIcon[task.status];
  return (
    <li className={`plan-task ${task.status}`}>
      <Icon
        className={`plan-task-icon ${task.status === 'running' ? 'spin' : ''}`}
        size={15}
        role="img"
        aria-label={t(planTaskStatusLabel[task.status])}
      />
      <div className="plan-task-text">
        <span>
          <span className="visually-hidden">{t('plans.taskPosition', { position })}</span>
          {task.text}
        </span>
        {task.details && <small className="plan-task-details">{task.details}</small>}
        {task.error && task.status !== 'done' && <small className="plan-task-error">{task.error}</small>}
      </div>
      {(task.status === 'pending' || task.status === 'failed') && (
        <button
          type="button"
          className="icon-button"
          aria-label={t('plans.skip', { position })}
          title={t('plans.skipTitle')}
          disabled={disabled}
          onClick={() => onStatus('skipped')}
        >
          <SquareMinus size={14} />
        </button>
      )}
      {task.status === 'skipped' && (
        <button
          type="button"
          className="icon-button"
          aria-label={t('plans.unskip', { position })}
          title={t('plans.unskipTitle')}
          disabled={disabled}
          onClick={() => onStatus('pending')}
        >
          <RotateCcw size={14} />
        </button>
      )}
    </li>
  );
}
