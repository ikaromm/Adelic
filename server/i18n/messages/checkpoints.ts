import { defineMessages } from '../../../shared/i18n.js';

// Diff and undo of a run's changes (server/checkpoints.ts, server/http/runs.ts). The reasons a
// snapshot was not taken (`checkpoint.reason`) are persisted with the run and stay pt-BR.
export default defineMessages(
  {
    'checkpoints.noChanges': 'Esta execução não tem alterações registradas',
    'checkpoints.repoGone': 'O repositório do checkpoint não existe mais',
    'checkpoints.refsGone': 'O checkpoint desta execução foi removido do repositório',
    'checkpoints.fileNotChanged': 'Arquivo não foi alterado por esta execução',
    'checkpoints.invalidPath': 'Caminho inválido no checkpoint: {path}',
    'checkpoints.outsidePath': 'Caminho fora do projeto: {path}',
    'checkpoints.conflicts.one': 'Um arquivo foi alterado depois desta execução; nada foi desfeito.',
    'checkpoints.conflicts.other': '{count} arquivos foram alterados depois desta execução; nada foi desfeito.',
  },
  {
    'checkpoints.noChanges': 'This run has no recorded changes',
    'checkpoints.repoGone': 'The checkpoint repository no longer exists',
    'checkpoints.refsGone': 'This run’s checkpoint was removed from the repository',
    'checkpoints.fileNotChanged': 'This run did not change the file',
    'checkpoints.invalidPath': 'Invalid path in the checkpoint: {path}',
    'checkpoints.outsidePath': 'Path outside the project: {path}',
    'checkpoints.conflicts.one': 'One file was changed after this run; nothing was undone.',
    'checkpoints.conflicts.other': '{count} files were changed after this run; nothing was undone.',
  },
);
