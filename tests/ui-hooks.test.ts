import { describe, expect, it } from 'vitest';
import { STICK_THRESHOLD, isAtBottom } from '../src/hooks/useStickToBottom';
import { isNewConversationKey } from '../src/hooks/useGlobalShortcuts';

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
