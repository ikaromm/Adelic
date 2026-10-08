import type { Bootstrap, Session } from '../shared/contracts';

/** Recent-first sidebar list, limited unless expanded; the selected conversation always stays visible. */
export function sidebarSessions<T extends Pick<Session, 'id' | 'updatedAt'>>(
  sessions: T[],
  limit: number,
  expanded: boolean,
  selectedId: string,
) {
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (expanded || sorted.length <= limit) return { items: sorted, hidden: 0 };
  const items = sorted.slice(0, limit);
  const selected = sorted.find((session) => session.id === selectedId);
  if (selected && !items.includes(selected)) items.push(selected);
  return { items, hidden: sorted.length - items.length };
}

export function bootstrapSelection(
  snapshot: Pick<Bootstrap, 'projects' | 'sessions'>,
  currentProjectId: string,
  currentSessionId: string,
  preserveSelection: boolean,
) {
  const currentSession = preserveSelection
    ? snapshot.sessions.find((session) => session.id === currentSessionId)
    : undefined;
  if (currentSession) {
    return { projectId: currentSession.projectId || '', sessionId: currentSession.id };
  }

  const projectStillExists = snapshot.projects.some((project) => project.id === currentProjectId);
  const projectId = preserveSelection && projectStillExists ? currentProjectId : '';
  if (preserveSelection && !currentSessionId) return { projectId, sessionId: '' };

  const candidates = snapshot.sessions.filter((session) => session.projectId === projectId && !session.archivedAt);
  if (preserveSelection && projectId && candidates.length === 0) return { projectId, sessionId: '' };
  const fallback =
    candidates[0] ||
    snapshot.sessions
      .filter((session) => session.projectId === null && !session.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const selectedProjectId = fallback?.projectId || '';
  const sessionId = fallback?.id || '';
  return { projectId: selectedProjectId, sessionId };
}
