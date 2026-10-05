import type { Bootstrap } from '../shared/contracts';

export function bootstrapSelection(
  snapshot: Pick<Bootstrap, 'projects' | 'sessions'>,
  currentProjectId: string,
  currentSessionId: string,
  preserveSelection: boolean,
) {
  const currentSession = preserveSelection
    ? snapshot.sessions.find(session => session.id === currentSessionId)
    : undefined;
  if (currentSession) {
    return { projectId: currentSession.projectId || '', sessionId: currentSession.id };
  }

  const projectStillExists = snapshot.projects.some(project => project.id === currentProjectId);
  const projectId = preserveSelection && projectStillExists ? currentProjectId : '';
  if (preserveSelection && !currentSessionId) return { projectId, sessionId: '' };

  const candidates = snapshot.sessions.filter(session => session.projectId === projectId);
  if (preserveSelection && projectId && candidates.length === 0) return { projectId, sessionId: '' };
  const fallback = candidates[0] || snapshot.sessions
    .filter(session => session.projectId === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const selectedProjectId = fallback?.projectId || '';
  const sessionId = fallback?.id || '';
  return { projectId: selectedProjectId, sessionId };
}
