import { defineMessages } from '../../../shared/i18n.js';

// Git panel refusals (server/git-panel.ts, server/http/git.ts). Git's own output (stderr) is
// passed through as is. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'git.notRepo': 'O projeto não é um repositório git',
    'git.fileNotListed': 'Arquivo não está na lista de alterações',
    'git.fileOutsideList': 'Arquivo fora da lista de alterações: {path}',
    'git.conflicted': 'Arquivos em conflito não podem ser descartados: {paths}',
    'git.mixed': 'Estes arquivos também têm alterações no índice; confirme para descartar só as não staged: {paths}',
    'git.invalidPath': 'Caminho inválido: {path}',
    'git.onlyFiles': 'Só arquivos podem ser descartados por aqui: {path}',
    'git.identity': 'Configure user.name e user.email no git',
    'git.nothingStaged': 'Não há alterações staged',
    'git.noUpstream': 'A branch atual não tem upstream; envie pelo terminal na primeira vez',
    'git.unsafeConfig':
      'A configuração do repositório define {keys}; por segurança o Adelic não envia com ela. Use git push no terminal.',
    'git.pushFailed': 'O envio falhou: {detail}',
    'git.detached': 'HEAD está destacado; mude para uma branch',
    'git.noOrigin': 'O repositório não tem o remote origin',
    'git.defaultBranch': 'Você está na branch padrão ({base}); crie outra branch para o pull request',
    'git.unknownHost': 'O remote origin não é do GitHub nem do GitLab',
    'git.messageRequired': 'Mensagem obrigatória',
  },
  {
    'git.notRepo': 'The project is not a git repository',
    'git.fileNotListed': 'The file is not in the list of changes',
    'git.fileOutsideList': 'File outside the list of changes: {path}',
    'git.conflicted': 'Conflicted files cannot be discarded: {paths}',
    'git.mixed': 'These files also have changes in the index; confirm to discard only the unstaged ones: {paths}',
    'git.invalidPath': 'Invalid path: {path}',
    'git.onlyFiles': 'Only files can be discarded here: {path}',
    'git.identity': 'Set user.name and user.email in git',
    'git.nothingStaged': 'There are no staged changes',
    'git.noUpstream': 'The current branch has no upstream; push from the terminal the first time',
    'git.unsafeConfig':
      'The repository configuration sets {keys}; for safety Adelic does not push with it. Use git push in the terminal.',
    'git.pushFailed': 'The push failed: {detail}',
    'git.detached': 'HEAD is detached; switch to a branch',
    'git.noOrigin': 'The repository has no origin remote',
    'git.defaultBranch': 'You are on the default branch ({base}); create another branch for the pull request',
    'git.unknownHost': 'The origin remote is neither GitHub nor GitLab',
    'git.messageRequired': 'A message is required',
  },
);
