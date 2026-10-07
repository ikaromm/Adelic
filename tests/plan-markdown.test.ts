import { describe, expect, it } from 'vitest';
import type { Plan } from '../shared/contracts.js';
import {
  PLAN_PROMPT_MARKER,
  TASK_PROMPT_MARKER,
  buildPlanningPrompt,
  buildTaskPrompt,
  mergeTasks,
  parsePlanMarkdown,
  planCommand,
  planSlug,
  sectionOf,
  taskLabel,
} from '../server/plan-markdown.js';

const spec = `# Exportar CSV

## Requisitos
1. O botão **Exportar** baixa um CSV.
2. Linhas vazias não entram.

## Design
Usar \`papaparse\`? Não: gerar à mão.

Arquivos: \`src/export.ts\`.

## Tarefas
- [ ] Criar \`src/export.ts\` com testes
- [ ] Ligar o botão na tela
`;

describe('plan Markdown parsing', () => {
  it('reads the three sections, the title and the checklist', () => {
    const parsed = parsePlanMarkdown(spec);
    expect(parsed).toMatchObject({ title: 'Exportar CSV', structured: true });
    expect(parsed.requirements).toBe('1. O botão **Exportar** baixa um CSV.\n2. Linhas vazias não entram.');
    expect(parsed.design).toContain('Arquivos: `src/export.ts`.');
    expect(parsed.tasks).toEqual([{ text: 'Criar `src/export.ts` com testes' }, { text: 'Ligar o botão na tela' }]);
  });

  it('accepts odd headings: numbering, other levels, bold lines, English names, emoji and CRLF', () => {
    const odd = [
      '### 1. Requisitos funcionais',
      '- Deve funcionar',
      '**Design:**',
      'Texto do design',
      '#### Seção 3 — Tarefas 🛠️',
      '* [x] Já feita no rascunho',
      '1. [ ] Numerada com caixa',
      '+ Sem caixa',
    ].join('\r\n');
    const parsed = parsePlanMarkdown(odd);
    expect(parsed.requirements).toBe('- Deve funcionar');
    expect(parsed.design).toBe('Texto do design');
    expect(parsed.tasks.map((t) => t.text)).toEqual(['Já feita no rascunho', 'Numerada com caixa', 'Sem caixa']);
    expect(parsePlanMarkdown('## Requirements\nr\n## Approach\nd\n## Tasks\n- [ ] t').tasks).toEqual([{ text: 't' }]);
    expect(sectionOf('Tarefas:')).toBe('tasks');
    expect(sectionOf('Resumo')).toBeUndefined();
  });

  it('keeps nested lists and continuation lines as task details', () => {
    const parsed = parsePlanMarkdown(
      [
        '## Tarefas',
        '- [ ] Criar a tabela',
        '  - coluna id',
        '  - coluna data',
        '',
        '    detalhe mais fundo',
        '- [ ] Escrever a rota',
        '  Verificar com `npm test`.',
        'Parágrafo depois da lista.',
      ].join('\n'),
    );
    expect(parsed.tasks).toEqual([
      { text: 'Criar a tabela', details: '- coluna id\n- coluna data\n\n  detalhe mais fundo' },
      { text: 'Escrever a rota', details: 'Verificar com `npm test`.' },
    ]);
  });

  it('falls back to the whole text as design, with checkbox items only, when no section is found', () => {
    const plain = parsePlanMarkdown('Vou fazer assim:\n\n- passo solto\n- [ ] caixa solta');
    expect(plain).toMatchObject({
      structured: false,
      requirements: '',
      design: expect.stringContaining('passo solto'),
    });
    expect(plain.tasks).toEqual([{ text: 'caixa solta' }]);
    expect(parsePlanMarkdown('Só texto, nenhuma tarefa.').tasks).toEqual([]);
    // Sections present but no tasks: the UI asks the user to edit the plan.
    expect(parsePlanMarkdown('## Requisitos\n1. x\n## Design\ny').tasks).toEqual([]);
  });

  it('ignores headings inside code fences and unwraps a fence around the whole answer', () => {
    const fenced = parsePlanMarkdown(
      '```markdown\n## Design\nver:\n```sh\n## Tarefas\n```\n## Tarefas\n- [ ] real\n```',
    );
    expect(fenced.design).toContain('## Tarefas');
    expect(fenced.tasks).toEqual([{ text: 'real' }]);
  });

  it('ends a section at a sibling heading and keeps subheadings inside it', () => {
    const parsed = parsePlanMarkdown('## Design\n### Arquivos\na.ts\n## Riscos\nnenhum\n## Tarefas\n- [ ] t');
    expect(parsed.design).toBe('### Arquivos\na.ts');
    expect(parsed.tasks).toHaveLength(1);
  });

  it('bounds the number and size of tasks', () => {
    const many = parsePlanMarkdown(`## Tarefas\n${Array.from({ length: 80 }, (_, i) => `- [ ] t${i}`).join('\n')}`);
    expect(many.tasks).toHaveLength(50);
    expect(parsePlanMarkdown(`## Tarefas\n- [ ] ${'x'.repeat(900)}`).tasks[0].text).toHaveLength(500);
  });
});

