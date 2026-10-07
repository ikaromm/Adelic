import { describe, expect, it } from 'vitest';
import { STICK_THRESHOLD, isAtBottom } from '../src/hooks/useStickToBottom';
import { isNewConversationKey } from '../src/hooks/useGlobalShortcuts';
import { composerKeyAction, queuePauseLabel } from '../src/hooks/useMessageQueue';

describe('conversation scroll following', () => {
  it('follows only while the reader is within the threshold of the end', () => {
    const box = (scrollTop: number) => ({ scrollHeight: 2000, clientHeight: 500, scrollTop });
    expect(isAtBottom(box(1500))).toBe(true);
    expect(isAtBottom(box(1500 - STICK_THRESHOLD + 1))).toBe(true);
    expect(isAtBottom(box(1500 - STICK_THRESHOLD))).toBe(false);
    expect(isAtBottom(box(0))).toBe(false);
  });
});

describe('global shortcuts', () => {
  it('recognises Ctrl+K and Cmd+K regardless of case, and nothing else', () => {
    expect(isNewConversationKey({ ctrlKey: true, metaKey: false, key: 'k' })).toBe(true);
    expect(isNewConversationKey({ ctrlKey: false, metaKey: true, key: 'K' })).toBe(true);
    expect(isNewConversationKey({ ctrlKey: false, metaKey: false, key: 'k' })).toBe(false);
    expect(isNewConversationKey({ ctrlKey: true, metaKey: false, key: 'j' })).toBe(false);
  });
});

describe('composer keys with the message queue', () => {
  const key = (over: Partial<KeyboardEvent> = {}) => ({
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    ...over,
  });
  it('sends when idle, queues while running, and Ctrl/Cmd+Enter sends now', () => {
    expect(composerKeyAction(key(), false)).toBe('send');
    expect(composerKeyAction(key(), true)).toBe('queue');
    expect(composerKeyAction(key({ ctrlKey: true }), true)).toBe('send-now');
    expect(composerKeyAction(key({ metaKey: true }), true)).toBe('send-now');
    expect(composerKeyAction(key({ ctrlKey: true }), false)).toBe('send');
  });
  it('leaves Shift+Enter, IME composition and other keys alone', () => {
    expect(composerKeyAction(key({ shiftKey: true }), true)).toBeNull();
    expect(composerKeyAction(key({ isComposing: true }), true)).toBeNull();
    expect(composerKeyAction(key({ key: 'a' }), false)).toBeNull();
  });
  it('explains why the queue is paused', () => {
    expect(queuePauseLabel(null)).toBe('');
    expect(queuePauseLabel({ sessionId: 's', items: [], paused: { reason: 'cancelled', at: '' } })).toMatch(
      /cancelada/,
    );
    expect(
      queuePauseLabel({ sessionId: 's', items: [], paused: { reason: 'failed', at: '', error: 'sem rede' } }),
    ).toBe('A execução falhou: sem rede');
  });
});
