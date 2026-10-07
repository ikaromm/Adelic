import { useCallback, useEffect, useRef } from 'react';
import type { StreamEvent } from '../../shared/contracts';
import { t } from '../i18n';

/** What a system notification says; text is limited to titles and short reasons. */
export interface RunNotice {
  /** Dedupe key: one notice per run outcome or approval. */
  key: string;
  sessionId: string;
  title: string;
  body: string;
}

const MAX_TITLE = 80;
const MAX_REASON = 120;
const MAX_SEEN = 500;

function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The desktop app (Electron) notifies by default; a browser tab asks first. */
export function defaultNotifications(userAgent: string) {
  return /\bElectron\//.test(userAgent);
}

/** Effective setting: an explicit choice wins; absent, it follows the environment default. */
export function notificationsEnabled(
  settings: { notifications?: boolean },
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
) {
  return settings.notifications ?? defaultNotifications(userAgent);
}

/** Current browser permission, or 'unsupported' where the API does not exist. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** The reader is looking at the app: visible and focused. Only then nothing is announced. */
export function isAttentive(doc: { hidden: boolean; hasFocus(): boolean }) {
  return !doc.hidden && doc.hasFocus();
}

/**
 * Maps a stream event to the notice it deserves, if any: a finished run, a failed run or a
 * pending approval. Cancellations are the user's own action and never announced. Message
 * content is never included, only the conversation title and short reasons.
 */
export function noticeFor(event: StreamEvent, titleOf: (sessionId: string) => string | undefined): RunNotice | null {
  if (event.type === 'run') {
    const { run } = event;
    // The handoff summary call is followed in its own dialog.
    if (run.handoff) return null;
    const conversation = clip(titleOf(run.sessionId) || t('notifications.conversation'), MAX_TITLE);
    if (run.status === 'completed')
      return {
        key: `run:${run.id}:completed`,
        sessionId: run.sessionId,
        title: run.compaction ? t('notifications.compacted') : t('notifications.ready'),
        body: conversation,
      };
    if (run.status === 'failed') {
      const reason = clip(run.failure?.reason || run.error || t('notifications.noReason'), MAX_REASON);
      return {
        key: `run:${run.id}:failed`,
        sessionId: run.sessionId,
        title: t('notifications.failed'),
        body: t('notifications.failedBody', { conversation, reason }),
      };
    }
    return null;
  }
  if (event.type === 'approval' && event.approval.status === 'pending') {
    const { approval } = event;
    const conversation = clip(titleOf(approval.sessionId) || t('notifications.conversation'), MAX_TITLE);
    return {
      key: `approval:${approval.id}`,
      sessionId: approval.sessionId,
      title: t('notifications.approval'),
      body: t('notifications.approvalBody', { title: clip(approval.title, MAX_TITLE), conversation }),
    };
  }
  return null;
}

export type NoticeAction = 'none' | 'badge' | 'notify';

/**
 * Decides what to do with a notice and records it, so the same run outcome or approval is
 * handled once. While the reader is attentive nothing happens; otherwise the title badge is
 * raised, and a system notification is shown when the setting is on.
 */
export function decide(
  notice: RunNotice | null,
  state: { seen: Set<string>; attentive: boolean; enabled: boolean },
): NoticeAction {
  if (!notice || state.seen.has(notice.key)) return 'none';
  state.seen.add(notice.key);
  if (state.seen.size > MAX_SEEN) state.seen.delete(state.seen.values().next().value as string);
  if (state.attentive) return 'none';
  return state.enabled ? 'notify' : 'badge';
}

export function badgeTitle(base: string, count: number) {
  return count > 0 ? `(${count}) ${base}` : base;
}

/**
 * Announces finished runs, failures and pending approvals while the window is hidden or
 * unfocused: a system notification (Web Notification API, also used by Electron) and a
 * "(n)" badge in the document title, cleared when the window regains focus. Returns the
 * handler for stream events; it is stable across renders.
 *
 * Clicking a notification calls window.focus() and opens the conversation. Without a
 * preload/IPC, Electron on Linux may not raise the window (focus-stealing prevention).
 */
export function useRunNotifications(options: {
  enabled: boolean;
  titleOf: (sessionId: string) => string | undefined;
  onOpen: (sessionId: string) => void;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const seen = useRef(new Set<string>());
  const pending = useRef(0);
  const baseTitle = useRef('');

  useEffect(() => {
    baseTitle.current = document.title;
    const clear = () => {
      if (!isAttentive(document) || pending.current === 0) return;
      pending.current = 0;
      document.title = baseTitle.current;
    };
    window.addEventListener('focus', clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      window.removeEventListener('focus', clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, []);

  return useCallback((event: StreamEvent) => {
    const notice = noticeFor(event, (id) => optionsRef.current.titleOf(id));
    const action = decide(notice, {
      seen: seen.current,
      attentive: isAttentive(document),
      enabled: optionsRef.current.enabled,
    });
    if (action === 'none' || !notice) return;
    pending.current++;
    document.title = badgeTitle(baseTitle.current || document.title, pending.current);
    if (action !== 'notify' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      // One notification per conversation: a newer one replaces the previous.
      const shown = new Notification(notice.title, { body: notice.body, tag: `adelic:${notice.sessionId}` });
      shown.onclick = () => {
        window.focus();
        optionsRef.current.onOpen(notice.sessionId);
        shown.close();
      };
    } catch {
      /* Some environments expose Notification but refuse the constructor; the badge remains. */
    }
  }, []);
}
