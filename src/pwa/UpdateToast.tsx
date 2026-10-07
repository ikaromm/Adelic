import { RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { applyUpdate, usePwa } from './client';

/** "Atualização disponível — Recarregar": the new worker only takes over after this click. */
export function UpdateToast() {
  const { t } = useI18n();
  const { updateReady } = usePwa();
  if (!updateReady) return null;
  return (
    <div className="update-toast" role="status">
      <span>{t('pwa.updateReady')}</span>
      <button type="button" className="primary-button" onClick={applyUpdate}>
        <RefreshCw size={14} /> {t('pwa.reload')}
      </button>
    </div>
  );
}
