import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, ProviderRegistry, RunInput, Session, Settings } from '../shared/contracts.js';
import { Store } from '../server/store.js';
import { Orchestrator } from '../server/orchestrator.js';
import { createBackend } from '../server/index.js';
import { routeMessage } from '../server/router.js';
import { memoryQueryTerms } from '../server/memory.js';
import { SettingsPatchSchema, parseBody } from '../shared/schemas.js';

// "Memória das conversas avulsas" (docs/specs/shared-memory.md): detached conversations search
// the scope chosen in Settings, and only that one. The memory loader is a test double; nothing
// reaches a real ai-memory service.
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Lookup = { workspace: string; project: string; path: string; query: string };

function setup(settings: Partial<Settings>, mode: Session['mode'] = 'auto', projectId: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-detached-memory-'));
  dirs.push(dir);
  const store = new Store(dir);
  const now = new Date().toISOString();
  store.setSettings({ ...store.getSettings()!, ...settings });
  store.putProject({
    id: 'p',
    name: 'P',
    path: dir,
    createdAt: now,
    memoryWorkspace: 'pessoal',
    memoryProject: 'adelic',
    graphify: { enabled: false },
  });
  const session: Session = {
    id: 's',
    projectId,
    title: 'T',
    providerId: 'codex',
    mode,
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const lookups: Lookup[] = [];
  const inputs: RunInput[] = [];
  const providers: ProviderRegistry = {
    async list() {
      return [
        {
          id: 'codex',
          name: 'stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: 'test',
          models: [],
          capabilities: { fast: true, tools: true, approvals: true, cancel: true },
        },
      ];
    },
    async run(input, emit) {
      inputs.push(input);
      if (input.prompt.includes('Produza somente JSON válido'))
        return {
          text: JSON.stringify({
            tasks: [{ id: 'w', title: 'Work', instructions: 'do it', scope: [], dependsOn: [] }],
          }),
          stopReason: 'completed',
        };
      if (input.prompt.includes('Faça revisão independente')) return { text: 'Reviewed', stopReason: 'completed' };
      emit({ type: 'delta', text: 'ok' });
      return { text: 'ok', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const loader = async (project: Project, query: string) => {
    lookups.push({ workspace: project.memoryWorkspace, project: project.memoryProject, path: project.path, query });
    if (query.includes('NADA')) return undefined;
    return 'Fonte: infra/vm.md\nA VM de testes fica em 10.0.0.42.';
  };
  const orchestrator = new Orchestrator(store, providers, loader);
  const run = async (content: string) => {
    const done = new Promise<void>((resolve) =>
      orchestrator.subscribe((e) => {
        if (e.type === 'run' && e.run.status !== 'running') resolve();
      }),
    );
    await orchestrator.start(store.getSession('s')!, content);
    await done;
  };
  return { dir, store, orchestrator, lookups, inputs, run };
}

describe('detached conversation memory', () => {
  it('searches the configured scope and sends the memory block', async () => {
    const t = setup({ memoryEnabled: true, detachedMemory: { workspace: 'pessoal', project: 'ambiente-ikaromm' } });
    await t.run('busca na memória o IP da VM');
    expect(t.lookups).toHaveLength(1);
    expect(t.lookups[0]).toMatchObject({ workspace: 'pessoal', project: 'ambiente-ikaromm' });
    // The pseudo-project keeps the conversation's own folder, never the project's.
    expect(t.lookups[0].path).toBe(join(t.dir, 'conversations', 's'));
    expect(t.inputs).toHaveLength(1);
    const [input] = t.inputs;
    expect(t.store.listRuns('s')[0].route.memory).toBe(true);
    expect(input.memoryContext).toContain('DADOS DE MEMÓRIA NÃO CONFIÁVEIS');
    expect(input.memoryContext).toContain('Escopo de memória consultado: pessoal/ambiente-ikaromm');
    expect(input.memoryContext).toContain('10.0.0.42');
    expect(input.cwd).toBe(join(t.dir, 'conversations', 's'));
    // Detached runs still get no MCP servers.
    expect(input.mcpServers).toBeUndefined();
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('names the searched scope when nothing is found, without searching other scopes', async () => {
    const t = setup({ memoryEnabled: true, detachedMemory: { workspace: 'pessoal', project: 'ambiente-ikaromm' } });
    await t.run('NADA: você lembra o IP da VM?');
    expect(t.lookups.map((l) => `${l.workspace}/${l.project}`)).toEqual(['pessoal/ambiente-ikaromm']);
    expect(t.inputs[0].memoryContext).toContain(
      'nenhuma nota pertinente foi encontrada no escopo de memória pessoal/ambiente-ikaromm',
    );
    expect(t.inputs[0].memoryContext).toContain('Nenhum outro escopo foi consultado');
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('keeps detached conversations without memory when the scope is not set or memory is off', async () => {
    for (const settings of [
      { memoryEnabled: true },
      { memoryEnabled: true, detachedMemory: null },
      { memoryEnabled: false, detachedMemory: { workspace: 'pessoal', project: 'ambiente-ikaromm' } },
    ]) {
      const t = setup(settings);
      await t.run('busca na memória o IP da VM');
      expect(t.lookups).toHaveLength(0);
      expect(t.inputs.length).toBeGreaterThan(0);
      expect(t.store.listRuns('s')[0].route.memory).toBe(false);
      for (const input of t.inputs) {
        expect(input.memoryContext).toBeUndefined();
        expect(input.prompt).not.toContain('Use a memória somente');
      }
      await t.orchestrator.shutdown();
      t.store.close();
    }
  });

  it('passes the memory block to the planner and workers of a coordinated detached run', async () => {
    const t = setup(
      { memoryEnabled: true, detachedMemory: { workspace: 'pessoal', project: 'ambiente-ikaromm' } },
      'deep',
    );
    await t.run('Lembre a decisão na memória e implemente uma função no servidor backend com testes');
    expect(t.lookups).toHaveLength(1);
    const planner = t.inputs.find((i) => i.prompt.includes('Produza somente JSON válido'));
    const worker = t.inputs.find((i) => i.prompt.includes('Você é um executor delegado'));
    for (const input of [planner, worker]) {
      expect(input?.memoryContext).toContain('pessoal/ambiente-ikaromm');
      expect(input?.prompt).toContain('escopo pessoal/ambiente-ikaromm');
    }
    await t.orchestrator.shutdown();
    t.store.close();
  });

  it('project conversations keep their own scope and ignore the detached setting', async () => {
    const t = setup(
      { memoryEnabled: true, detachedMemory: { workspace: 'pessoal', project: 'ambiente-ikaromm' } },
      'auto',
      'p',
    );
    await t.run('NADA: search memory for the VM IP');
    expect(t.lookups.map((l) => `${l.workspace}/${l.project}`)).toEqual(['pessoal/adelic']);
    const withMemory = t.inputs.find((i) => i.memoryContext);
    expect(withMemory?.memoryContext).toContain('no escopo de memória pessoal/adelic');
    await t.orchestrator.shutdown();
    t.store.close();
  });
});

describe('explicit memory requests', () => {
  it.each([
    'busca na memória o IP da VM',
    'Busque na memória o IP da VM',
    'procura nas memórias o IP',
    'você lembra o IP da VM?',
    'consegue lembrar o IP da VM?',
    'search memory for the VM IP',
    'remember the VM IP?',
    'what is the VM IP from memory',
    'recall the VM IP',
    'check your memories about the VM',
  ])('%s → memory when enabled', (prompt) => {
    expect(routeMessage(prompt, 'auto', [], true).memory).toBe(true);
    expect(routeMessage(prompt, 'deep', [], true).memory).toBe(true);
    expect(routeMessage(prompt, 'auto', [], false).memory).toBe(false);
    expect(routeMessage(prompt, 'fast', [], true).memory).toBe(false);
  });
  it('does not search memory for ordinary questions', () => {
    expect(routeMessage('Qual o IP da VM?', 'auto', [], true).memory).toBe(false);
    expect(routeMessage('Leia o README', 'auto', [], true).memory).toBe(false);
  });
  it('searches by the subject, not by the request verbs', () => {
    expect(memoryQueryTerms('busca na memória o IP da VM')).toEqual(['IP', 'VM']);
    expect(memoryQueryTerms('search memory for the VM IP')).toEqual(['VM', 'IP']);
    expect(memoryQueryTerms('você lembra a senha do wifi?')).toEqual(['senha', 'wifi']);
  });
});

describe('detachedMemory setting', () => {
  it('accepts null or a scope with the project memory rules', () => {
    expect(parseBody(SettingsPatchSchema, { detachedMemory: null }, 'x')).toEqual({
      ok: true,
      data: { detachedMemory: null },
    });
    expect(
      parseBody(SettingsPatchSchema, { detachedMemory: { workspace: ' pessoal ', project: 'ambiente-ikaromm' } }, 'x'),
    ).toEqual({ ok: true, data: { detachedMemory: { workspace: 'pessoal', project: 'ambiente-ikaromm' } } });
    for (const detachedMemory of [
      { workspace: '', project: 'x' },
      { workspace: 'w' },
      { workspace: 'w', project: 'x'.repeat(101) },
      { workspace: 'w', project: 'p', extra: 1 },
      'pessoal/ambiente-ikaromm',
      false,
    ])
      expect(parseBody(SettingsPatchSchema, { detachedMemory }, 'x')).toEqual({
        ok: false,
        message: 'detachedMemory deve ser null ou { workspace, project } (até 100 caracteres cada)',
      });
  });
  it('is saved and cleared through PATCH /api/settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-detached-memory-api-'));
    dirs.push(dir);
    const store = new Store(dir);
    const providers: ProviderRegistry = {
      async list() {
        return [];
      },
      async run() {
        return { text: '', stopReason: 'completed' };
      },
      async approve() {},
      async shutdown() {},
    };
    const { app, orchestrator } = createBackend(store, providers);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const patch = (body: unknown) =>
      fetch(`${base}/api/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(body),
      });
    const saved = await patch({ detachedMemory: { workspace: 'pessoal', project: 'ambiente-ikaromm' } });
    expect(saved.status).toBe(200);
    expect(store.getSettings()?.detachedMemory).toEqual({ workspace: 'pessoal', project: 'ambiente-ikaromm' });
    expect((await patch({ detachedMemory: { workspace: 'pessoal' } })).status).toBe(400);
    expect(store.getSettings()?.detachedMemory).toEqual({ workspace: 'pessoal', project: 'ambiente-ikaromm' });
    expect((await patch({ detachedMemory: null })).status).toBe(200);
    expect(store.getSettings()?.detachedMemory).toBeNull();
    await orchestrator.shutdown();
    store.close();
  });
});
