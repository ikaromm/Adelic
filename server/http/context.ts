import type { Store } from '../store.js';
import type { Orchestrator } from '../orchestrator.js';
import type { ProviderInfo } from '../../shared/contracts.js';

/** Dependencies shared by the route modules, built once in createBackend. */
export interface BackendContext {
  store: Store;
  orchestrator: Orchestrator;
  providerList: () => Promise<ProviderInfo[]>;
}
