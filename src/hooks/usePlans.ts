import { useCallback, useEffect, useRef, useState } from 'react';
import type { Plan } from '../../shared/contracts';
import { api, type ApiError } from '../api';
import { isLimitError } from './useUsage';

/** Inserts or replaces a plan, keeping creation order; plans of other conversations are ignored. */
export function upsertPlan(plans: Plan[], next: Plan, sessionId: string) {
  if (next.sessionId !== sessionId) return plans;
  const index = plans.findIndex((plan) => plan.id === next.id);
  if (index < 0) return [...plans, next];
  // A late response must not undo a newer stream event. Saves in the same millisecond tie on
  // `updatedAt`, so `revision` (bumped on every save) decides when both carry it.
  const current = plans[index];
  if (current.revision !== undefined && next.revision !== undefined) {
    if (current.revision > next.revision) return plans;
  } else if (current.updatedAt > next.updatedAt) return plans;
  return plans.map((plan, i) => (i === index ? next : plan));
}

/**
 * Plans of the open conversation (docs/specs/plan-mode.md). The server owns them; this hook
 * mirrors them, applies `plan` stream events and wraps the actions of the plan card.
 */
export function usePlans(
  sessionId: string,
  onError: (message: string) => void,
  /** A usage limit refused the start; `retry` repeats it with "Continuar mesmo assim". */
  onLimit?: (error: ApiError, retry: () => Promise<unknown>) => void,
) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;

  const apply = useCallback((plan: Plan) => {
    setPlans((current) => upsertPlan(current, plan, sessionRef.current));
  }, []);
  const reload = useCallback(async () => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      const result = await api.plans(id);
      if (id === sessionRef.current) setPlans(result.plans);
    } catch {
      /* A later stream event or refresh brings the plans back. */
    }
  }, []);
  useEffect(() => {
    setPlans([]);
    if (sessionId) void reload();
  }, [sessionId, reload]);

  /** Runs an action; its plan result is applied, errors go to the notice. Undefined on failure. */
  const act = useCallback(
    async <T>(work: () => Promise<T>, pick: (result: T) => Plan | undefined): Promise<T | undefined> => {
      try {
        const result = await work();
        const plan = pick(result);
        if (plan) apply(plan);
        return result;
      } catch (error) {
        onErrorRef.current((error as Error).message);
        return undefined;
      }
    },
    [apply],
  );
  return {
    plans,
    apply,
    reload,
    edit: (id: string, markdown: string) =>
      act(
        () => api.editPlan(id, markdown),
        (plan) => plan,
      ),
    approve: async function approve(id: string, mode: 'all' | 'next', overrideLimit = false): Promise<unknown> {
      try {
        const result = await api.approvePlan(id, mode, overrideLimit);
        apply(result.plan);
        return result;
      } catch (error) {
        if (isLimitError(error) && onLimitRef.current) onLimitRef.current(error, () => approve(id, mode, true));
        else onErrorRef.current((error as Error).message);
        // The server put the plan back; its stream event may arrive after this response.
        void reload();
        return undefined;
      }
    },
    setTask: (id: string, taskId: string, status: 'skipped' | 'pending') =>
      act(
        () => api.planTask(id, taskId, status),
        (plan) => plan,
      ),
    stop: (id: string) =>
      act(
        () => api.stopPlan(id),
        (plan) => plan,
      ),
    discard: (id: string) =>
      act(
        () => api.discardPlan(id),
        (plan) => plan,
      ),
    /** `'exists'` when the file is already there and `overwrite` was not set (409). */
    save: async (id: string, overwrite = false): Promise<{ path: string } | 'exists' | undefined> => {
      try {
        const result = await api.savePlan(id, overwrite);
        apply(result.plan);
        return { path: result.path };
      } catch (error) {
        if ((error as ApiError).exists) return 'exists';
        onErrorRef.current((error as Error).message);
        return undefined;
      }
    },
  };
}
