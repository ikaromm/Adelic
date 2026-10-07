import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageQueue } from '../../shared/contracts';
import { api } from '../api';
import { uuid } from '../uuid';
import { t } from '../i18n';

export type SendNowTarget = { itemId: string } | { content: string; attachmentIds?: string[] };
export type ComposerKeyAction = 'send' | 'queue' | 'send-now' | null;

/**
 * What a key press in the composer does. Enter sends when idle and queues while the
 * agent works; Ctrl/Cmd+Enter sends right away (interrupting a running answer).
 * Shift+Enter and IME composition keep their usual meaning.
 */
export function composerKeyAction(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'isComposing'>,
  running: boolean,
): ComposerKeyAction {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return null;
  if (event.ctrlKey || event.metaKey) return running ? 'send-now' : 'send';
  return running ? 'queue' : 'send';
}

/** Label for why the queue stopped starting messages on its own. */
export function queuePauseLabel(queue: MessageQueue | null) {
  const reason = queue?.paused?.reason;
  if (!reason) return '';
  if (reason === 'limit') return queue?.paused?.error || t('queue.pause.limit');
  if (reason === 'cancelled') return t('queue.pause.cancelled');
  if (reason === 'interrupted') return t('queue.pause.interrupted');
  const error = queue?.paused?.error;
  return error ? t('queue.pause.failedReason', { error }) : t('queue.pause.failed');
}

/**
 * Server-side message queue of the open conversation. The server owns the queue (it
 * survives reloads and other devices); this hook mirrors it, applies `queue` stream
 * events and wraps the queue actions. Responses for another conversation are ignored.
 */
export function useMessageQueue(sessionId: string, onError: (message: string) => void) {
  const [queue, setQueue] = useState<MessageQueue | null>(null);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const requestRef = useRef(0);
  /** "Enviar agora" waiting for confirmation, since it interrupts the answer in progress. */
  const [confirming, setConfirming] = useState<SendNowTarget | null>(null);

  const apply = useCallback((next: MessageQueue) => {
    if (next.sessionId !== sessionRef.current) return;
    // A stream event is newer than any response still in flight.
    requestRef.current++;
    setQueue(next);
  }, []);

  const reload = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) return;
    const requestId = ++requestRef.current;
    try {
      const next = await api.queue(id);
      if (requestId === requestRef.current && id === sessionRef.current) setQueue(next);
    } catch {
      /* A later stream event or refresh brings the queue back. */
    }
  }, []);

  useEffect(() => {
    setQueue(null);
    setConfirming(null);
    if (sessionId) void reload();
  }, [sessionId, reload]);
  // Forget a confirmation whose item already left the queue.
  useEffect(() => {
    if (confirming && 'itemId' in confirming && queue && !queue.items.some((item) => item.id === confirming.itemId))
      setConfirming(null);
  }, [confirming, queue]);

  const run = useCallback(
    async <T>(work: (id: string) => Promise<T>): Promise<T | undefined> => {
      const id = sessionRef.current;
      if (!id) return undefined;
      try {
        const result = await work(id);
        // Responses that carry the queue are applied right away; events follow anyway.
        const carried = (result as { queue?: MessageQueue } | undefined)?.queue;
        if (carried) apply(carried);
        return result;
      } catch (error) {
        if (id === sessionRef.current) onErrorRef.current((error as Error).message);
        return undefined;
      }
    },
    [apply],
  );

  return {
    queue,
    apply,
    reload,
    confirming,
    /** Asks before interrupting; `null` dismisses the question. */
    askSendNow: setConfirming,
    add: (content: string, attachmentIds: string[] = []) =>
      run((id) => api.enqueue(id, content, uuid(), attachmentIds)),
    edit: (itemId: string, content: string) => run((id) => api.editQueued(id, itemId, content)),
    remove: (itemId: string) => run((id) => api.removeQueued(id, itemId)),
    /** With `overrideLimit` ("Continuar mesmo assim"), only the next message passes the usage limits. */
    resume: (overrideLimit = false) => run((id) => api.resumeQueue(id, overrideLimit)),
    steer: (itemId: string) => run((id) => api.steerQueued(id, itemId)),
    sendNow: (target: SendNowTarget) => {
      setConfirming(null);
      return run((id) =>
        api.sendNow(
          id,
          'itemId' in target
            ? target
            : {
                content: target.content,
                clientId: uuid(),
                ...(target.attachmentIds?.length ? { attachmentIds: target.attachmentIds } : {}),
              },
        ),
      );
    },
  };
}