describe('plan prompts and helpers', () => {
  it('detects the /plano prefix only at the start', () => {
    expect(planCommand('/plano exportar CSV')).toBe('exportar CSV');
    expect(planCommand('  /PLANO\nexportar')).toBe('exportar');
    expect(planCommand('/plano')).toBe('');
    expect(planCommand('/planos de saúde')).toBeUndefined();
    expect(planCommand('faça um /plano')).toBeUndefined();
  });

  it('asks for a read-only spec with the three sections in pt-BR', () => {
    const prompt = buildPlanningPrompt('exportar CSV');
    expect(prompt.startsWith(PLAN_PROMPT_MARKER)).toBe(true);
    for (const part of ['## Requisitos', '## Design', '## Tarefas', '- [ ]', 'Não altere arquivos', 'português'])
      expect(prompt).toContain(part);
    expect(prompt).toContain('Pedido do usuário:\nexportar CSV');
  });

  it('builds a task prompt with the approved plan and only the current task to do', () => {
    const plan: Plan = {
      id: 'p',
      sessionId: 's',
      runId: 'r',
      title: 'T',
      status: 'executing',
      requirements: '1. R',
      design: 'D',
      markdown: '',
      tasks: [
        { id: 'a', text: 'Primeira', status: 'done' },
        { id: 'b', text: 'Segunda', status: 'running', details: '- detalhe' },
        { id: 'c', text: 'Terceira', status: 'skipped' },
      ],
      createdAt: '',
      updatedAt: '',
    };
    const prompt = buildTaskPrompt(plan, plan.tasks[1]);
    expect(prompt.startsWith(TASK_PROMPT_MARKER)).toBe(true);
    expect(prompt).toContain('tarefa 2 de 3');
    expect(prompt).toContain('Tarefa atual: Segunda\n- detalhe');
    expect(prompt).toContain('- [x] Primeira (concluída)');
    expect(prompt).toContain('- [ ] Segunda ← tarefa atual');
    expect(prompt).toContain('- [-] Terceira (pulada pelo usuário)');
    expect(prompt).toContain('## Requisitos\n1. R');
    expect(taskLabel(plan, plan.tasks[2])).toBe('Tarefa 3/3 do plano: Terceira');
  });

  it('keeps status and ids of unchanged tasks when the Markdown is edited', () => {
    const previous = [
      { id: 'a', text: 'Criar tabela', status: 'done' as const, runId: 'r1' },
      { id: 'b', text: 'Escrever rota', status: 'failed' as const, error: 'x' },
    ];
    const merged = mergeTasks(previous, [{ text: 'criar  TABELA' }, { text: 'Nova' }, { text: 'Escrever rota' }]);
    expect(merged[0]).toMatchObject({ id: 'a', status: 'done', runId: 'r1', text: 'criar  TABELA' });
    expect(merged[1]).toMatchObject({ status: 'pending', text: 'Nova' });
    expect(merged[1].id).not.toMatch(/^[ab]$/);
    expect(merged[2]).toMatchObject({ id: 'b', status: 'failed' });
  });

  it('makes file-safe slugs', () => {
    expect(planSlug('Exportação de CSV: v2!')).toBe('exportacao-de-csv-v2');
    expect(planSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(planSlug('???')).toBe('plano');
  });
});
