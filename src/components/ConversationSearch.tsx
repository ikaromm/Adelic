import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, MessageSquare, Search, X } from 'lucide-react';
import type { ConversationSearchHit } from '../../shared/contracts';
import { api } from '../api';
import { useI18n, type MessageKey } from '../i18n';

/** Renders a snippet whose matched terms are wrapped in [[ ]] by the server, without HTML injection. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('[[') && part.endsWith(']]') ? (
          <mark key={i}>{part.slice(2, -2)}</mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const roleLabel: Record<ConversationSearchHit['matches'][number]['role'], MessageKey> = {
  user: 'search.role.user',
  assistant: 'search.role.assistant',
  system: 'search.role.system',
};

/** Dialog that searches every conversation (titles and messages) and opens the chosen one. */
export function ConversationSearch({ onOpen, onClose }: { onOpen: (sessionId: string) => void; onClose: () => void }) {
  const { t, tRich, fmt } = useI18n();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ConversationSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const value = query.trim();
    if (!value) {
      setHits(null);
      return;
    }
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      setBusy(true);
      api
        .searchConversations(value)
        .then((result) => {
          if (id === request.current) {
            setHits(result.hits);
            setError('');
          }
        })
        .catch((e: Error) => id === request.current && setError(e.message))
        .finally(() => id === request.current && setBusy(false));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  const now = Date.now();
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card search-card" role="dialog" aria-modal="true" aria-labelledby="search-title">
        <div className="modal-heading">
          <h2 id="search-title">{t('search.title')}</h2>
          <button className="icon-button" aria-label={t('search.close')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && hits?.[0]) onOpen(hits[0].sessionId);
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.title')}
          />
          {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
        </label>
        {error && (
          <div className="inline-notice error-notice" role="alert">
            {error}
          </div>
        )}
        <div className="search-results" role="list" aria-label={t('search.results')}>
          {hits?.length === 0 && <p className="muted-empty">{t('search.empty', { query: query.trim() })}</p>}
          {hits?.map((hit) => (
            <button key={hit.sessionId} role="listitem" className="search-hit" onClick={() => onOpen(hit.sessionId)}>
              <span className="search-hit-title">
                <MessageSquare size={14} aria-hidden="true" /> {hit.title}
                <small>{fmt.relative(hit.updatedAt, now)}</small>
              </span>
              {hit.matches.map((m) => (
                <span key={m.messageId} className="search-hit-snippet">
                  <strong>{t('search.match', { role: t(roleLabel[m.role]) })}</strong> <Snippet text={m.snippet} />
                </span>
              ))}
            </button>
          ))}
        </div>
        <p className="search-hint">{tRich('search.hint', { enter: <kbd>Enter</kbd> })}</p>
      </div>
    </div>
  );
}
