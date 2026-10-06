import { useLayoutEffect, useRef, type DependencyList } from 'react';

/** Grows a textarea with its content; CSS caps the height and scrolls beyond it. */
export function useAutosize(deps: DependencyList) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-provided keys
  }, deps);
  return ref;
}
