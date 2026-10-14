import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../server/orchestrator';
import { Store } from '../server/store';
import type { ProviderInfo, ProviderRegistry, RunInput, Session, StreamEvent } from '../shared/contracts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanup.splice(0).reverse()) clean();
});

function providerInfo(): ProviderInfo {
  return {
    id: 'codex',
    name: 'Codex',
    installed: true,
    available: true,
    status: 'ready',
    detail: 'fixture',
    models: [
      {
        id: 'model',
        name: 'Model',
        efforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'high',
        isDefault: true,
      },
    ],
    defaultModel: 'model',
    capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
  };
}

function setup(mode: Session['mode'] = 'auto', orchestrationEnabled = true, review = false, remote = false) {
  const directory = mkdtempSync(join(tmpdir(), 'adelic-continuity-'));
  const projectRoot = join(directory, 'project');
  mkdirSync(projectRoot);
  const store = new Store(directory);
  const now = new Date().toISOString();
  if (remote)
    store.putRemoteHost({
      id: 'host',
      name: 'Fixture host',
      target: 'fixture.invalid',
      port: 22,
      fingerprint: 'SHA256:fixture',
      hostKey: 'fixture-key',
      runnerPath: '/opt/adelic/runner',
      createdAt: now,
    });
  store.putProject({
    id: 'project',
    name: 'Project',
    path: projectRoot,
    ...(remote ? { remote: { hostId: 'host', path: '/srv/project' }, approvalMode: 'automatic' as const } : {}),
    createdAt: now,
    memoryWorkspace: 'workspace',
    memoryProject: 'project',
    graphify: { enabled: false },
    orchestration: { enabled: orchestrationEnabled, maxWorkers: 1, review },
  });
  const session: Session = {
    id: 'session',
    projectId: 'project',
    title: 'Continuity',
    providerId: 'codex',
    mode,
    approvalMode: 'automatic',
    createdAt: now,
    updatedAt: now,
  };
  store.putSession(session);
  const inputs: RunInput[] = [];
  const providers: ProviderRegistry = {
    async list() {
      return [providerInfo()];
    },
    async run(input) {
      inputs.push(input);
      if (input.prompt.includes('Produza somente JSON válido')) {
        return {
          text: JSON.stringify({
            tasks: [
              {
                id: 'retention',
                title: 'Implement retention policy',
                instructions:
                  'Implement the complete user request in retention.ts, preserving all stated requirements.',
                scope: ['retention.ts'],
                dependsOn: [],
              },
            ],
          }),
          stopReason: 'completed',
        };
      }
      return { text: 'R'.repeat(3000), stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const orchestrator = new Orchestrator(store, providers);
  cleanup.push(() => {
    void orchestrator.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, session, orchestrator, inputs };
}

async function completeRun(env: ReturnType<typeof setup>, content: string): Promise<string> {
  let terminal!: () => void;
  const finished = new Promise<void>((resolve) => (terminal = resolve));
  const unsubscribe = env.orchestrator.subscribe((event: StreamEvent) => {
    if (event.type === 'run' && event.run.sessionId === env.session.id && event.run.status !== 'running') {
      unsubscribe();
      terminal();
    }
  });
  const started = await env.orchestrator.start(env.session, content);
  if (env.store.getRun(started.runId)?.status !== 'running') {
    unsubscribe();
  } else {
    await finished;
  }
  return started.runId;
}

const rootGoal = 'Implement retention policy of seven days in retention.ts.';
const expansion = 'Now also change the UI, migrate the database storage and update the API in retention.ts.';
const requires = ['seven days', 'UI', 'database storage', 'API'];

describe('Orchestrator continuation context', () => {
  it.each([
    {
      name: 'Then apply it after two intermediate follow-ups',
      turns: [rootGoal, expansion, 'Now do it.', 'Then apply it.'],
      current: 'Then apply it.',
    },
    {
      name: 'Now implement it in retention.ts after the expansion',
      turns: [rootGoal, expansion, 'Now implement it in retention.ts.'],
      current: 'Now implement it in retention.ts.',
    },
  ])('$name', async ({ turns, current }) => {
    const env = setup();
    let finalRunId = '';
    for (const turn of turns) finalRunId = await completeRun(env, turn);

    const effectiveInputs = env.inputs.filter((input) => input.runId.startsWith(`${finalRunId}:`));
    const planner = effectiveInputs.find((input) => input.prompt.includes('Produza somente JSON válido'));
    const executor = effectiveInputs.find((input) => input.prompt.includes('Você é um executor delegado'));

    expect(planner, 'the automatic fallback must invoke the planner').toBeDefined();
    expect(executor, 'the planner result must be delivered to a delegated worker').toBeDefined();
    expect(env.store.getRun(finalRunId)?.route.level).toBe('deep');
    expect(planner!.prompt).toContain(current);
    expect(executor!.prompt).toContain(current);
    for (const requirement of requires) {
      expect(planner!.prompt).toContain(requirement);
      expect(executor!.prompt).toContain(requirement);
    }
    expect(planner!.prompt).toContain(rootGoal);
    expect(executor!.prompt).toContain(rootGoal);
  });

  it.each([
    'Implement an architecture across several modules.',
    'Implement retention policy of seven days in retention.ts.',
  ])('keeps a conceptual question short after the technical ancestor: %s', async (ancestor) => {
    const env = setup();
    await completeRun(env, ancestor);
    const runId = await completeRun(env, 'How does it work?');
    const effectiveInputs = env.inputs.filter((input) => input.runId.startsWith(`${runId}:`));

    expect(effectiveInputs).toHaveLength(1);
    expect(effectiveInputs[0].prompt).not.toContain('Produza somente JSON válido');
    expect(effectiveInputs[0].prompt).not.toContain('Você é um executor delegado');
    expect(effectiveInputs[0].prompt).not.toContain('Faça revisão independente');
    expect(effectiveInputs[0].prompt).not.toContain('Responda ao pedido completo');
    expect(effectiveInputs[0].prompt).toContain(ancestor);
    expect(effectiveInputs[0].prompt).toContain('How does it work?');
    expect(effectiveInputs[0].plan.level).toBe('fast');
    expect(env.store.getRun(runId)?.route).toMatchObject({ level: 'fast', tools: true });
  });

  it.each([
    { root: 'What is TypeScript?', question: 'Does it support generics?' },
    { root: 'What is TCP?', question: 'How does it work?' },
  ])('keeps a conceptual follow-up on the short route: $root → $question', async ({ root, question }) => {
    const env = setup();
    await completeRun(env, root);
    const runId = await completeRun(env, question);
    const effectiveInputs = env.inputs.filter((input) => input.runId.startsWith(`${runId}:`));

    expect(effectiveInputs).toHaveLength(1);
    expect(effectiveInputs[0].plan.level).toBe('fast');
    expect(effectiveInputs[0].plan.tools).toBe(true);
    expect(env.store.getRun(runId)?.route.tools).toBe(true);
    expect(effectiveInputs[0].prompt).toContain(root);
    expect(effectiveInputs[0].prompt).toContain(question);
    expect(effectiveInputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(false);
    expect(env.store.getRun(runId)?.route.level).toBe('fast');
  });

  it('keeps an isolated simple informational question on the short route', async () => {
    const env = setup();
    const runId = await completeRun(env, 'What time is it?');
    const effectiveInputs = env.inputs.filter((input) => input.runId.startsWith(`${runId}:`));

    expect(effectiveInputs).toHaveLength(1);
    expect(effectiveInputs[0].plan.level).toBe('fast');
    expect(effectiveInputs[0].plan.tools).toBe(true);
    expect(env.store.getRun(runId)?.route.tools).toBe(true);
    expect(env.store.getRun(runId)?.route.level).toBe('fast');
    expect(effectiveInputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(false);
  });

  it('preserves a user-selected fast route even for an unresolved continuation', async () => {
    const env = setup('fast');
    const runId = await completeRun(env, 'Then apply it.');
    const effectiveInputs = env.inputs.filter((input) => input.runId.startsWith(`${runId}:`));

    expect(effectiveInputs).toHaveLength(1);
    expect(effectiveInputs[0].plan.level).toBe('fast');
    expect(effectiveInputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(false);
  });

  it('delivers the resolved goal and refinement to the actual executor and configured reviewer', async () => {
    const env = setup('auto', true, true);
    await completeRun(env, 'Implement retention policy of seven days in retention.ts.');
    const continuation = 'Continue: close blockers and fix formatting in retention.ts.';
    const runId = await completeRun(env, continuation);
    const inputs = env.inputs.filter((input) => input.runId.startsWith(`${runId}:`));
    const worker = inputs.find((input) => input.prompt.includes('Você é um executor delegado'));
    const reviewer = inputs.find((input) => input.prompt.includes('Faça revisão independente'));

    expect(inputs.some((input) => input.prompt.includes('Produza somente JSON válido'))).toBe(false);
    expect(worker?.prompt).toContain('Implement retention policy of seven days in retention.ts.');
    expect(worker?.prompt).toContain(continuation);
    expect(worker?.prompt).toContain('A coordenação e a divisão de tarefas já foram feitas');
    expect(reviewer?.prompt).toContain('Implement retention policy of seven days in retention.ts.');
    expect(reviewer?.prompt).toContain(continuation);
    expect(reviewer?.plan.tools).toBe(true);
  });

  it.each([
    { name: 'isolated TCP question', prompt: 'What is TCP?' },
    { name: 'current branch inspection', prompt: 'What is my current git branch?' },
    { name: 'conceptual follow-up', ancestor: 'What is TCP?', prompt: 'How does it work?' },
    {
      name: 'technical-context follow-up',
      ancestor: 'Implement retention policy of seven days in retention.ts.',
      prompt: 'How does it work?',
    },
  ])('keeps $name tool-capable in both direct and coordinated execution', async ({ ancestor, prompt }) => {
    for (const orchestrationEnabled of [false, true]) {
      const env = setup('auto', orchestrationEnabled);
      if (ancestor) await completeRun(env, ancestor);
      const runId = await completeRun(env, prompt);
      const effectiveInputs = env.inputs.filter(
        (input) => input.runId === runId || input.runId.startsWith(`${runId}:`),
      );

      expect(effectiveInputs).toHaveLength(1);
      expect(env.store.getRun(runId)?.route).toMatchObject({ level: 'fast', tools: true, memory: false });
      expect(effectiveInputs[0].plan).toMatchObject({ level: 'fast', tools: true, memory: false });
      expect(effectiveInputs[0].prompt).toContain(prompt);
      if (ancestor) expect(effectiveInputs[0].prompt).toContain(ancestor);
      expect(effectiveInputs[0].prompt).not.toContain('Produza somente JSON válido');
      expect(effectiveInputs[0].prompt).not.toContain('Faça revisão independente');
      expect(effectiveInputs[0].prompt).not.toContain('Responda ao pedido completo');
    }
  });

  it.each([
    { name: 'local with persisted evidence', remote: false, failPersistence: false, available: true },
    { name: 'local without persisted evidence', remote: false, failPersistence: true, available: false },
    { name: 'remote despite persisted evidence', remote: true, failPersistence: false, available: false },
  ])(
    '$name keeps the reviewer prompt aligned with effective MCP configuration',
    async ({ remote, failPersistence, available }) => {
      const env = setup('auto', true, true, remote);
      if (failPersistence) {
        (env.orchestrator.runEvidence as unknown as { put: () => Promise<string | undefined> }).put = async () =>
          undefined;
      }
      const runId = await completeRun(env, 'Implement retention policy across several modules.');
      const inputs = env.inputs.filter((input) => input.runId.startsWith(`${runId}:`));
      const reviewer = inputs.find((input) => input.prompt.includes('Faça revisão independente'));
      expect(reviewer).toBeDefined();
      expect(reviewer!.prompt).toContain(
        available
          ? 'A ferramenta get_run_evidence está disponível'
          : 'A ferramenta get_run_evidence não está disponível',
      );
      expect(reviewer!.mcpServers?.some((server) => server.name === 'adelic-run-evidence') ?? false).toBe(available);
      expect(reviewer!.plan.tools).toBe(true);
      if (remote) {
        expect(reviewer!.remote?.executionKind).toBe('ssh');
        expect(reviewer!.mcpServers).toBeUndefined();
      }
    },
  );
});
