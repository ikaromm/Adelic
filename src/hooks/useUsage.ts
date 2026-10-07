import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageReport } from '../../shared/contracts';
import { SPEND_LIMIT_CODE } from '../../shared/spend-limits';
import { api, type ApiError } from '../api';

/** A 409 from a usage limit, which "Continuar mesmo assim" can pass once. */
export function isLimitError(error: unknown): error is ApiError {
  return (error as ApiError | null)?.code === SPEND_LIMIT_CODE;
}

/**
 * Usage report (GET /api/usage) for the global scope or a project. Reloads when `version`
 * changes (a run finished, a setting changed); a late response for another scope is ignored.
 * Disabled: no request, and the last report is dropped.
 */
export function useUsage(projectId: string | undefined, version: unknown, enabled = true) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const reload = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const next = await api.usage(projectId);
      if (requestId === requestRef.current) {
        setReport(next);
        setError('');
      }
    } catch (e) {
      if (requestId === requestRef.current) setError((e as Error).message);
    }
  }, [projectId]);
  useEffect(() => {
    if (!enabled) {
      requestRef.current++;
      setReport(null);
      return;
    }
    void reload();
  }, [enabled, reload, version]);
  return { report, error, reload };
}
