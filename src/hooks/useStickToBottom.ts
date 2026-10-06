import { useCallback, useLayoutEffect, useRef, useState, type DependencyList } from 'react';

/** Distance from the end (px) still treated as "at the end". */
export const STICK_THRESHOLD = 96;
export const isAtBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) =>
  el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;

/**
 * Keeps a scroll container at its end while new content arrives, but only when the
 * reader is already there: scrolling up to read history is never interrupted.
 * `resetKeys` (conversation, page) re-attach to the end; `contentKeys` signal new content.
 */
export function useStickToBottom<T extends HTMLElement>(resetKeys: DependencyList, contentKeys: DependencyList) {
  const ref = useRef<T>(null);
  const stickRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const stick = useCallback(() => {
    stickRef.current = true;
    setShowJump(false);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-provided keys
  useLayoutEffect(stick, resetKeys);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && stickRef.current) element.scrollTop = element.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-provided keys
  }, [...resetKeys, ...contentKeys]);
  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const atBottom = isAtBottom(element);
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);
  const scrollToLatest = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    stick();
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [stick]);
  return { ref, showJump, onScroll, scrollToLatest, stick };
}
