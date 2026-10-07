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

type PlansApi = ReturnType<typeof usePlans>;

const planStatusLabel: Record<Plan['status'], string> = {
  draft: 'Rascunho',
  approved: 'Aprovado',
  executing: 'Executando',
  done: 'Concluído',
  rejected: 'Descartado',
};
export const planTaskStatusLabel: Record<PlanTask['status'], string> = {
  pending: 'Pendente',
  running: 'Em execução',
  done: 'Concluída',
  failed: 'Falhou',
  skipped: 'Pulada',
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
  const finished = plan.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  return plan.tasks.length
    ? `${finished} de ${plan.tasks.length} ${plan.tasks.length === 1 ? 'tarefa concluída' : 'tarefas concluídas'}`
    : '';
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan.markdown);
  const [pending, setPending] = useState('');
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [savedNote, setSavedNote] = useState('');
  const closed = plan.status === 'rejected';
  const executing = plan.status === 'executing';
  const locked = busy || executing || Boolean(pending);
  const runnable = plan.tasks.some((t) => t.status === 'pending' || t.status === 'failed');
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
      if (result) setSavedNote(`Salvo em ${result.path}`);
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
            <span className={`plan-status-badge ${plan.status}`}>{planStatusLabel[plan.status]}</span>
            {planProgress(plan) && <span>{planProgress(plan)}</span>}
          </span>
        </div>
        {!closed && !editing && (
          <button
            type="button"
            className="icon-button"
            aria-label="Editar plano"
            title="Editar o Markdown do plano"
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
            Markdown do plano
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
          <p className="plan-hint">
            Use as seções “## Requisitos”, “## Design” e “## Tarefas”, com tarefas no formato <code>- [ ] …</code>.
            Tarefas que não mudarem mantêm o estado.
          </p>
          <div className="plan-actions">
            <button type="button" className="secondary-button" onClick={() => setEditing(false)}>
              <X size={14} /> Cancelar
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
              {pending === 'edit' ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Salvar plano
            </button>
          </div>
        </div>
      ) : (
        <div className="plan-body">
          {plan.requirements && (
            <details className="plan-section" open={plan.status === 'draft'}>
              <summary>Requisitos</summary>
              <Markdown>{plan.requirements}</Markdown>
            </details>
          )}
          {plan.design && (
            <details className="plan-section" open={plan.status === 'draft'}>
              <summary>Design</summary>
              <Markdown>{plan.design}</Markdown>
            </details>
          )}
          <div className="plan-section plan-tasks-section">
            <h3 className="plan-section-title">Tarefas</h3>
            {plan.tasks.length ? (
              <ol className="plan-tasks" aria-label="Tarefas do plano">
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
                Não encontrei tarefas; edite o plano.
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
                Para depois da tarefa atual.
              </span>
            ) : (
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(pending)}
                onClick={() => void run('stop', () => api.stop(plan.id))}
              >
                <CircleStop size={14} /> Parar após a tarefa atual
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
                    {plan.status === 'draft' ? 'Aprovar e executar' : 'Continuar execução'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => void run('next', () => api.approve(plan.id, 'next'))}
                  >
                    <StepForward size={14} /> Executar só a próxima tarefa
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
                  <FileDown size={14} /> Salvar no projeto
                </button>
              )}
              {plan.status !== 'done' && (
                <button
                  type="button"
                  className="ghost-button plan-discard"
                  disabled={locked}
                  onClick={() => void run('discard', () => api.discard(plan.id))}
                >
                  <Trash2 size={14} /> Descartar
                </button>
              )}
            </>
          )}
        </div>
      )}
      {confirmOverwrite && (
        <div className="plan-confirm" role="alertdialog" aria-label="Substituir arquivo do plano?">
          <span>
            <strong>O arquivo já existe no projeto.</strong>
            <small>Substituir apaga o conteúdo atual dele.</small>
          </span>
          <div className="plan-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirmOverwrite(false)}>
              Manter o arquivo
            </button>
            <button type="button" className="danger-button" disabled={Boolean(pending)} onClick={() => void save(true)}>
              Substituir
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
  const Icon = taskIcon[task.status];
  return (
    <li className={`plan-task ${task.status}`}>
      <Icon
        className={`plan-task-icon ${task.status === 'running' ? 'spin' : ''}`}
        size={15}
        role="img"
        aria-label={planTaskStatusLabel[task.status]}
      />
      <div className="plan-task-text">
        <span>
          <span className="visually-hidden">Tarefa {position}: </span>
          {task.text}
        </span>
        {task.details && <small className="plan-task-details">{task.details}</small>}
        {task.error && task.status !== 'done' && <small className="plan-task-error">{task.error}</small>}
      </div>
      {(task.status === 'pending' || task.status === 'failed') && (
        <button
          type="button"
          className="icon-button"
          aria-label={`Pular tarefa ${position}`}
          title="Pular esta tarefa"
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
          aria-label={`Voltar a tarefa ${position} para pendente`}
          title="Voltar para pendente"
          disabled={disabled}
          onClick={() => onStatus('pending')}
        >
          <RotateCcw size={14} />
        </button>
      )}
    </li>
  );
}
