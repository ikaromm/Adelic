import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { DelegatedTask, SessionDetail } from '../../shared/contracts';
import { api } from '../api';

/**
 * Loads a delegated task's full output on demand (outputs are not part of the session
 * detail). A response is applied only if the task still belongs to the open conversation
 * and no newer request for it started; identity fields must match the task requested.
 */
export function useTaskOutputs(
  selectedSessionRef: MutableRefObject<string>,
  detailRef: MutableRefObject<SessionDetail | null>,
  onError: (message: string) => void,
) {
  const [outputs, setOutputs] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const requests = useRef(new Map<string, number>());
  const outputsRef = useRef(outputs);
  outputsRef.current = outputs;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const load = useCallback(
    async (task: DelegatedTask) => {
      if (task.status === 'running' || task.status === 'queued' || Object.hasOwn(outputsRef.current, task.id)) return;
      if (selectedSessionRef.current !== task.sessionId) return;
      const belongs = (detail: SessionDetail | null) =>
        Boolean(detail?.tasks?.some((item) => item.id === task.id && item.runId === task.runId));
      if (!belongs(detailRef.current)) return;
      const requestId = (requests.current.get(task.id) || 0) + 1;
      requests.current.set(task.id, requestId);
      setLoading((current) => new Set(current).add(task.id));
      const isCurrent = () =>
        selectedSessionRef.current === task.sessionId &&
        detailRef.current?.session.id === task.sessionId &&
        belongs(detailRef.current);
      try {
        const full = await api.task(task.id);
        if (requests.current.get(task.id) !== requestId || !isCurrent()) return;
        if (
          full.id !== task.id ||
          full.projectId !== task.projectId ||
          full.sessionId !== task.sessionId ||
          full.runId !== task.runId
        )
          return;
        setOutputs((current) => ({ ...current, [task.id]: full.output ?? null }));
      } catch (error) {
        if (requests.current.get(task.id) === requestId && isCurrent()) onErrorRef.current((error as Error).message);
      } finally {
        if (requests.current.get(task.id) === requestId) {
          requests.current.delete(task.id);
          setLoading((current) => {
            const next = new Set(current);
            next.delete(task.id);
            return next;
          });
        }
      }
    },
    [selectedSessionRef, detailRef],
  );
  return { outputs, loading, load };
}
