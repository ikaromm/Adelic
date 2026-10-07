import { useRef } from 'react';
import { FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import type { AttachmentMeta } from '../../shared/contracts';
import { IMAGE_MIMES, MAX_ATTACHMENTS_PER_MESSAGE, formatBytes } from '../../shared/attachments';
import { api } from '../api';
import type { PendingAttachment } from '../hooks/useComposerAttachments';
import { useI18n } from '../i18n';

// Accept list for the file picker; the shared rules still decide (some text files have no extension).
const ACCEPT = [
  ...IMAGE_MIMES,
  'text/*',
  '.md,.json,.yaml,.yml,.toml,.ts,.tsx,.js,.jsx,.py,.rs,.go,.sh,.sql,.css,.html',
].join(',');

/** Paperclip button that opens the file picker. */
export function AttachButton({
  disabled,
  full,
  onFiles,
}: {
  disabled: boolean;
  full: boolean;
  onFiles: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const label = full ? t('attachments.full', { max: MAX_ATTACHMENTS_PER_MESSAGE }) : t('attachments.attach');
  return (
    <>
      <button
        type="button"
        className="composer-pill attach-button"
        aria-label={label}
        title={label}
        disabled={disabled || full}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={15} aria-hidden="true" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
    </>
  );
}

/** Chips for the attachments waiting to be sent, with thumbnails and remove buttons. */
export function PendingAttachments({
  items,
  disabled,
  onRemove,
}: {
  items: PendingAttachment[];
  disabled: boolean;
  onRemove: (key: string) => void;
}) {
  const { t, locale } = useI18n();
  if (!items.length) return null;
  return (
    <ul className="attachment-chips composer-attachments" aria-label={t('attachments.pending')}>
      {items.map((item) => (
        <li key={item.key} className={`attachment-chip ${item.meta ? '' : 'uploading'}`}>
          {item.previewUrl ? (
            <img className="attachment-thumb" src={item.previewUrl} alt="" />
          ) : (
            <FileText className="attachment-icon" size={16} aria-hidden="true" />
          )}
          <span className="attachment-text">
            <span className="attachment-name" title={item.name}>
              {item.name}
            </span>
            <small>{item.meta ? formatBytes(item.size, locale) : t('attachments.uploading')}</small>
          </span>
          {!item.meta && <LoaderCircle className="spin" size={13} aria-label={t('attachments.uploadingLabel')} />}
          <button
            type="button"
            className="icon-button attachment-remove"
            aria-label={t('attachments.remove', { name: item.name })}
            title={t('attachments.removeTitle')}
            disabled={disabled}
            onClick={() => onRemove(item.key)}
          >
            <X size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Attachments shown in a sent user message: thumbnails for images, chips for files. */
export function MessageAttachments({ attachments }: { attachments: AttachmentMeta[] }) {
  const { t, locale } = useI18n();
  return (
    <ul className="attachment-chips message-attachments" aria-label={t('attachments.sent')}>
      {attachments.map((attachment) => {
        const url = api.attachmentUrl(attachment.id);
        const image = attachment.mime.startsWith('image/');
        return (
          <li key={attachment.id} className={`attachment-chip ${image ? 'image' : ''}`}>
            {image ? (
              <img className="attachment-thumb large" src={url} alt={attachment.name} loading="lazy" />
            ) : (
              <>
                <FileText className="attachment-icon" size={16} aria-hidden="true" />
                <span className="attachment-text">
                  <span className="attachment-name" title={attachment.name}>
                    {attachment.name}
                  </span>
                  <small>{formatBytes(attachment.size, locale)}</small>
                </span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
