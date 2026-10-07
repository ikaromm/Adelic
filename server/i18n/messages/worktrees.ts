import { defineMessages } from '../../../shared/i18n.js';

// Isolated worktree per conversation (server/worktrees.ts, server/http/worktrees.ts): refusals and
// the `reason` / `applyBlocked` texts of the panel. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'worktrees.notRepo': 'a pasta do projeto não é um repositório git',
    'worktrees.notRoot': 'a pasta do projeto não é a raiz do repositório git',
    'worktrees.noCommits': 'o repositório ainda não tem commits',
    'worktrees.cannotCreate': 'Não é possível criar uma cópia isolada: {reason}',
    'worktrees.dataInsideRepo':
      'A pasta de dados do Adelic fica dentro do repositório; a cópia isolada poluiria o projeto',
    'worktrees.invalidSessionId': 'Identificador de conversa inválido',
    'worktrees.folderExists': 'Já existe uma pasta de cópia isolada para esta conversa',
    'worktrees.repoGone': 'O repositório do projeto não existe mais',
    'worktrees.folderGone': 'A pasta da cópia isolada não existe mais',
    'worktrees.folderGoneDiscard': 'A pasta da cópia isolada não existe mais; descarte-a',
    'worktrees.fileNotChanged': 'Arquivo não foi alterado nesta cópia',
    'worktrees.detached': 'O projeto não está em um branch (HEAD destacado); faça checkout de um branch antes',
    'worktrees.gitOperation': 'Há uma operação do git em andamento no projeto (merge, rebase ou cherry-pick)',
    'worktrees.dirty': 'O projeto tem alterações não commitadas ({files}); faça commit ou guarde-as antes de aplicar',
    'worktrees.nothingToApply': 'Não há alterações para aplicar',
    'worktrees.alreadyApplied': 'As alterações já estão no projeto',
    'worktrees.ignoredFiles':
      'O branch cria arquivos que já existem no projeto (ignorados pelo git); mova-os antes de aplicar',
    'worktrees.conflicts.one': 'Conflito ao aplicar um arquivo; o merge foi desfeito e o projeto ficou como estava.',
    'worktrees.conflicts.other':
      'Conflito ao aplicar {count} arquivos; o merge foi desfeito e o projeto ficou como estava.',
    'worktrees.mergeRefused': 'O git recusou o merge; o projeto não foi alterado ({detail})',
    'worktrees.createNoOptions': 'Criar a cópia isolada não aceita opções',
  },
  {
    'worktrees.notRepo': 'the project folder is not a git repository',
    'worktrees.notRoot': 'the project folder is not the root of the git repository',
    'worktrees.noCommits': 'the repository has no commits yet',
    'worktrees.cannotCreate': 'Cannot create an isolated copy: {reason}',
    'worktrees.dataInsideRepo':
      'Adelic’s data folder is inside the repository; the isolated copy would pollute the project',
    'worktrees.invalidSessionId': 'Invalid conversation id',
    'worktrees.folderExists': 'An isolated copy folder already exists for this conversation',
    'worktrees.repoGone': 'The project repository no longer exists',
    'worktrees.folderGone': 'The isolated copy folder no longer exists',
    'worktrees.folderGoneDiscard': 'The isolated copy folder no longer exists; discard it',
    'worktrees.fileNotChanged': 'The file was not changed in this copy',
    'worktrees.detached': 'The project is not on a branch (detached HEAD); check out a branch first',
    'worktrees.gitOperation': 'A git operation is in progress in the project (merge, rebase or cherry-pick)',
    'worktrees.dirty': 'The project has uncommitted changes ({files}); commit or stash them before applying',
    'worktrees.nothingToApply': 'There are no changes to apply',
    'worktrees.alreadyApplied': 'The changes are already in the project',
    'worktrees.ignoredFiles':
      'The branch creates files that already exist in the project (ignored by git); move them before applying',
    'worktrees.conflicts.one': 'Conflict applying one file; the merge was undone and the project is as it was.',
    'worktrees.conflicts.other': 'Conflict applying {count} files; the merge was undone and the project is as it was.',
    'worktrees.mergeRefused': 'git refused the merge; the project was not changed ({detail})',
    'worktrees.createNoOptions': 'Creating the isolated copy takes no options',
  },
);
