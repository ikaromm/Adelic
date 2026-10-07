import { describe, expect, it } from 'vitest';
import { changesSummary, diffLines } from '../src/run-activity';
import { restoreSentence } from '../src/components/RunChanges';

describe('run changes in the UI', () => {
  it('summarizes files and line counts', () => {
    const files = [
      { path: 'a', status: 'modified' as const, additions: 10, deletions: 4 },
      { path: 'b', status: 'added' as const, additions: 2, deletions: 0 },
      { path: 'c.png', status: 'added' as const, additions: 0, deletions: 0, binary: true },
    ];
    expect(changesSummary(files)).toBe('Alterou 3 arquivos (+12 −4)');
    expect(changesSummary(files.slice(0, 1))).toBe('Alterou 1 arquivo (+10 −4)');
    expect(changesSummary(files, 2)).toBe('Alterou 5 arquivos (+12 −4)');
  });

  it('colors only lines inside hunks; file headers stay metadata', () => {
    const diff = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' igual',
      '-velho',
      '+novo',
      '\\ No newline at end of file',
      'diff --git a/y b/y',
      '+++ b/y',
      '',
    ].join('\n');
    expect(diffLines(diff).map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
      'meta',
      'meta',
      'meta',
    ]);
  });

  it('describes what an undo does', () => {
    expect(restoreSentence(2, 1)).toBe(
      'Os 2 arquivos alterados ou removidos voltam ao conteúdo que tinham antes desta execução; o arquivo criado por ela é removido.',
    );
    expect(restoreSentence(0, 3)).toBe('Os 3 arquivos criados por ela são removidos.');
    expect(restoreSentence(1, 0)).toBe(
      'O arquivo alterado ou removido volta ao conteúdo que tinha antes desta execução.',
    );
  });
});
