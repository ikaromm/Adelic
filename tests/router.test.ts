import { describe, expect, it } from 'vitest';
import { routeMessage } from '../server/router.js';
import { memoryQueryTerms } from '../server/memory.js';

describe('adaptive router', () => {
  it('keeps direct conceptual questions fast even when long or technical', () => {
    expect(routeMessage('Explique o que é uma API REST e como ela funciona.', 'auto').level).toBe('fast');
    expect(routeMessage('Compare gato e cachorro em termos de personalidade.', 'auto').level).toBe('fast');
    expect(
      routeMessage(
        'Explique em bastante detalhe os fundamentos de TypeScript e como tipos estruturais ajudam a organizar uma aplicação grande.',
        'auto',
      ).level,
    ).toBe('fast');
  });
  it('routes short file, current research, and follow-up requests deeply', () => {
    const readme = routeMessage('Leia o README', 'auto');
    expect(readme).toMatchObject({ level: 'deep', tools: true, contextBudget: 24000, effort: 'high' });
    expect(routeMessage('Summarize the README', 'auto').tools).toBe(true);
    expect(routeMessage('Explique este código', 'auto').tools).toBe(true);
    expect(routeMessage('Pesquise a cotação atual do dólar', 'auto').tools).toBe(true);
    expect(
      routeMessage('e corrija esse problema agora', 'auto', [
        { id: '1', sessionId: 's', role: 'user', content: 'Leia o README', createdAt: '' },
      ]).level,
    ).toBe('deep');
  });
  it('routes explicit file paths and plural file or project references to tools', () => {
    for (const prompt of [
      'Leia src/App.tsx',
      'Read scripts/check.py',
      'Open config/project.json',
      'Leia os arquivos',
      'Read two files',
      'Analise os projetos',
    ]) {
      expect(routeMessage(prompt, 'auto')).toMatchObject({ level: 'deep', tools: true });
    }
    expect(routeMessage('Explique a versão 3.14', 'auto')).toMatchObject({ level: 'fast', tools: true, memory: false });
  });
  it('honors manual mode and never consults memory in fast mode', () => {
    expect(routeMessage('Leia o README', 'fast', [], true)).toMatchObject({
      level: 'fast',
      tools: true,
      memory: false,
      effort: 'low',
      contextBudget: 6000,
    });
    expect(routeMessage('Explique este conceito', 'deep')).toMatchObject({
      level: 'deep',
      effort: 'high',
      contextBudget: 24000,
    });
  });
  it('keeps ordinary creative and conceptual prompts fast while making tools available', () => {
    for (const prompt of [
      'Crie uma poesia',
      'Teste meus conhecimentos de história',
      'Como funciona um teste unitário?',
      'Explique o que é um teste unitário?',
      'O que significa commit?',
      'Como a web funciona?',
      'Como funciona o comando build?',
      'O que significa PR?',
      'Defina clima',
    ]) {
      expect(routeMessage(prompt, 'auto')).toMatchObject({ level: 'fast', tools: true, memory: false });
    }
    expect(routeMessage('Qual é o clima hoje?', 'auto').tools).toBe(true);
    expect(routeMessage('Rode o build do projeto', 'auto').tools).toBe(true);
    expect(routeMessage('Crie uma poesia', 'deep').tools).toBe(false);
  });
  it('searches memory by a short subject instead of the full request', () => {
    expect(memoryQueryTerms('Lembre o que decidimos sobre VPN e Tailscale no computador')).toEqual([
      'VPN',
      'Tailscale',
      'computador',
    ]);
    expect(memoryQueryTerms('O que decidimos sobre Adelic e memória?')).toEqual(['Adelic']);
  });
  it('routes architecture-spanning changes deeply in auto, including explicit continuations', () => {
    const request = 'Now change the Architecture Across Multiple Modules in the project.';
    expect(routeMessage(request, 'auto')).toMatchObject({
      level: 'deep',
      tools: true,
      effort: 'high',
      contextBudget: 24000,
    });
    expect(routeMessage(request, 'deep')).toMatchObject({ level: 'deep', tools: true });
    expect(routeMessage('Add a button to the UI. Also migrate the database and change the API.', 'auto')).toMatchObject(
      {
        level: 'deep',
        tools: true,
      },
    );
    expect(
      routeMessage('Now change it across multiple modules.', 'auto', [
        { id: '1', sessionId: 's', role: 'user', content: 'Add a small UI button.', createdAt: '' },
      ]),
    ).toMatchObject({ level: 'deep', tools: true });
    expect(routeMessage('What does software architecture mean?', 'auto').level).toBe('fast');
    expect(routeMessage('Explain the difference between UI and API.', 'auto')).toMatchObject({
      level: 'fast',
      tools: true,
    });
    expect(
      routeMessage('Now explain the difference between UI and API.', 'auto', [
        { id: '1', sessionId: 's', role: 'user', content: 'Implement a UI and API change.', createdAt: '' },
      ]).level,
    ).toBe('fast');
    expect(routeMessage('Add a UI button and migrate storage.', 'auto')).toMatchObject({
      level: 'deep',
      tools: true,
    });
    expect(routeMessage('Add a small button to the UI.', 'auto').level).toBe('fast');
  });
  it('routes inflected technical continuations with tools in auto and full modes', () => {
    const history = [
      {
        id: '1',
        sessionId: 's',
        role: 'user' as const,
        content: 'Implemente melhorias de recuperação em server/orchestrator.ts.',
        createdAt: '',
      },
    ];
    const prompt = 'Continue: fechar os bloqueadores e corrigir a formatação.';
    expect(routeMessage(prompt, 'auto', history)).toMatchObject({ level: 'deep', tools: true });
    expect(routeMessage(prompt, 'deep', history)).toMatchObject({ level: 'deep', tools: true });
    expect(
      routeMessage(prompt, 'auto', [
        ...history,
        { id: '2', sessionId: 's', role: 'user', content: 'What does routing mean?', createdAt: '' },
      ]).level,
    ).toBe('fast');
    expect(routeMessage('Corrigir server/router.ts', 'deep')).toMatchObject({ level: 'deep', tools: true });
    expect(routeMessage('Como funciona um roteador?', 'deep')).toMatchObject({ level: 'deep', tools: false });
  });

  it('routes inflected Portuguese edit imperatives in auto and full modes without promoting questions', () => {
    for (const prompt of [
      'Corrija src/App.tsx',
      'Corrigir src/App.tsx',
      'Corrige src/App.tsx',
      'Formate src/App.tsx',
      'Formatar src/App.tsx',
      'corrija o bug no projeto',
      'Formate os arquivos do projeto',
    ]) {
      expect(routeMessage(prompt, 'auto')).toMatchObject({ level: 'deep', tools: true });
      expect(routeMessage(prompt, 'deep')).toMatchObject({ level: 'deep', tools: true });
    }

    for (const prompt of ['Como se conjuga corrigir?', 'O que significa formatar?']) {
      expect(routeMessage(prompt, 'auto')).toMatchObject({ level: 'fast' });
      expect(routeMessage(prompt, 'deep')).toMatchObject({ level: 'deep', tools: false });
    }
  });

  it('delegates concrete software changes while keeping API definitions simple', () => {
    for (const prompt of [
      'Implemente uma rota de API',
      'Crie um endpoint',
      'Adicione um componente de login',
      'Create a database migration',
    ]) {
      expect(routeMessage(prompt, 'auto')).toMatchObject({ level: 'deep', tools: true });
    }
    expect(routeMessage('Explique o que é uma API REST', 'auto')).toMatchObject({
      level: 'fast',
      tools: true,
      memory: false,
    });
  });
});
