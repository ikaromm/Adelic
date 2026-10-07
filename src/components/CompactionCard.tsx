import { useState } from 'react';
import { FoldVertical, LoaderCircle, MoreHorizontal } from 'lucide-react';
import type { Compaction } from '../../shared/contracts';
import { CopyButton, Markdown } from '../Markdown';
import { timeLabel } from '../labels';

/** "Resumo da conversa": the summary that replaced the earlier messages as context. */
export function CompactionCard({ compaction, latest }: { compaction: Compaction; latest: boolean }) {
  return (
    <section
      className={`compaction-card ${latest ? '' : 'superseded'}`.trim()}
      aria-label={latest ? 'Resumo da conversa' : 'Resumo anterior da conversa'}
    >
      <header className="compaction-card-header">
        <span className="compaction-card-icon" aria-hidden="true">
          <FoldVertical size={14} />
        </span>
        <div>
          <strong>{latest ? 'Resumo da conversa' : 'Resumo anterior'}</strong>
          <small>
            {compaction.auto ? 'Compactada automaticamente' : 'Compactada'} às{' '}
            <time dateTime={compaction.createdAt}>{timeLabel(compaction.createdAt)}</time>
            {latest ? ' · as próximas mensagens partem deste resumo' : ' · incluído no resumo seguinte'}
          </small>
        </div>
        <CopyButton text={compaction.summary} label="Copiar resumo" />
      </header>
      {latest ? (
        <Markdown>{compaction.summary}</Markdown>
      ) : (
        <details className="compaction-card-body">
          <summary>Ver resumo</summary>
          <Markdown>{compaction.summary}</Markdown>
        </details>
      )}
    </section>
  );
}

/** Progress line of a manual compaction, which has no message of its own. */
export function CompactingNotice() {
  return (
    <div className="compacting-notice" role="status">
      <LoaderCircle className="spin" size={14} aria-hidden="true" />
      <span>Compactando a conversa…</span>
    </div>
  );
}

/** Header menu of the open conversation. */
export function ConversationActions({ disabled, onCompact }: { disabled: boolean; onCompact: () => void }) {
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
        aria-label="Ações da conversa"
        title="Ações da conversa"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="conversation-actions-menu" role="menu" aria-label="Ações da conversa">
          <button
            type="button"
            role="menuitem"
            autoFocus
            disabled={disabled}
            title={disabled ? 'Aguarde a execução atual terminar' : undefined}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            <FoldVertical size={14} aria-hidden="true" />
            <span>
              <b>Compactar conversa</b>
              <small>Resume a conversa; as próximas mensagens partem do resumo.</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
