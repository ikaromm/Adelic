import { useState } from 'react';
import { FoldVertical, LoaderCircle, MoreHorizontal } from 'lucide-react';
import type { Compaction } from '../../shared/contracts';
import { CopyButton, Markdown } from '../Markdown';
import { timeLabel } from '../labels';
import { useI18n } from '../i18n';

/** "Resumo da conversa": the summary that replaced the earlier messages as context. */
export function CompactionCard({ compaction, latest }: { compaction: Compaction; latest: boolean }) {
  const { t, tRich } = useI18n();
  const meta = compaction.auto
    ? latest
      ? 'compaction.meta.autoLatest'
      : 'compaction.meta.autoEarlier'
    : latest
      ? 'compaction.meta.manualLatest'
      : 'compaction.meta.manualEarlier';
  return (
    <section
      className={`compaction-card ${latest ? '' : 'superseded'}`.trim()}
      aria-label={latest ? t('compaction.label') : t('compaction.labelEarlier')}
    >
      <header className="compaction-card-header">
        <span className="compaction-card-icon" aria-hidden="true">
          <FoldVertical size={14} />
        </span>
        <div>
          <strong>{latest ? t('compaction.title') : t('compaction.titleEarlier')}</strong>
          <small>
            {tRich(meta, {
              time: <time dateTime={compaction.createdAt}>{timeLabel(compaction.createdAt)}</time>,
            })}
          </small>
        </div>
        <CopyButton text={compaction.summary} label={t('compaction.copy')} />
      </header>
      {latest ? (
        <Markdown>{compaction.summary}</Markdown>
      ) : (
        <details className="compaction-card-body">
          <summary>{t('compaction.show')}</summary>
          <Markdown>{compaction.summary}</Markdown>
        </details>
      )}
    </section>
  );
}

/** Progress line of a manual compaction, which has no message of its own. */
export function CompactingNotice() {
  const { t } = useI18n();
  return (
    <div className="compacting-notice" role="status">
      <LoaderCircle className="spin" size={14} aria-hidden="true" />
      <span>{t('compaction.compacting')}</span>
    </div>
  );
}

/** Header menu of the open conversation. */
export function ConversationActions({ disabled, onCompact }: { disabled: boolean; onCompact: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div
      className="conversation-actions"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="icon-button"
        aria-label={t('compaction.actions')}
        title={t('compaction.actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="conversation-actions-menu" role="menu" aria-label={t('compaction.actions')}>
          <button
            type="button"
            role="menuitem"
            autoFocus
            disabled={disabled}
            title={disabled ? t('compaction.waitRun') : undefined}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            <FoldVertical size={14} aria-hidden="true" />
            <span>
              <b>{t('compaction.compact')}</b>
              <small>{t('compaction.compactHint')}</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
