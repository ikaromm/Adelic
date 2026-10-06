import { describe, expect, it } from 'vitest';
import type { Project, Session } from '../shared/contracts.js';
import { bootstrapSelection, sidebarSessions } from '../src/selection.js';

const projects = [{ id: 'a' }, { id: 'b' }] as Project[];
const sessions = [
  { id: 'a1', projectId: 'a', updatedAt: '2026-10-01T10:00:00Z' },
  { id: 'b1', projectId: 'b', updatedAt: '2026-10-02T10:00:00Z' },
  { id: 'loose-old', projectId: null, updatedAt: '2026-10-01T10:00:00Z' },
  { id: 'loose-new', projectId: null, updatedAt: '2026-10-03T10:00:00Z' },
] as Session[];

describe('bootstrap selection after an async refresh', () => {
  it('starts in the most recent standalone conversation without selecting a project', () => {
    expect(bootstrapSelection({ projects, sessions }, '', '', false)).toEqual({
      projectId: '',
      sessionId: 'loose-new',
    });
  });

  it('keeps a standalone conversation selected when a snapshot arrives', () => {
    expect(bootstrapSelection({ projects, sessions }, 'b', 'loose-new', true)).toEqual({
      projectId: '',
      sessionId: 'loose-new',
    });
  });

  it('keeps an explicit new deselection through refresh', () => {
    expect(bootstrapSelection({ projects, sessions }, '', '', true)).toEqual({ projectId: '', sessionId: '' });
    expect(bootstrapSelection({ projects, sessions }, 'b', '', true)).toEqual({ projectId: 'b', sessionId: '' });
  });

  it('keeps the selected project and its conversation while a request is in flight', () => {
    expect(bootstrapSelection({ projects, sessions }, 'b', 'b1', true)).toEqual({ projectId: 'b', sessionId: 'b1' });
  });

  it('derives the right project from the selected conversation if refs were temporarily stale', () => {
    expect(bootstrapSelection({ projects, sessions }, 'a', 'b1', true)).toEqual({ projectId: 'b', sessionId: 'b1' });
  });

  it('falls back to a valid conversation in the prior project when the selection was deleted', () => {
    expect(bootstrapSelection({ projects, sessions }, 'b', 'deleted', true)).toEqual({
      projectId: 'b',
      sessionId: 'b1',
    });
  });

  it('keeps the prior project selected if its last conversation was deleted', () => {
    expect(
      bootstrapSelection(
        { projects, sessions: sessions.filter((session) => session.projectId !== 'b') },
        'b',
        'deleted',
        true,
      ),
    ).toEqual({ projectId: 'b', sessionId: '' });
  });

  it('falls back to the latest standalone conversation when the prior project disappeared', () => {
    expect(bootstrapSelection({ projects, sessions }, 'missing', 'deleted', true)).toEqual({
      projectId: '',
      sessionId: 'loose-new',
    });
  });

  it('does not pair a project with a conversation from another project', () => {
    expect(bootstrapSelection({ projects, sessions }, 'b', 'a1', true)).toEqual({ projectId: 'a', sessionId: 'a1' });
  });
});

describe('sidebar conversation list', () => {
  const list = Array.from({ length: 9 }, (_, index) => ({
    id: `s${index}`,
    updatedAt: `2026-10-0${index + 1}T10:00:00Z`,
  }));

  it('orders by recent activity and reports how many are hidden', () => {
    const { items, hidden } = sidebarSessions(list, 6, false, '');
    expect(items.map((item) => item.id)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3']);
    expect(hidden).toBe(3);
  });

  it('keeps the selected conversation visible even when it is older than the limit', () => {
    const { items, hidden } = sidebarSessions(list, 6, false, 's0');
    expect(items.map((item) => item.id)).toEqual(['s8', 's7', 's6', 's5', 's4', 's3', 's0']);
    expect(hidden).toBe(2);
  });

  it('shows everything when expanded or under the limit, without mutating the input', () => {
    const before = list.map((item) => item.id);
    expect(sidebarSessions(list, 6, true, '').items).toHaveLength(9);
    expect(sidebarSessions(list.slice(0, 4), 6, false, 's1')).toMatchObject({ hidden: 0 });
    expect(list.map((item) => item.id)).toEqual(before);
  });
});
