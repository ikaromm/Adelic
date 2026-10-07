import { useEffect, useId, useState } from 'react';
import type { MemoryCatalog, MemoryScope } from '../../shared/contracts';
import { api } from '../api';
import { useI18n } from '../i18n';

const keyOf = (scope: MemoryScope) => `${scope.workspace}\0${scope.project}`;
export const scopeLabel = (scope: MemoryScope) => `${scope.workspace}/${scope.project}`;

/**
 * Settings › Memória › "Memória das conversas avulsas": picks the ai-memory scope searched by
 * conversations without a project, from the same catalog the Memory page lists. Off by default.
 */
export function DetachedMemorySetting({
  value,
  memoryEnabled,
  onChange,
}: {
  value: MemoryScope | null | undefined;
  memoryEnabled: boolean;
  onChange: (scope: MemoryScope | null) => void;
}) {
  const { t } = useI18n();
  const labelId = useId();
  const [catalog, setCatalog] = useState<MemoryCatalog | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api
      .memoryCatalog()
      .then((result) => alive && (setCatalog(result), setError('')))
      .catch((e: unknown) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);
  // `_global` is the service's shared preferences scope, already merged into every search.
  const scopes = (catalog?.scopes ?? []).filter((scope) => scope.project !== '_global');
  const current = value ? keyOf(value) : '';
  const known = !value || scopes.some((scope) => keyOf(scope) === current);
  return (
    <div className="setting-row">
      <div>
        <strong id={labelId}>{t('memorySettings.detached.label')}</strong>
        <span>{t('memorySettings.detached.detail')}</span>
        {error && <span>{t('memorySettings.detached.unavailable', { error })}</span>}
        {value && !memoryEnabled && <span>{t('memorySettings.detached.needsMemory')}</span>}
      </div>
      <select
        aria-labelledby={labelId}
        value={current}
        onChange={(event) => {
          const picked = scopes.find((scope) => keyOf(scope) === event.target.value);
          onChange(picked ? { workspace: picked.workspace, project: picked.project } : null);
        }}
      >
        <option value="">{t('memorySettings.detached.off')}</option>
        {!catalog && !error && (
          <option value="loading" disabled>
            {t('memorySettings.detached.loading')}
          </option>
        )}
        {value && !known && (
          <option value={current}>{t('memorySettings.detached.missing', { scope: scopeLabel(value) })}</option>
        )}
        {scopes.map((scope) => (
          <option key={keyOf(scope)} value={keyOf(scope)}>
            {scopeLabel(scope)} ({scope.pageCount})
          </option>
        ))}
      </select>
    </div>
  );
}
