import { defineMessages } from '../../../shared/i18n';

// Files changed by a run, their diffs and undo (src/components/RunChanges.tsx).
export default defineMessages(
  {
    'changes.status.added': 'criado',
    'changes.status.modified': 'alterado',
    'changes.status.deleted': 'removido',
    'changes.undone': 'desfeito',
    'changes.binary': 'binário',
    'changes.loadingDiff': 'Carregando diferenças…',
    'changes.diffOf': 'Diferenças em {path}',
    'changes.diffTruncated': 'Diferenças cortadas em 200 KB.',
    'changes.omitted.one': 'Mais {count} arquivo não listados.',
    'changes.omitted.other': 'Mais {count} arquivos não listados.',
    'changes.restored': 'Alterações desfeitas. Os arquivos voltaram ao estado de antes desta execução.',
    'changes.tooMany': 'Execuções com muitos arquivos não podem ser desfeitas por aqui',
    'changes.waitRun': 'Aguarde a execução atual terminar',
    'changes.undo': 'Desfazer alterações desta execução',
    'changes.restore.changed.one': 'O arquivo alterado ou removido volta ao conteúdo que tinha antes desta execução.',
    'changes.restore.changed.other':
      'Os {count} arquivos alterados ou removidos voltam ao conteúdo que tinham antes desta execução.',
    'changes.restore.added.one': 'O arquivo criado por ela é removido.',
    'changes.restore.added.other': 'Os {count} arquivos criados por ela são removidos.',
    'changes.restore.bothOneOne':
      'O arquivo alterado ou removido volta ao conteúdo que tinha antes desta execução; o arquivo criado por ela é removido.',
    'changes.restore.bothOneMany':
      'O arquivo alterado ou removido volta ao conteúdo que tinha antes desta execução; os {added} arquivos criados por ela são removidos.',
    'changes.restore.bothManyOne':
      'Os {changed} arquivos alterados ou removidos voltam ao conteúdo que tinham antes desta execução; o arquivo criado por ela é removido.',
    'changes.restore.bothManyMany':
      'Os {changed} arquivos alterados ou removidos voltam ao conteúdo que tinham antes desta execução; os {added} arquivos criados por ela são removidos.',
    'changes.confirmTitle': 'Desfazer alterações desta execução?',
    'changes.close': 'Fechar',
    'changes.confirmDetail':
      'Se algum deles foi editado depois da execução, nada é desfeito e a lista desses arquivos aparece aqui. Outros arquivos, commits, branches, índice e stash do git não são alterados.',
    'changes.cancel': 'Cancelar',
    'changes.confirm': 'Desfazer alterações',
  },
  {
    'changes.status.added': 'added',
    'changes.status.modified': 'modified',
    'changes.status.deleted': 'deleted',
    'changes.undone': 'undone',
    'changes.binary': 'binary',
    'changes.loadingDiff': 'Loading diff…',
    'changes.diffOf': 'Diff of {path}',
    'changes.diffTruncated': 'Diff cut at 200 KB.',
    'changes.omitted.one': '{count} more file not listed.',
    'changes.omitted.other': '{count} more files not listed.',
    'changes.restored': 'Changes undone. The files are back to how they were before this run.',
    'changes.tooMany': 'Runs with many files can’t be undone from here',
    'changes.waitRun': 'Wait for the current run to finish',
    'changes.undo': 'Undo this run’s changes',
    'changes.restore.changed.one': 'The changed or deleted file goes back to its content from before this run.',
    'changes.restore.changed.other':
      'The {count} changed or deleted files go back to their content from before this run.',
    'changes.restore.added.one': 'The file it created is removed.',
    'changes.restore.added.other': 'The {count} files it created are removed.',
    'changes.restore.bothOneOne':
      'The changed or deleted file goes back to its content from before this run; the file it created is removed.',
    'changes.restore.bothOneMany':
      'The changed or deleted file goes back to its content from before this run; the {added} files it created are removed.',
    'changes.restore.bothManyOne':
      'The {changed} changed or deleted files go back to their content from before this run; the file it created is removed.',
    'changes.restore.bothManyMany':
      'The {changed} changed or deleted files go back to their content from before this run; the {added} files it created are removed.',
    'changes.confirmTitle': 'Undo this run’s changes?',
    'changes.close': 'Close',
    'changes.confirmDetail':
      'If any of them was edited after the run, nothing is undone and those files are listed here. Other files, commits, branches, the git index and stash are left untouched.',
    'changes.cancel': 'Cancel',
    'changes.confirm': 'Undo changes',
  },
);
