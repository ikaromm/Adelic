import { useCallback, useState } from 'react';
import type { AttachmentMeta, Message, Plan, Session } from '../../shared/contracts';
import { api, type ApiError } from '../api';
import { isLimitError } from './useUsage';
import { uuid } from '../uuid';

/**
 * Edit and resend, and "Ramificar daqui" for the open conversation (docs/specs/edit-branch.md).
 * Holds which message is being edited; the server owns the result and the caller reloads.
 */
export function useEditBranch({
  session,
  messages,
  plans,
  busy,
  onError,
  onLimit,
  onEdited,
  onBranched,
}: {
  session: Session | undefined;
  messages: Message[];
  plans: Plan[];
  busy: boolean;
  onError: (message: string) => void;
  /** A usage limit refused the edit; `retry` repeats it with "Continuar mesmo assim". */
  onLimit?: (error: ApiError, retry: () => Promise<unknown>) => void;
  /** The edit was accepted: drop the discarded messages locally and reload the conversation. */
  onEdited: (sessionId: string, keep: Message[], started: { runId: string; messageId: string }) => void;
  /** The branch was created: add it to the list and open it. */
  onBranched: (created: Session) => void;
}) {
  const [editingId, setEditingId] = useState<string>();
  const sessionId = session?.id;
  // Same refusals as the server (409), so the button explains instead of failing.
  const disabledReason = session?.activeRunId
    ? 'Aguarde a execução terminar ou cancele antes de editar'
    : plans.some((plan) => plan.status === 'executing')
      ? 'Um plano está em execução; pare o plano antes de editar'
      : busy
        ? 'Aguarde a ação em andamento'
        : undefined;

  const save = useCallback(
    async function save(
      message: Message,
      content: string,
      attachments: AttachmentMeta[],
      overrideLimit = false,
    ): Promise<boolean> {
      if (!sessionId) return false;
      try {
        const started = await api.editMessage(
          sessionId,
          message.id,
          content,
          uuid(),
          attachments.map((item) => item.id),
          overrideLimit,
        );
        setEditingId(undefined);
        const index = messages.findIndex((item) => item.id === message.id);
        onEdited(sessionId, index < 0 ? messages : messages.slice(0, index), started);
        return true;
      } catch (error) {
        if (isLimitError(error) && onLimit) onLimit(error, () => save(message, content, attachments, true));
        else onError((error as Error).message);
        return false;
      }
    },
    [sessionId, messages, onEdited, onError, onLimit],
  );

  const branch = useCallback(
    async (message: Message) => {
      if (!sessionId) return;
      try {
        onBranched(await api.branch(sessionId, message.id));
      } catch (error) {
        onError((error as Error).message);
      }
    },
    [sessionId, onBranched, onError],
  );

  return {
    editingId: editingId && messages.some((item) => item.id === editingId) ? editingId : undefined,
    disabledReason,
    startEditing: (id: string) => setEditingId(id),
    cancelEditing: () => setEditingId(undefined),
    laterCount: (id: string) => {
      const index = messages.findIndex((item) => item.id === id);
      return index < 0 ? 0 : messages.length - index - 1;
    },
    save,
    branch,
  };
}
