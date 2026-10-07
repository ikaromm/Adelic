import type { ModelRef, ProviderInfo, Run } from './contracts.js';

// Switching model when the current one is overloaded or rate limited (docs/specs/retries.md).
// Shared by the server (automatic fallback, retry endpoint) and the UI ("Tentar com outro modelo").

export const MAX_MODEL_ALTERNATIVES = 3;

/** Overloaded or rate limited (`capacity`: runs recorded before the two were told apart). */
export const isCapacityFailure = (failure: Run['failure'] | undefined) =>
  failure?.kind === 'overloaded' || failure?.kind === 'rate_limit' || failure?.kind === 'capacity';

/** The model id a run really uses: the explicit one, else the provider's default. */
export function resolvedModel(provider: ProviderInfo | undefined, model?: string): string | undefined {
  if (model) return model;
  return provider?.defaultModel ?? provider?.models.find((m) => m.isDefault)?.id ?? provider?.models[0]?.id;
}

/** Same provider and same effective model (an absent model counts as the provider's default). */
export function sameModel(providers: ProviderInfo[], a: ModelRef, b: ModelRef): boolean {
  if (a.providerId !== b.providerId) return false;
  const provider = providers.find((p) => p.id === a.providerId);
  return resolvedModel(provider, a.model) === resolvedModel(provider, b.model);
}

/** "Codex · GPT-6 Luna": provider and model names from the catalog, ids when unknown. */
export function modelLabel(providers: ProviderInfo[], ref: ModelRef): string {
  const provider = providers.find((p) => p.id === ref.providerId);
  const id = resolvedModel(provider, ref.model);
  const model = provider?.models.find((m) => m.id === id);
  return `${provider?.name ?? ref.providerId} · ${model?.name ?? id ?? 'modelo padrão'}`;
}

/** True when `model` is in the catalog of an available provider. */
export function availableModel(providers: ProviderInfo[], ref: ModelRef): boolean {
  const provider = providers.find((p) => p.id === ref.providerId);
  if (!provider?.available) return false;
  return !ref.model || provider.models.some((m) => m.id === ref.model);
}

/**
 * Up to `limit` models to offer after `failed` was overloaded: the other models of the same
 * provider first, then the default model of each other available provider.
 */
export function modelAlternatives(
  providers: ProviderInfo[],
  failed: ModelRef,
  limit = MAX_MODEL_ALTERNATIVES,
): Required<ModelRef>[] {
  const result: Required<ModelRef>[] = [];
  const same = providers.find((p) => p.id === failed.providerId);
  if (same?.available) {
    const failedId = resolvedModel(same, failed.model);
    for (const m of same.models) if (m.id !== failedId) result.push({ providerId: same.id, model: m.id });
  }
  for (const p of providers) {
    if (p.id === failed.providerId || !p.available) continue;
    const model = resolvedModel(p);
    if (model) result.push({ providerId: p.id, model });
  }
  return result.slice(0, limit);
}

/**
 * "Tentar com outro modelo" under a failed run: alternatives to the model that failed (the
 * fallback target when one was tried), with labels. Empty unless the failure was capacity.
 */
export function retryAlternatives(
  providers: ProviderInfo[],
  run: Pick<Run, 'providerId' | 'model' | 'failure' | 'fallback'> | undefined,
): { ref: Required<ModelRef>; label: string }[] {
  if (!run || !isCapacityFailure(run.failure)) return [];
  const failed = run.fallback?.to ?? { providerId: run.providerId, model: run.model };
  const tried = run.fallback ? [run.fallback.from, { providerId: run.providerId, model: run.model }] : [];
  return modelAlternatives(providers, failed, MAX_MODEL_ALTERNATIVES + tried.length)
    .filter((ref) => !tried.some((t) => sameModel(providers, t, ref)))
    .slice(0, MAX_MODEL_ALTERNATIVES)
    .map((ref) => ({ ref, label: modelLabel(providers, ref) }));
}
