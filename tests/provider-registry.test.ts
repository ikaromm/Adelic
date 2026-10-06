import { describe, expect, it, vi } from 'vitest';
import { createProviderRegistry } from '../server/providers/index.js';
import type { ProviderEvent, ProviderId, ProviderInfo, RunInput } from '../shared/contracts.js';

const info = (id: ProviderId): ProviderInfo => ({
  id,
  name: id,
  installed: true,
  available: true,
  status: 'ready',
  detail: '',
  models: [],
  capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
});
function fake(id: ProviderId) {
  let release: () => void = () => {};
  return {
    info: vi.fn(async () => info(id)),
    approve: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    release: () => release(),
    run: vi.fn(async (input: RunInput, emit: (e: ProviderEvent) => void) => {
      emit({
        type: 'approval',
        approval: {
          id: `${input.runId}:1`,
          runId: input.runId,
          sessionId: input.sessionId,
          title: 't',
          detail: '',
          kind: 'command',
          status: 'pending',
        },
      });
      await new Promise<void>((r) => (release = r));
      return { text: '', stopReason: 'completed' as const };
    }),
  };
}
const input = (providerId: ProviderId, runId: string) => ({ providerId, runId, sessionId: 's' }) as RunInput;

describe('provider registry', () => {
  it('lists every provider once even with concurrent callers', async () => {
    const providers = { codex: fake('codex'), claude: fake('claude'), kiro: fake('kiro'), opencode: fake('opencode') };
    const registry = createProviderRegistry(undefined, providers);
    const [a, b] = await Promise.all([registry.list(), registry.list()]);
    expect(a.map((p) => p.id)).toEqual(['codex', 'claude', 'kiro', 'opencode']);
    expect(b).toBe(a);
    expect(providers.codex.info).toHaveBeenCalledTimes(1);
  });
  it('routes a decision only to the provider that asked, and only while the run is active', async () => {
    const providers = { codex: fake('codex'), claude: fake('claude'), kiro: fake('kiro'), opencode: fake('opencode') };
    const registry = createProviderRegistry(undefined, providers);
    const running = registry.run(input('kiro', 'r1'), () => {}, new AbortController().signal);
    await vi.waitFor(() => expect(providers.kiro.run).toHaveBeenCalled());
    await registry.approve('r1:1', 'approve');
    expect(providers.kiro.approve).toHaveBeenCalledWith('r1:1', 'approve');
    expect(providers.codex.approve).not.toHaveBeenCalled();
    await expect(registry.approve('r1:1', 'deny')).rejects.toThrow(/não está mais pendente/);
    await expect(registry.approve('unknown', 'approve')).rejects.toThrow(/não está mais pendente/);
    providers.kiro.release();
    await running;
  });
  it('forgets pending approvals when their run ends', async () => {
    const providers = { codex: fake('codex'), claude: fake('claude'), kiro: fake('kiro'), opencode: fake('opencode') };
    const registry = createProviderRegistry(undefined, providers);
    const running = registry.run(input('codex', 'r2'), () => {}, new AbortController().signal);
    await vi.waitFor(() => expect(providers.codex.run).toHaveBeenCalled());
    providers.codex.release();
    await running;
    await expect(registry.approve('r2:1', 'approve')).rejects.toThrow(/não está mais pendente/);
    expect(providers.codex.approve).not.toHaveBeenCalled();
  });
  it('shuts every provider down', async () => {
    const providers = { codex: fake('codex'), claude: fake('claude'), kiro: fake('kiro'), opencode: fake('opencode') };
    await createProviderRegistry(undefined, providers).shutdown();
    for (const p of Object.values(providers)) expect(p.shutdown).toHaveBeenCalledTimes(1);
  });
});
