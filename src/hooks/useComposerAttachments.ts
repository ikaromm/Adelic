import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { AttachmentMeta } from '../../shared/contracts';
import { MAX_ATTACHMENTS_PER_MESSAGE, checkAttachment } from '../../shared/attachments';
import { api } from '../api';
import { uuid } from '../uuid';
import { t } from '../i18n';

export interface PendingAttachment {
  key: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'text';
  /** Set once the upload finished. */
  meta?: AttachmentMeta;
  /** Local preview of an image (object URL), revoked when the chip goes away. */
  previewUrl?: string;
}

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error(t('attachments.readFailed', { name: file.name })));
    reader.readAsDataURL(file);
  });
}

/**
 * Pending attachments of each conversation's composer. Files are validated with the shared
 * rules and uploaded as soon as they are added; sending uses the ids of finished uploads.
 */
export function useComposerAttachments(sessionId: string | undefined, onError: (message: string) => void) {
  const [bySession, setBySession] = useState<Record<string, PendingAttachment[]>>({});
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef(bySession);
  stateRef.current = bySession;
  const items = (sessionId && bySession[sessionId]) || [];

  useEffect(
    () => () => {
      for (const list of Object.values(stateRef.current))
        for (const item of list) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );

  const update = useCallback((id: string, change: (list: PendingAttachment[]) => PendingAttachment[]) => {
    setBySession((current) => ({ ...current, [id]: change(current[id] || []) }));
  }, []);

  const add = useCallback(
    (files: File[]) => {
      if (!sessionId || !files.length) return;
      const current = stateRef.current[sessionId] || [];
      const room = MAX_ATTACHMENTS_PER_MESSAGE - current.length;
      const problems: string[] = [];
      if (files.length > room)
        problems.push(
          room > 0
            ? t('attachments.tooMany', { max: MAX_ATTACHMENTS_PER_MESSAGE, count: room })
            : t('attachments.noRoom', { max: MAX_ATTACHMENTS_PER_MESSAGE }),
        );
      for (const file of files.slice(0, Math.max(0, room))) {
        const check = checkAttachment(file.name, file.type, file.size);
        if (!check.ok) {
          problems.push(check.message);
          continue;
        }
        const key = uuid();
        const item: PendingAttachment = {
          key,
          name: file.name,
          mime: check.mime,
          size: file.size,
          kind: check.kind,
          ...(check.kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
        };
        update(sessionId, (list) => [...list, item]);
        void readBase64(file)
          .then((data) => api.uploadAttachment(sessionId, { name: file.name, mime: check.mime, data }))
          .then((meta) =>
            update(sessionId, (list) => list.map((entry) => (entry.key === key ? { ...entry, meta } : entry))),
          )
          .catch((error: Error) => {
            if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
            update(sessionId, (list) => list.filter((entry) => entry.key !== key));
            onError(error.message);
          });
      }
      if (problems.length) onError(problems.join(' '));
    },
    [sessionId, update, onError],
  );

  const remove = useCallback(
    (key: string) => {
      if (!sessionId) return;
      const item = (stateRef.current[sessionId] || []).find((entry) => entry.key === key);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      update(sessionId, (list) => list.filter((entry) => entry.key !== key));
    },
    [sessionId, update],
  );

  /** Clears a conversation's composer after its message was accepted. */
  const clear = useCallback(
    (id: string) => {
      for (const item of stateRef.current[id] || []) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      update(id, () => []);
    },
    [update],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      const files = [...event.clipboardData.files];
      if (!files.length) return;
      event.preventDefault();
      add(files);
    },
    [add],
  );
  const dropHandlers = {
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      setDragging(false);
      add([...event.dataTransfer.files]);
    },
  };

  return {
    items,
    ready: items.flatMap((item) => (item.meta ? [item.meta] : [])),
    uploading: items.some((item) => !item.meta),
    full: items.length >= MAX_ATTACHMENTS_PER_MESSAGE,
    dragging,
    add,
    remove,
    clear,
    onPaste,
    dropHandlers,
  };
}
