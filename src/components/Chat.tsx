import { useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeftRight,
  ArrowRightLeft,
  ChevronDown,
  Code2,
  FileText,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import type { Bootstrap, DelegatedTask, Message, ModelRef, Run, SessionDetail } from '../../shared/contracts';
import { isCapacityFailure } from '../../shared/model-fallback';
import { CopyButton, Markdown } from '../Markdown';
import { formatCost, formatDuration, formatTokens } from '../format';
import { taskRoleName, taskStatusName, timeLabel } from '../labels';
import { thinkingLabel } from '../reasoning';
import {
  actionNeedsDisclosure,
  activityForRun,
  activityIsVisible,
  commandPreview,
  commandTitle,
  runStatusLabel,
  statusLabel,
} from '../run-activity';
import { useNow } from '../useNow';
import { COMPACTING_TEXT } from '../../shared/compaction';
import { MessageAttachments } from './ComposerAttachments';
import { RunChanges } from './RunChanges';
import { mentionSegments } from '../../shared/mentions';

/** User text with `@file` mentions shown as chips; the text itself is unchanged. */
function UserText({ content }: { content: string }) {
  return mentionSegments(content).map((segment, index) =>
    segment.mention ? (
      <span key={index} className="mention-chip" title={segment.mention}>
        {segment.text}
      </span>
    ) : (
      segment.text
    ),
  );
}

export function MessageCard({
  message,
  providerName,
  body,
  actions,
  editor,
}: {
  message: Message;
  providerName: string;
  /** Replaces the rendered answer (plan mode shows the plan card instead of its Markdown). */
  body?: ReactNode;
  /** Extra hover/focus actions next to "Copiar" (edit, branch). */
  actions?: ReactNode;
  /** Replaces a user message's bubble while it is being edited. */
  editor?: ReactNode;
}) {
  if (message.handoff) return <HandoffCard message={message} />;
  if (message.role === 'user')
    return (
      <div className={`message-row user-row ${editor ? 'editing' : ''}`.trim()}>
        {editor ?? (
          <>
            {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
            <div className="user-bubble">
              <UserText content={message.content} />
            </div>
            <div className="message-meta">
              <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
              <CopyButton text={message.content} label="Copiar mensagem" />
              {actions}
            </div>
          </>
        )}
      </div>
    );
  const content =
    message.content || (message.status === 'failed' ? 'A execução falhou antes de gerar uma resposta.' : '');
  return (
    <div className="message-row assistant-row">
      <div className="message-author">
        <span className="assistant-glyph" aria-hidden="true">
          <Sparkles size={12} />
        </span>
        <strong>{providerName}</strong>
        {message.route && (
          <span className="route-pill" title={message.route.reason}>
            {message.route.level === 'fast' ? 'Rápido' : 'Completo'} · Thinking {thinkingLabel(message.route.effort)}
          </span>
        )}
        <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
      </div>
      {body ?? (content && <Markdown>{content}</Markdown>)}
      {message.status === 'failed' && (
        <div className="message-error">
          <X size={13} /> Execução falhou
        </div>
      )}
      {(message.content || actions) && (
        <div className="message-actions">
          {message.content && <CopyButton text={message.content} label="Copiar resposta" />}
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * "Passagem para <Agente>": the summary carried to the new provider (docs/specs/provider-handoff.md).
 * Collapsed by default; the header says who wrote it and whether it is the local fallback.
 */
export function HandoffCard({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const handoff = message.handoff!;
  const bodyId = `handoff-${message.id}`;
  const source =
    handoff.source === 'model'
      ? `Resumo escrito por ${handoff.fromName}`
      : handoff.fallback
        ? `Resumo local: ${handoff.fallback}`
        : 'Resumo local, sem chamada de modelo';
  return (
    <section className="message-row handoff-card" aria-label={`Passagem para ${handoff.toName}`}>
      <button
        type="button"
        className="handoff-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="handoff-icon" aria-hidden="true">
          <ArrowRightLeft size={14} />
        </span>
        <span className="handoff-heading">
          <strong>
            Passagem para {handoff.toName}
            {handoff.toModel ? ` · ${handoff.toModel}` : ''}
          </strong>
          <small className={handoff.fallback ? 'handoff-fallback' : undefined}>
            Resumo levado para {handoff.toName} · {source}
          </small>
        </span>
        <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
        <ChevronDown size={14} className={open ? 'chevron open' : 'chevron'} aria-hidden="true" />
      </button>
      {open && (
        <div className="handoff-body" id={bodyId}>
          <Markdown>{message.content}</Markdown>
          <div className="message-actions">
            <CopyButton text={message.content} label="Copiar resumo" />
          </div>
        </div>
      )}
    </section>
  );
}

export function RunActivityPanel({
  runId,
  run,
  tasks,
  events,
  providers,
  active,
  taskOutputs,
  loadingTaskOutputs,
  onLoadTaskOutput,
  busy = false,
}: {
  runId: string;
  run?: Run;
  tasks: DelegatedTask[];
  events: SessionDetail['events'];
  providers: Bootstrap['providers'];
  active: boolean;
  taskOutputs: Record<string, string | null>;
  loadingTaskOutputs: Set<string>;
  onLoadTaskOutput: (task: DelegatedTask) => Promise<void>;
  /** A run is active in this conversation: undo is disabled meanwhile. */
  busy?: boolean;
}) {
  const activity = activityForRun(runId, tasks, events);
  const runStatus = run?.status;
  const running = runStatus === 'running' || (!runStatus && active);
  const now = useNow(1000, running);
  const outcome = runStatusLabel(runStatus) || (active ? 'Em andamento' : null);
  const changes = run && <RunChanges run={run} busy={busy || active} />;
  if (!activityIsVisible(activity) && !outcome)
    return run?.checkpoint?.files?.length ? (
      <section className={`run-activity ${run.status}`} aria-label="Atividade desta execução">
        {changes}
      </section>
    ) : null;
  const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : Number.NaN;
  const elapsed = formatDuration(
    running ? (Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : undefined) : run?.durationMs,
  );
  const tone = running ? 'running' : runStatus || 'completed';
  const headline = running
    ? elapsed
      ? `Trabalhando · ${elapsed}`
      : 'Trabalhando'
    : tone === 'completed'
      ? elapsed
        ? `Trabalhou por ${elapsed}`
        : 'Atividade'
      : `${outcome}${elapsed ? ` após ${elapsed}` : ''}`;
  const totalTokens =
    run && (run.inputTokens != null || run.outputTokens != null)
      ? formatTokens((run.inputTokens ?? 0) + (run.outputTokens ?? 0))
      : undefined;
  const lastRetry = activity.retries.at(-1);
  // Automatic compaction runs before the answer starts (docs/specs/compaction.md).
  const compacting = running && activity.events.at(-1)?.text === COMPACTING_TEXT;
  const counts = [
    compacting ? COMPACTING_TEXT : '',
    running && lastRetry ? `tentativa ${lastRetry.attempt}/${lastRetry.of}` : '',
    !running && activity.retries.length
      ? `${activity.retries.length} ${activity.retries.length === 1 ? 'nova tentativa' : 'novas tentativas'}`
      : '',
    activity.fallbacks.length ? 'modelo trocado' : '',
    activity.tasks.length ? `${activity.tasks.length} ${activity.tasks.length === 1 ? 'tarefa' : 'tarefas'}` : '',
    activity.actions.length ? `${activity.actions.length} ${activity.actions.length === 1 ? 'ação' : 'ações'}` : '',
    !running && totalTokens ? `${totalTokens} tokens` : '',
    !running ? (formatCost(run?.costUsd) ?? '') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const icon = running ? (
    <LoaderCircle className="spin" size={14} />
  ) : tone === 'completed' ? (
    <Activity size={14} />
  ) : (
    <X size={14} />
  );
  return (
    <section className={`run-activity ${tone}`} aria-label="Atividade desta execução">
      {activity.errors.map((event) => (
        <RunEventRow key={event.id} event={event} />
      ))}
      {activityIsVisible(activity) ? (
        <details className="activity-details">
          <summary>
            <span className="activity-icon" aria-hidden="true">
              {icon}
            </span>
            <span className="activity-headline">{headline}</span>
            {counts && <span className="activity-counts">{counts}</span>}
            <ChevronDown className="activity-chevron" size={14} aria-hidden="true" />
          </summary>
          <div className="run-activity-content">
            {activity.tasks.map((task) => {
              const hasCachedOutput = Object.hasOwn(taskOutputs, task.id);
              const loadingOutput = loadingTaskOutputs.has(task.id);
              return (
                <article className="activity-task" key={task.id}>
                  <div className="activity-task-heading">
                    <i className={`run-status-dot ${task.status}`} aria-hidden="true" />
                    <strong>{task.title}</strong>
                    <span className="activity-task-status">{taskStatusName(task.status)}</span>
                  </div>
                  <div className="activity-meta">
                    {taskRoleName(task.role)} ·{' '}
                    {providers.find((item) => item.id === task.providerId)?.name || task.providerId}
                    {task.model ? ` / ${task.model}` : ''}
                    {task.effort ? ` · Thinking ${thinkingLabel(task.effort)}` : ''}
                  </div>
                  {task.summary && (
                    <details className="activity-summary">
                      <summary>Ver resumo</summary>
                      <p>{task.summary}</p>
                    </details>
                  )}
                  {task.scope.length > 0 && (
                    <div className="activity-scope">
                      Escopo: {task.scope.slice(0, 3).join(' · ')}
                      {task.scope.length > 3 ? ` · +${task.scope.length - 3}` : ''}
                    </div>
                  )}
                  {hasCachedOutput ? (
                    <details className="activity-output">
                      <summary>Ver saída completa</summary>
                      <pre>{taskOutputs[task.id] || 'Saída vazia.'}</pre>
                    </details>
                  ) : task.status !== 'running' && task.status !== 'queued' ? (
                    <button
                      className="task-output-button"
                      onClick={() => void onLoadTaskOutput(task)}
                      disabled={loadingOutput}
                    >
                      {loadingOutput ? <LoaderCircle className="spin" size={12} /> : <FileText size={12} />}
                      {loadingOutput ? 'Carregando saída…' : 'Carregar saída completa'}
                    </button>
                  ) : null}
                </article>
              );
            })}
            {activity.actions.map((event) =>
              actionNeedsDisclosure(event) ? (
                <details className="activity-command" key={event.id}>
                  <summary>
                    <Code2 size={13} aria-hidden="true" />
                    <span className="visually-hidden">{commandTitle(event.toolName)}: </span>
                    <code className="command-preview">{commandPreview(event.text)}</code>
                    <span className={`activity-action-status ${event.status || ''}`}>{statusLabel(event.status)}</span>
                    <time>{timeLabel(event.createdAt)}</time>
                  </summary>
                  <pre>{event.text}</pre>
                </details>
              ) : (
                <div className="activity-action" key={event.id}>
                  <Code2 size={13} aria-hidden="true" />
                  <span>{event.text}</span>
                  <small className={`activity-action-status ${event.status || ''}`}>{statusLabel(event.status)}</small>
                </div>
              ),
            )}
            {activity.fallbacks.map((event) => (
              <div className="activity-event fallback" key={event.id} title={event.error}>
                <ArrowLeftRight size={13} aria-hidden="true" />
                <span>{event.text}</span>
                <time>{timeLabel(event.createdAt)}</time>
              </div>
            ))}
            {activity.retries.map((event) => (
              <div className="activity-event retry" key={event.id} title={event.error}>
                <RotateCcw size={13} aria-hidden="true" />
                <span>{event.text}</span>
                <time>{timeLabel(event.createdAt)}</time>
              </div>
            ))}
            {activity.events.map((event) => (
              <div className="activity-event" key={event.id}>
                <Activity size={13} aria-hidden="true" />
                <span>{event.text}</span>
                <time>{timeLabel(event.createdAt)}</time>
              </div>
            ))}
          </div>
        </details>
      ) : (
        <div className="run-progress">
          <span className="activity-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="activity-headline">{headline}</span>
          {running && (
            <span className="activity-counts">
              {compacting
                ? COMPACTING_TEXT
                : lastRetry
                  ? `tentativa ${lastRetry.attempt}/${lastRetry.of}`
                  : 'Preparando resposta'}
            </span>
          )}
        </div>
      )}
      {changes}
    </section>
  );
}

/**
 * Shown under a failed answer: why it failed, whether retrying may help, and a button. When the
 * model was overloaded or rate limited it also offers up to three other models.
 */
export function RetryNotice({
  run,
  disabled,
  onRetry,
  alternatives = [],
  onSwitch,
}: {
  run?: Run;
  disabled: boolean;
  onRetry: () => void;
  /** Other models to try, with their labels ("Codex · GPT-6 Luna"). */
  alternatives?: { ref: Required<ModelRef>; label: string }[];
  onSwitch?: (target: Required<ModelRef>) => void;
}) {
  const failure = run?.failure;
  const offerSwitch = Boolean(onSwitch && alternatives.length && isCapacityFailure(failure));
  const retries = run?.retries ?? 0;
  const detail = [
    failure?.reason && `Motivo: ${failure.reason}`,
    retries > 0 && `${retries} ${retries === 1 ? 'nova tentativa automática' : 'novas tentativas automáticas'}`,
    failure?.why,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`retry-notice ${failure?.retryable === false ? 'permanent' : ''}`} role="status">
      <span>
        {failure?.retryable === false
          ? 'Repetir provavelmente não resolve; confira a configuração ou o pedido.'
          : 'Falha temporária. Você pode tentar de novo.'}
        {detail && <small>{detail}</small>}
      </span>
      <div className="retry-actions">
        <button type="button" className="secondary-button" onClick={onRetry} disabled={disabled}>
          <RotateCcw size={14} /> Tentar de novo
        </button>
        {offerSwitch && (
          <details className="retry-switch">
            <summary className="secondary-button" aria-disabled={disabled}>
              <ArrowLeftRight size={14} /> Tentar com outro modelo
            </summary>
            <ul aria-label="Outros modelos">
              {alternatives.map((item) => (
                <li key={`${item.ref.providerId}:${item.ref.model}`}>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={disabled}
                    onClick={() => onSwitch?.(item.ref)}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

export function RunEventRow({ event }: { event: SessionDetail['events'][number] }) {
  return (
    <div className="run-event error">
      <span className="run-event-icon" aria-hidden="true">
        <X size={12} />
      </span>
      <span>{event.text}</span>
      <time>{timeLabel(event.createdAt)}</time>
    </div>
  );
}
