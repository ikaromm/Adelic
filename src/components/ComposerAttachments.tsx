import { useRef } from 'react';
import { FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import type { AttachmentMeta } from '../../shared/contracts';
import { IMAGE_MIMES, MAX_ATTACHMENTS_PER_MESSAGE, formatBytes } from '../../shared/attachments';
import { api } from '../api';
import type { PendingAttachment } from '../hooks/useComposerAttachments';

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
  const input = useRef<HTMLInputElement>(null);
  const label = full ? `Limite de ${MAX_ATTACHMENTS_PER_MESSAGE} anexos por mensagem` : 'Anexar arquivos ou imagens';
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
  if (!items.length) return null;
  return (
    <ul className="attachment-chips composer-attachments" aria-label="Anexos da mensagem">
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
            <small>{item.meta ? formatBytes(item.size) : 'Enviando…'}</small>
          </span>
          {!item.meta && <LoaderCircle className="spin" size={13} aria-label="Enviando" />}
          <button
            type="button"
            className="icon-button attachment-remove"
            aria-label={`Remover anexo ${item.name}`}
            title="Remover"
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
  return (
    <ul className="attachment-chips message-attachments" aria-label="Anexos">
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
                  <small>{formatBytes(attachment.size)}</small>
                </span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
