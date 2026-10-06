import type { ProviderEvent, ProviderInfo, ProviderId, ProviderRegistry, RunInput } from '../../shared/contracts';
import { CodexProvider } from './codex';
import { ClaudeProvider } from './claude';
import { KiroProvider } from './kiro';
import { OpenCodeProvider } from './opencode';

export function createProviderRegistry(dataDir?: string): ProviderRegistry {
  const providers = {
    codex: new CodexProvider(undefined, undefined, undefined, dataDir),
    claude: new ClaudeProvider(),
    kiro: new KiroProvider(),
    opencode: new OpenCodeProvider(),
  };
  const approvalOwners = new Map<string, ProviderId>();
  let listing: Promise<ProviderInfo[]> | undefined;
  return {
    async list(): Promise<ProviderInfo[]> {
      if (!listing) {
        listing = Promise.all([
          providers.codex.info(),
          providers.claude.info(),
          providers.kiro.info(),
          providers.opencode.info(),
        ])
          .then(([codex, claude, kiro, opencode]) => [codex, claude, kiro, opencode])
          .finally(() => {
            listing = undefined;
          });
      }
      return listing;
    },
    async run(input: RunInput, emit: (event: ProviderEvent) => void, signal: AbortSignal) {
      const provider = providers[input.providerId];
      try {
        return await provider.run(
          input,
          (event) => {
            if (event.type === 'approval' && event.approval.status === 'pending')
              approvalOwners.set(event.approval.id, input.providerId);
            emit(event);
          },
          signal,
        );
      } finally {
        for (const [id, owner] of approvalOwners)
          if (owner === input.providerId && id.startsWith(`${input.runId}:`)) approvalOwners.delete(id);
      }
    },
    async approve(approvalId, decision) {
      const owner = approvalOwners.get(approvalId);
      if (!owner) throw new Error('Aprovação não está mais pendente.');
      await providers[owner].approve(approvalId, decision);
      approvalOwners.delete(approvalId);
    },
    async shutdown() {
      await Promise.all([
        providers.codex.shutdown(),
        providers.claude.shutdown(),
        providers.kiro.shutdown(),
        providers.opencode.shutdown(),
      ]);
      approvalOwners.clear();
    },
  };
}
