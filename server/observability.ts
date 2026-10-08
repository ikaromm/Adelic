import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ObservationContext, ObservationInput, ObservabilityStatus } from '../shared/observability.js';
import type { Store } from './store.js';

interface Scope {
  store: Store;
  context: ObservationContext;
  spanId?: string;
}
const scope = new AsyncLocalStorage<Scope>();

export interface Observability {
  withObservation<T>(
    name: string,
    component: string,
    context: ObservationContext,
    fn: () => T | Promise<T>,
  ): Promise<T>;
  recordObservation(input: ObservationInput): void;
  withObservationContext<T>(context: ObservationContext, fn: () => T): T;
}

const allowedComponents = new Set([
  'http',
  'provider',
  'process',
  'memory',
  'graph',
  'git',
  'terminal',
  'ssh',
  'desktop',
  'ui',
  'queue',
  'orchestration',
  'storage',
]);

export function createObservability(store: Store): Observability {
  return {
    withObservation: (name, component, context, fn) => {
      const current = scope.getStore();
      const base = current?.store === store ? current : undefined;
      return scope.run({ store, context: { ...base?.context, ...context }, spanId: base?.spanId }, () =>
        withObservation(name, component, context, fn),
      );
    },
    recordObservation: (input) => {
      const current = scope.getStore();
      const base = current?.store === store ? current : undefined;
      return scope.run({ store, context: { ...base?.context, ...input }, spanId: base?.spanId }, () =>
        recordObservation(input),
      );
    },
    withObservationContext: (context, fn) => {
      const current = scope.getStore();
      const base = current?.store === store ? current : undefined;
      return scope.run({ store, context: { ...base?.context, ...context }, spanId: base?.spanId }, fn);
    },
  };
}

/** Instruments work within the active bound store. Failures in telemetry never fail application work. */
export async function withObservation<T>(
  name: string,
  component: string,
  context: ObservationContext = {},
  fn: () => T | Promise<T>,
): Promise<T> {
  const parent = scope.getStore();
  if (!parent) return await fn();
  const id = randomUUID();
  const inherited = { ...parent.context, ...context };
  const traceId = inherited.traceId ?? inherited.runId ?? id;
  const runId = inherited.runId ?? traceId;
  const start = Date.now();
  const input: ObservationInput & { runId: string; sessionId: string; at: string } = {
    id,
    traceId,
    parentId: inherited.parentId ?? parent.spanId,
    runId,
    sessionId: inherited.sessionId ?? 'system',
    projectId: inherited.projectId,
    name,
    component: allowedComponents.has(component) ? component : 'storage',
    kind: 'span',
    status: 'running',
    at: new Date(start).toISOString(),
    attributes: inherited.providerId ? { providerId: inherited.providerId } : {},
  };
  try {
    parent.store.recordObservabilityEvent(input);
  } catch {
    /* telemetry is best effort */
  }
  try {
    const result = await scope.run({ store: parent.store, context: inherited, spanId: id }, fn);
    try {
      const reported = result && typeof result === 'object' && 'status' in result ? String(result.status) : undefined;
      const runStatus =
        name === 'run.execute' || name === 'run.compact' ? parent.store.getRun(runId)?.status : undefined;
      const outcome = runStatus ?? reported;
      const status: ObservabilityStatus =
        outcome === 'failed' || outcome === 'error' || outcome === 'interrupted'
          ? 'error'
          : outcome === 'cancelled'
            ? 'cancelled'
            : 'success';
      parent.store.recordObservabilityEvent({ ...input, status, durationMs: Date.now() - start });
    } catch {
      /* best effort */
    }
    return result;
  } catch (error) {
    const status: ObservabilityStatus =
      (error as { name?: string; cancelled?: boolean })?.name === 'AbortError' ||
      (error as { cancelled?: boolean })?.cancelled === true
        ? 'cancelled'
        : 'error';
    try {
      parent.store.recordObservabilityEvent({ ...input, status, durationMs: Date.now() - start });
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function recordObservation(input: ObservationInput): void {
  const current = scope.getStore();
  if (!current) return;
  const context = { ...current.context, ...input };
  const traceId = context.traceId ?? context.runId ?? randomUUID();
  const runId = context.runId ?? traceId;
  try {
    current.store.recordObservabilityEvent({
      ...input,
      traceId,
      runId,
      sessionId: context.sessionId ?? 'system',
      projectId: context.projectId ?? null,
      parentId: input.parentId ?? current.spanId ?? null,
      at: input.at ?? new Date().toISOString(),
      component: allowedComponents.has(input.component) ? input.component : 'storage',
    });
  } catch {
    /* telemetry must never interrupt application work */
  }
}

export function withObservationContext<T>(context: ObservationContext, fn: () => T): T {
  const current = scope.getStore();
  return current ? scope.run({ ...current, context: { ...current.context, ...context } }, fn) : fn();
}
