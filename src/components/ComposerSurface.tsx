import type { ReactNode } from 'react';

/** Structural shell for the chat composer. Message state and all actions stay with the caller. */
export function ComposerSurface({
  input,
  primaryControls,
  actions,
  context,
  className = '',
}: {
  /** Textarea and its local autocomplete/attachment overlays. */
  input: ReactNode;
  /** Model, reasoning, and access controls in their visual and keyboard order. */
  primaryControls: ReactNode;
  /** Attachments, voice, queue/steer, and send/cancel actions. */
  actions: ReactNode;
  /** Project, mode, planning, and execution profile controls. */
  context: ReactNode;
  className?: string;
}) {
  return (
    <div className={`composer-surface ${className}`.trim()}>
      <div className="composer-surface-input">{input}</div>
      <div className="composer-surface-main">
        <div className="composer-surface-primary">{primaryControls}</div>
        <div className="composer-surface-actions">{actions}</div>
      </div>
      <div className="composer-surface-context">{context}</div>
    </div>
  );
}
