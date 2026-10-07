import { useEffect, useState } from 'react';
import { Activity, ArrowUpCircle, Brain, CalendarClock, MessageSquare, Settings as SettingsIcon } from 'lucide-react';
import { api, type UpdateInfo } from '../api';
import type { Session } from '../../shared/contracts';
import { relativeTime } from '../format';

export const SIDEBAR_LIMIT = 6;

export function SessionItem({
  session,
  selected,
  now,
  onSelect,
}: {
  session: Session;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const title = session.title || 'Nova conversa';
  return (
    <button
      className={`session-item ${selected ? 'selected' : ''}`}
      aria-current={selected ? 'page' : undefined}
      title={title}
      onClick={onSelect}
    >
      {session.activeRunId ? (
        <span className="session-running" aria-hidden="true" />
      ) : (
        <MessageSquare size={14} className="session-icon" aria-hidden="true" />
      )}
      <span className="session-title">{title}</span>
      {session.activeRunId && <span className="visually-hidden">, em execução</span>}
      <time className="session-time" dateTime={session.updatedAt}>
        {relativeTime(session.updatedAt, now)}
      </time>
    </button>
  );
}

export type Page = 'chat' | 'activity' | 'automations' | 'memory' | 'settings' | 'git';

/** Footer navigation: Activity, Automations, Memory (with service status) and Settings. */
export function SidebarNav({
  page,
  goTo,
  memoryStatus,
  memoryReady,
}: {
  page: Page;
  goTo: (next: Page) => void;
  memoryStatus: string;
  memoryReady: boolean;
}) {
  return (
    <nav className="sidebar-footer" aria-label="Navegação principal">
      <button
        className={`nav-item ${page === 'activity' ? 'active' : ''}`}
        aria-current={page === 'activity' ? 'page' : undefined}
        title="Atividade"
        onClick={() => goTo('activity')}
      >
        <Activity size={16} aria-hidden="true" />
        <span className="sidebar-label">Atividade</span>
      </button>
      <button
        className={`nav-item ${page === 'automations' ? 'active' : ''}`}
        aria-current={page === 'automations' ? 'page' : undefined}
        title="Automações"
        onClick={() => goTo('automations')}
      >
        <CalendarClock size={16} aria-hidden="true" />
        <span className="sidebar-label">Automações</span>
      </button>
      <button
        className={`nav-item ${page === 'memory' ? 'active' : ''}`}
        aria-current={page === 'memory' ? 'page' : undefined}
        title={`Memória · ${memoryStatus}`}
        onClick={() => goTo('memory')}
      >
        <Brain size={16} aria-hidden="true" />
        <span className="sidebar-label">Memória</span>
        <span className={`nav-status ${memoryReady ? 'ready' : 'muted'}`} aria-hidden="true" />
        <span className="visually-hidden">, {memoryStatus}</span>
      </button>
      <button
        className={`nav-item ${page === 'settings' ? 'active' : ''}`}
        aria-current={page === 'settings' ? 'page' : undefined}
        title="Configurações"
        onClick={() => goTo('settings')}
      >
        <SettingsIcon size={16} aria-hidden="true" />
        <span className="sidebar-label">Configurações</span>
      </button>
    </nav>
  );
}

/** Discreet link to a newer release; checks once per app start, only when enabled. */
export function UpdateNotice({ enabled }: { enabled: boolean }) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (!enabled) return setUpdate(null);
    let active = true;
    api
      .updates()
      .then((result) => active && setUpdate(result))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [enabled]);
  if (!update?.available || !update.url) return null;
  return (
    <a
      className="update-notice"
      href={update.url}
      target="_blank"
      rel="noreferrer"
      title={`Abrir a release ${update.latest}`}
    >
      <ArrowUpCircle size={15} aria-hidden="true" />
      <span className="sidebar-label">Versão {update.latest} disponível</span>
    </a>
  );
}
