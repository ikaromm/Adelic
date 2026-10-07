import { defineMessages } from '../../../shared/i18n.js';

// "Atualizar Adelic" (server/self-update.ts, server/http/update.ts): refusals and the `blocked` /
// `error` texts of the status. Output of git and npm, and the update log, are not translated.
// Keep pt-BR byte-identical.
export default defineMessages(
  {
    'update.localOnly': 'Atualizações só podem ser verificadas e aplicadas neste computador, não pelo acesso remoto',
    'update.running': 'Uma atualização já está em andamento',
    'update.checkFirst': 'Verifique as atualizações antes de atualizar',
    'update.versionChanged': 'A versão disponível mudou; verifique de novo',
    'update.noPermission': 'Sem permissão para substituir {path}',
    'update.noPermissionRelease': 'Sem permissão para substituir {path}; baixe a nova versão pela página da release',
    'update.notSelfUpdating': 'Esta instalação não se atualiza pelo Adelic; use a página da release',
    'update.manualOnly': 'Esta instalação não se atualiza sozinha; baixe a nova versão pela página da release',
    'update.upToDate': 'O Adelic já está atualizado',
    'update.remoteMoved': 'origin/{channel} mudou desde a verificação; verifique de novo',
    'update.readGitFailed': 'Não foi possível ler o git: {detail}',
    'update.fetchFailed': 'Não foi possível buscar origin/{channel}: {detail}',
    'update.checkFailed': 'Não foi possível verificar atualizações: {detail}',
    'update.filters':
      'A configuração deste repositório define filtros que executam programas ({filters}); atualize manualmente',
    'update.noTrackingBranch.branch':
      'O checkout está no branch {branch}; não há um branch local {channel} que acompanhe origin/{channel}',
    'update.noTrackingBranch.detached':
      'O checkout está sem branch (HEAD destacado); não há um branch local {channel} que acompanhe origin/{channel}',
    'update.switchDirty.branch':
      'O checkout está no branch {branch} e tem alterações; para trocar para {channel}, salve ou descarte as alterações',
    'update.switchDirty.detached':
      'O checkout está sem branch e tem alterações; para trocar para {channel}, salve ou descarte as alterações',
    'update.localAhead':
      'O branch local {channel} tem commits que não estão em origin/{channel}; atualize-o manualmente',
    'update.dirty':
      'Há alterações em arquivos rastreados; salve (commit) ou descarte antes de atualizar. Arquivos não rastreados não impedem.',
    'update.diverged': 'O branch divergiu de origin/{channel} ({ahead} commit(s) locais); atualize manualmente',
    'update.ahead': 'Há {ahead} commit(s) locais que não estão em origin/{channel}; envie ou atualize manualmente',
  },
  {
    'update.localOnly': 'Updates can only be checked and applied on this computer, not through remote access',
    'update.running': 'An update is already in progress',
    'update.checkFirst': 'Check for updates before updating',
    'update.versionChanged': 'The available version changed; check again',
    'update.noPermission': 'No permission to replace {path}',
    'update.noPermissionRelease': 'No permission to replace {path}; download the new version from the release page',
    'update.notSelfUpdating': 'This installation is not updated by Adelic; use the release page',
    'update.manualOnly': 'This installation does not update itself; download the new version from the release page',
    'update.upToDate': 'Adelic is already up to date',
    'update.remoteMoved': 'origin/{channel} changed since the check; check again',
    'update.readGitFailed': 'Could not read git: {detail}',
    'update.fetchFailed': 'Could not fetch origin/{channel}: {detail}',
    'update.checkFailed': 'Could not check for updates: {detail}',
    'update.filters': 'This repository’s configuration defines filters that run programs ({filters}); update manually',
    'update.noTrackingBranch.branch':
      'The checkout is on branch {branch}; there is no local {channel} branch tracking origin/{channel}',
    'update.noTrackingBranch.detached':
      'The checkout has no branch (detached HEAD); there is no local {channel} branch tracking origin/{channel}',
    'update.switchDirty.branch':
      'The checkout is on branch {branch} and has changes; to switch to {channel}, commit or discard the changes',
    'update.switchDirty.detached':
      'The checkout has no branch and has changes; to switch to {channel}, commit or discard the changes',
    'update.localAhead': 'The local {channel} branch has commits that are not in origin/{channel}; update it manually',
    'update.dirty': 'Tracked files have changes; commit or discard them before updating. Untracked files do not block.',
    'update.diverged': 'The branch diverged from origin/{channel} ({ahead} local commit(s)); update manually',
    'update.ahead': 'There are {ahead} local commit(s) not in origin/{channel}; push or update manually',
  },
);
