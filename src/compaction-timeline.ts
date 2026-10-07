import type { Compaction, Message } from '../shared/contracts';

/** One piece of the conversation timeline: messages, or messages folded under a summary. */
export type TimelineSegment =
  | { kind: 'messages'; messages: Message[] }
  | { kind: 'compaction'; compaction: Compaction; earlier: Message[]; latest: boolean };

/**
 * Splits the messages at each compaction (docs/specs/compaction.md): the messages a summary
 * covers are folded under it, in order, and the messages after the latest one stay open. A
 * compaction whose boundary message is gone covers nothing and still shows its card.
 */
export function timelineSegments(messages: Message[], compactions: Compaction[] = []): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let start = 0;
  compactions.forEach((compaction, index) => {
    const at = messages.findIndex((m, i) => i >= start && m.id === compaction.upToMessageId);
    const end = at < 0 ? start : at + 1;
    segments.push({
      kind: 'compaction',
      compaction,
      earlier: messages.slice(start, end),
      latest: index === compactions.length - 1,
    });
    start = end;
  });
  const rest = messages.slice(start);
  if (rest.length || !segments.length) segments.push({ kind: 'messages', messages: rest });
  return segments;
}

/** Inserts or replaces a compaction, keeping creation order; other conversations are ignored. */
export function upsertCompaction(list: Compaction[] = [], next: Compaction, sessionId: string) {
  if (next.sessionId !== sessionId) return list;
  const index = list.findIndex((c) => c.id === next.id);
  return index < 0 ? [...list, next] : list.map((c, i) => (i === index ? next : c));
}
