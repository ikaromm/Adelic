import { useState } from 'react';
import { Check, CornerDownRight, ListPlus, Paperclip, Pencil, Play, X, Zap } from 'lucide-react';
import type { QueuedMessage } from '../../shared/contracts';
import { queuePauseLabel, type useMessageQueue } from '../hooks/useMessageQueue';
import { useI18n } from '../i18n';

type QueueApi = ReturnType<typeof useMessageQueue>;

/**
 * Messages waiting for the agent, shown above the composer: edit, remove, send now
 * (interrupts, after confirmation) and, when the agent supports it, steer the turn.
 */
export function MessageQueue({
  queue: api,
  running,
  canSteer,
  onSentNow,
}: {
  queue: QueueApi;
  running: boolean;
  /** The conversation's agent accepts input during a turn (capabilities.steer). */
  canSteer: boolean;
  /** Called after "Enviar agora" of composer text was accepted, to clear the draft. */
  onSentNow: () => void;
}) {
  const { t } = useI18n();
  const queue = api.queue;
  const items = queue?.items ?? [];
  const confirming = api.confirming;
  if (!items.length && !confirming) return null;
  const confirmingItem =
    confirming && 'itemId' in confirming ? items.find((item) => item.id === confirming.itemId) : undefined;
  const confirmingText = confirming ? ('content' in confirming ? confirming.content : confirmingItem?.content) : '';
  return (
    <section className="message-queue" aria-label={t('queue.label')}>
      {items.length > 0 && (
        <div className="message-queue-header">
          <span className="message-queue-title">
            <ListPlus size={14} aria-hidden="true" /> {t('queue.title', { count: items.length })}
          </span>
          {queue?.paused ? (
            <span className="message-queue-paused" role="status">
              <strong>{t('queue.paused')}</strong> {queuePauseLabel(queue)}
            </span>
          ) : (
            <span className="message-queue-hint">{running ? t('queue.hint.running') : t('queue.hint.starting')}</span>
          )}
          {queue?.paused?.reason === 'limit' && (
            <button type="button" className="secondary-button" onClick={() => void api.resume(true)}>
              {t('queue.continueAnyway')}
            </button>
          )}
          {queue?.paused && (
            <button type="button" className="secondary-button" onClick={() => void api.resume()}>
              <Play size={13} /> {t('queue.resume')}
            </button>
          )}
        </div>
      )}
      {items.length > 0 && (
        <ol className="message-queue-list">
          {items.map((item, index) => (
            <QueueChip key={item.id} item={item} position={index + 1} running={running} canSteer={canSteer} api={api} />
          ))}
        </ol>
      )}
      {confirming && confirmingText !== undefined && (
        <div className="message-queue-confirm" role="alertdialog" aria-label={t('queue.confirm')}>
          <span>
            <strong>{t('queue.confirmTitle')}</strong>
            <small>{preview(confirmingText, 120)}</small>
          </span>
          <div className="message-queue-confirm-actions">
            <button type="button" className="secondary-button" onClick={() => api.askSendNow(null)}>
              {t('queue.keepWaiting')}
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() =>
                void api.sendNow(confirming).then((result) => {
                  if (result && 'content' in confirming) onSentNow();
                })
              }
            >
              <Zap size={13} /> {t('queue.interruptSend')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function QueueChip({
  item,
  position,
  running,
  canSteer,
  api,
}: {
  item: QueuedMessage;
  position: number;
  running: boolean;
  canSteer: boolean;
  api: QueueApi;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const save = async () => {
    const content = draft.trim();
    if (!content) return;
    if (content !== item.content && !(await api.edit(item.id, content))) return;
    setEditing(false);
  };
  if (editing)
    return (
      <li className="queue-chip editing">
        <textarea
          className="queue-chip-input"
          value={draft}
          aria-label={t('queue.edit', { position })}
          autoFocus
          rows={2}
          maxLength={32000}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save();
            }
            if (event.key === 'Escape') {
              event.stopPropagation();
              setDraft(item.content);
              setEditing(false);
            }
          }}
        />
        <div className="queue-chip-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t('queue.cancelEdit')}
            title={t('queue.cancelEditTitle')}
            onClick={() => {
              setDraft(item.content);
              setEditing(false);
            }}
          >
            <X size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('queue.save')}
            title={t('queue.saveTitle')}
            disabled={!draft.trim()}
            onClick={() => void save()}
          >
            <Check size={14} />
          </button>
        </div>
      </li>
    );
  return (
    <li className="queue-chip">
      <span className="queue-chip-position" aria-hidden="true">
        {position}
      </span>
      <span className="queue-chip-text" title={item.content}>
        {preview(item.content, 160)}
      </span>
      {item.attachments?.length ? (
        <span
          className="queue-chip-attachments"
          title={item.attachments.map((a) => a.name).join(', ')}
          aria-label={t('queue.attachments', { count: item.attachments.length })}
        >
          <Paperclip size={12} aria-hidden="true" />
          {item.attachments.length}
        </span>
      ) : null}
      <div className="queue-chip-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={t('queue.edit', { position })}
          title={t('queue.editTitle')}
          onClick={() => {
            setDraft(item.content);
            setEditing(true);
          }}
        >
          <Pencil size={13} />
        </button>
        {running && canSteer && !item.attachments?.length && (
          <button
            type="button"
            className="icon-button"
            aria-label={t('queue.steer', { position })}
            title={t('queue.steerTitle')}
            onClick={() => void api.steer(item.id)}
          >
            <CornerDownRight size={13} />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={t('queue.sendNow', { position })}
          title={running ? t('queue.sendNowRunningTitle') : t('queue.sendNowTitle')}
          onClick={() => (running ? api.askSendNow({ itemId: item.id }) : void api.sendNow({ itemId: item.id }))}
        >
          <Zap size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t('queue.remove', { position })}
          title={t('queue.removeTitle')}
          onClick={() => void api.remove(item.id)}
        >
          <X size={14} />
        </button>
      </div>
    </li>
  );
}

function preview(text: string, max: number) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
