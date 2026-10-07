import { RefreshCw } from 'lucide-react';
import { applyUpdate, usePwa } from './client';

/** "Atualização disponível — Recarregar": the new worker only takes over after this click. */
export function UpdateToast() {
  const { updateReady } = usePwa();
  if (!updateReady) return null;
  return (
    <div className="update-toast" role="status">
      <span>Atualização disponível</span>
      <button type="button" className="primary-button" onClick={applyUpdate}>
        <RefreshCw size={14} /> Recarregar
      </button>
    </div>
  );
}
