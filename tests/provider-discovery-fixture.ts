/**
 * Deterministic provider registry for HTTP/runtime fixtures whose assertions concern routes,
 * listeners or bootstrap wiring rather than installed host CLIs. Kept test-only: tests for real
 * provider discovery and behavior must not use this fixture.
 */
const providerIds = ['codex', 'claude', 'kiro', 'opencode'] as const;

const providers = providerIds.map((id) => ({
  id,
  name: `${id} fixture`,
  installed: true,
  available: true,
  status: 'ready',
  detail: 'Deterministic HTTP fixture provider',
  models: [{ id: 'fixture-model', name: 'Fixture model', isDefault: true }],
  defaultModel: 'fixture-model',
  capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: false },
}));

export function createProviderRegistry() {
  return {
    list: async () => providers,
    run: async () => ({ text: 'fixture run', stopReason: 'completed' }),
    approve: async () => {},
    steer: async () => false,
    shutdown: async () => {},
  };
}
