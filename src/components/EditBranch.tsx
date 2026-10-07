import { useState } from 'react';
import { Check, FileText, GitBranch, Pencil, X } from 'lucide-react';
import type { AttachmentMeta, Message, Session } from '../../shared/contracts';
import { formatBytes } from '../../shared/attachments';
import { api } from '../api';

// Edit and resend a user message, and branch a conversation (docs/specs/edit-branch.md).

/** Hover/focus actions of a message: "Editar" (user messages) and "Ramificar daqui". */
export function MessageEditActions({
  message,
  disabledReason,
  onEdit,
  onBranch,
}: {
  message: Message;
  /** Why editing is unavailable right now (a run or plan in progress); undefined when it is. */
  disabledReason?: string;
  onEdit: () => void;
  onBranch: () => void;
}) {
  const branchBusy = message.status === 'running';
  return (
    <>
      {message.role === 'user' && (
        <button
          type="button"
          className="copy-button message-action"
          aria-label="Editar"
          title={disabledReason ?? 'Editar e reenviar'}
          disabled={Boolean(disabledReason)}
          onClick={onEdit}
        >
          <Pencil size={14} />
        </button>
      )}
      <button
        type="button"
        className="copy-button message-action"
        aria-label="Ramificar daqui"
        title={branchBusy ? 'Aguarde a resposta terminar' : 'Ramificar daqui: nova conversa até esta mensagem'}
        disabled={branchBusy}
        onClick={onBranch}
      >
        <GitBranch size={14} />
      </button>
    </>
  );
}

/**
 * Inline editor that replaces a user bubble. Saving discards every later message, so it
 * asks first when there are any. Attachments can be removed, not added.
 */
export function MessageEditor({
  message,
  laterCount,
  disabledReason,
  onCancel,
  onSave,
}: {
  message: Message;
  /** Messages after this one that saving would discard. */
  laterCount: number;
  disabledReason?: string;
  onCancel: () => void;
  /** Resolves true when the server accepted the edit. */
  onSave: (content: string, attachments: AttachmentMeta[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(message.content);
  const [kept, setKept] = useState<AttachmentMeta[]>(message.attachments ?? []);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const content = draft.trim();
  const blocked = !content || saving || Boolean(disabledReason);
  const save = async () => {
    if (blocked) return;
    setSaving(true);
    const ok = await onSave(content, kept);
    setSaving(false);
    if (!ok) setConfirming(false);
  };
  const request = () => {
    if (blocked) return;
    if (laterCount > 0) setConfirming(true);
    else void save();
  };
  const plural = laterCount === 1 ? 'a mensagem seguinte' : `as ${laterCount} mensagens seguintes`;
  return (
    <div className="message-editor">
      <textarea
        className="message-editor-input"
        value={draft}
        aria-label="Editar mensagem"
        autoFocus
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        maxLength={32000}
        onChange={(event) => {
          setDraft(event.target.value);
          setConfirming(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            request();
          }
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {kept.length > 0 && (
        <ul className="attachment-chips message-editor-attachments" aria-label="Anexos da mensagem">
          {kept.map((attachment) => (
            <li key={attachment.id} className="attachment-chip">
              {attachment.mime.startsWith('image/') ? (
                <img className="attachment-thumb" src={api.attachmentUrl(attachment.id)} alt="" />
              ) : (
                <FileText className="attachment-icon" size={16} aria-hidden="true" />
              )}
              <span className="attachment-text">
                <span className="attachment-name" title={attachment.name}>
                  {attachment.name}
                </span>
                <small>{formatBytes(attachment.size)}</small>
              </span>
              <button
                type="button"
                className="icon-button attachment-remove"
                aria-label={`Remover anexo ${attachment.name}`}
                title="Remover"
                disabled={saving}
                onClick={() => setKept((list) => list.filter((item) => item.id !== attachment.id))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {confirming ? (
        <div className="message-editor-confirm" role="alertdialog" aria-label="Confirmar edição">
          <span>
            Reenviar descarta {plural} desta conversa. O agente recomeça com o histórico anterior a esta mensagem.
          </span>
          <div className="message-editor-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={saving}>
              Voltar
            </button>
            <button type="button" className="danger-button" onClick={() => void save()} disabled={blocked}>
              <Check size={14} /> Descartar e reenviar
            </button>
          </div>
        </div>
      ) : (
        <div className="message-editor-actions">
          {disabledReason && <small className="message-editor-hint">{disabledReason}</small>}
          <button type="button" className="ghost-button" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className="primary-button" onClick={request} disabled={blocked}>
            <Check size={14} /> Salvar e reenviar
          </button>
        </div>
      )}
    </div>
  );
}

/** Header link to the conversation a branch was copied from, while it still exists. */
export function BranchOrigin({
  session,
  sessions,
  onOpen,
}: {
  session: Session;
  sessions: Session[];
  onOpen: (id: string) => void;
}) {
  const origin = session.branchedFrom && sessions.find((item) => item.id === session.branchedFrom?.sessionId);
  if (!origin) return null;
  return (
    <button
      type="button"
      className="link-button branch-origin"
      title={`Abrir a conversa original: ${origin.title}`}
      onClick={() => onOpen(origin.id)}
    >
      <GitBranch size={13} aria-hidden="true" />
      <span>Ramo de {origin.title}</span>
    </button>
  );
}
