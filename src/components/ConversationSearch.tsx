import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, MessageSquare, Search, X } from 'lucide-react';
import type { ConversationSearchHit } from '../../shared/contracts';
import { api } from '../api';
import { relativeTime } from '../format';

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

const roleLabel = { user: 'Você', assistant: 'Agente', system: 'Sistema' } as const;

/** Dialog that searches every conversation (titles and messages) and opens the chosen one. */
export function ConversationSearch({ onOpen, onClose }: { onOpen: (sessionId: string) => void; onClose: () => void }) {
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
          <h2 id="search-title">Buscar nas conversas</h2>
          <button className="icon-button" aria-label="Fechar busca" onClick={onClose}>
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
            placeholder="Palavras em títulos e mensagens…"
            aria-label="Buscar nas conversas"
          />
          {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
        </label>
        {error && (
          <div className="inline-notice error-notice" role="alert">
            {error}
          </div>
        )}
        <div className="search-results" role="list" aria-label="Resultados">
          {hits?.length === 0 && <p className="muted-empty">Nada encontrado para “{query.trim()}”.</p>}
          {hits?.map((hit) => (
            <button key={hit.sessionId} role="listitem" className="search-hit" onClick={() => onOpen(hit.sessionId)}>
              <span className="search-hit-title">
                <MessageSquare size={14} aria-hidden="true" /> {hit.title}
                <small>{relativeTime(hit.updatedAt, now)}</small>
              </span>
              {hit.matches.map((m) => (
                <span key={m.messageId} className="search-hit-snippet">
                  <strong>{roleLabel[m.role]}:</strong> <Snippet text={m.snippet} />
                </span>
              ))}
            </button>
          ))}
        </div>
        <p className="search-hint">
          A busca roda neste computador. <kbd>Enter</kbd> abre o primeiro resultado.
        </p>
      </div>
    </div>
  );
}
