import { useState } from 'react';
import { Check, FileText, GitBranch, Pencil, X } from 'lucide-react';
import type { AttachmentMeta, Message, Session } from '../../shared/contracts';
import { formatBytes } from '../../shared/attachments';
import { api } from '../api';
import { useI18n } from '../i18n';

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
  const { t } = useI18n();
  const branchBusy = message.status === 'running';
  return (
    <>
      {message.role === 'user' && (
        <button
          type="button"
          className="copy-button message-action"
          aria-label={t('branch.edit')}
          title={disabledReason ?? t('branch.editTitle')}
          disabled={Boolean(disabledReason)}
          onClick={onEdit}
        >
          <Pencil size={14} />
        </button>
      )}
      <button
        type="button"
        className="copy-button message-action"
        aria-label={t('branch.branch')}
        title={branchBusy ? t('branch.branchBusy') : t('branch.branchTitle')}
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
  const { t, locale } = useI18n();
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
  return (
    <div className="message-editor">
      <textarea
        className="message-editor-input"
        value={draft}
        aria-label={t('branch.input')}
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
        <ul className="attachment-chips message-editor-attachments" aria-label={t('branch.attachments')}>
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
                <small>{formatBytes(attachment.size, locale)}</small>
              </span>
              <button
                type="button"
                className="icon-button attachment-remove"
                aria-label={t('branch.removeAttachment', { name: attachment.name })}
                title={t('branch.remove')}
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
        <div className="message-editor-confirm" role="alertdialog" aria-label={t('branch.confirm')}>
          <span>{t('branch.confirmText', { count: laterCount })}</span>
          <div className="message-editor-actions">
            <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={saving}>
              {t('branch.back')}
            </button>
            <button type="button" className="danger-button" onClick={() => void save()} disabled={blocked}>
              <Check size={14} /> {t('branch.discardResend')}
            </button>
          </div>
        </div>
      ) : (
        <div className="message-editor-actions">
          {disabledReason && <small className="message-editor-hint">{disabledReason}</small>}
          <button type="button" className="ghost-button" onClick={onCancel} disabled={saving}>
            {t('branch.cancel')}
          </button>
          <button type="button" className="primary-button" onClick={request} disabled={blocked}>
            <Check size={14} /> {t('branch.saveResend')}
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
  const { t } = useI18n();
  const origin = session.branchedFrom && sessions.find((item) => item.id === session.branchedFrom?.sessionId);
  if (!origin) return null;
  return (
    <button
      type="button"
      className="link-button branch-origin"
      title={t('branch.originTitle', { title: origin.title })}
      onClick={() => onOpen(origin.id)}
    >
      <GitBranch size={13} aria-hidden="true" />
      <span>{t('branch.origin', { title: origin.title })}</span>
    </button>
  );
}
