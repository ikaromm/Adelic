import { describe, expect, it } from 'vitest';
import { ProviderContextDiagnosticsSchema } from '../shared/schemas.js';
import { measureContextText, providerAssembledPrompt, providerContextDiagnostics } from '../server/providers/common.js';
import type { RunInput } from '../shared/contracts.js';

function input(overrides: Partial<RunInput> = {}): RunInput {
  return {
    runId: 'r',
    sessionId: 's',
    providerId: 'codex',
    cwd: '/',
    prompt: 'pedido 🧠',
    history: [{ id: 'm', sessionId: 's', role: 'user', content: 'olá', createdAt: '' }],
    plan: { level: 'deep', reason: '', tools: false, memory: false, contextBudget: 10 },
    sandbox: 'read-only',
    ...overrides,
  } as RunInput;
}

describe('provider input context diagnostics', () => {
  it('measures observed unicode input fields without retaining content or inventing tokens', () => {
    const diagnostic = providerContextDiagnostics(input({ summary: 'é', memoryContext: '記憶' }));
    expect(diagnostic).toMatchObject({
      scope: 'adelic_run_input',
      unit: 'characters_and_utf8_bytes',
      tokenizer: 'unavailable',
      categories: {
        currentRequest: { characters: 9, bytes: Buffer.byteLength('pedido 🧠') },
        history: { characters: 3, bytes: 4 },
        summary: { characters: 1, bytes: 2 },
        memory: { characters: 2, bytes: 6 },
        skills: { characters: null, bytes: null },
        graph: { characters: null, bytes: null },
        evidence: { characters: null, bytes: null },
      },
      runtimeAddedContext: 'unknown',
    });
    expect(diagnostic.observedText).toEqual({ characters: 15, bytes: 23 });
    expect(JSON.stringify(diagnostic)).not.toContain('pedido');
    expect(ProviderContextDiagnosticsSchema.parse(diagnostic)).toEqual(diagnostic);
  });

  it('marks absent optional fields as zero, but opaque runtime and embedded categories unknown', () => {
    const diagnostic = providerContextDiagnostics(input());
    expect(diagnostic.categories.memory).toEqual({ characters: 0, bytes: 0 });
    expect(diagnostic.categories.summary).toEqual({ characters: 0, bytes: 0 });
    expect(diagnostic.categories.skills).toEqual({ characters: null, bytes: null });
    expect(diagnostic.runtimeAddedContext).toBe('unknown');
  });

  it('separates 40-message raw context from the bounded prompt actually assembled for the provider', () => {
    const run = input({
      prompt: 'pedido atual',
      history: Array.from({ length: 40 }, (_, index) => ({
        id: String(index),
        sessionId: 's',
        role: 'user' as const,
        content: 'x'.repeat(1000),
        createdAt: '',
      })),
      memoryContext: 'm'.repeat(1000),
      plan: { level: 'deep', reason: '', tools: false, memory: false, contextBudget: 5 },
    });
    const diagnostic = providerContextDiagnostics(run);
    expect(diagnostic.categories.history.characters).toBe(40_000);
    expect(diagnostic.categories.memory.characters).toBe(1_000);
    expect(diagnostic.assembledPrompt).toEqual({ characters: 84, bytes: 88 });
    expect(diagnostic.tokenizer).toBe('unavailable');
    expect(ProviderContextDiagnosticsSchema.parse(diagnostic)).toEqual(diagnostic);
  });

  it('conserves raw Unicode text while partitioning composed skills, graph and evidence once', () => {
    const skill = '技能';
    const graph = 'graph🧠';
    const evidence = '✓';
    const prompt = `req-é|${skill}|${graph}|${evidence}`;
    const run = input({
      prompt,
      history: [],
      summary: 'é',
      memoryContext: '記憶',
      contextComponents: {
        skills: measureContextText(skill),
        graph: measureContextText(graph),
        evidence: measureContextText(evidence),
      },
    });
    const diagnostic = providerContextDiagnostics(run);
    const categories = diagnostic.categories;
    expect(categories.skills).toEqual(measureContextText(skill));
    expect(categories.graph).toEqual(measureContextText(graph));
    expect(categories.evidence).toEqual(measureContextText(evidence));
    expect(categories.currentRequest.characters! + skill.length + graph.length + evidence.length).toBe(prompt.length);
    expect(
      categories.currentRequest.bytes! +
        categories.skills.bytes! +
        categories.graph.bytes! +
        categories.evidence.bytes!,
    ).toBe(Buffer.byteLength(prompt, 'utf8'));
    expect(diagnostic.observedText.characters).toBe(prompt.length + 'é'.length + '記憶'.length);
    expect(JSON.stringify(diagnostic)).not.toContain(skill);
    expect(JSON.stringify(diagnostic)).not.toContain(graph);
    expect(JSON.stringify(diagnostic)).not.toContain(evidence);
    expect(ProviderContextDiagnosticsSchema.parse(diagnostic)).toEqual(diagnostic);
  });

  it('includes Kiro isolated-executor instructions in the measured assembled prompt', () => {
    const kiro = input({
      providerId: 'kiro',
      plan: { level: 'deep', reason: '', tools: true, memory: false, contextBudget: 10 },
      remote: {
        label: 'Local isolado',
        root: '/workspace',
        executionKind: 'isolated-local',
        call: async () => ({ ok: true }),
      },
    });
    const assembled = providerAssembledPrompt(kiro);
    const diagnostic = providerContextDiagnostics(kiro);
    expect(assembled).toContain('[EXECUTOR ISOLADO]');
    expect(diagnostic.assembledPrompt).toEqual({
      characters: assembled.length,
      bytes: Buffer.byteLength(assembled, 'utf8'),
    });
    expect(JSON.stringify(diagnostic)).not.toContain('/workspace');
  });
});
