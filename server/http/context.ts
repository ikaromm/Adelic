import type { Store } from '../store.js';
import type { Orchestrator } from '../orchestrator.js';
import type { ExecutionBudget, ProviderInfo } from '../../shared/contracts.js';
import type { AutomationService } from '../automations.js';

/** Dependencies shared by the route modules, built once in createBackend. */
export interface BackendContext {
  store: Store;
  orchestrator: Orchestrator;
  providerList: () => Promise<ProviderInfo[]>;
  automations: AutomationService;
  defaultExecutionBudget?: Pick<ExecutionBudget, 'totalMs' | 'finalizationReserveMs'>;
}
