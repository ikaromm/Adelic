import { defineMessages } from '../../../shared/i18n';

// Labels for the compact access menu in the chat composer.
export default defineMessages(
  {
    'composer.access.label': 'Acesso',
    'composer.access.workspace': 'Acesso à pasta do projeto',
    'composer.access.workspaceScope': 'Configuração global deste computador, aplicada às próximas execuções.',
    'composer.access.readDetail': 'O agente pode ler arquivos; alterações ficam bloqueadas.',
    'composer.access.writeDetail': 'Pode alterar arquivos do projeto, dentro do sandbox configurado.',
    'composer.access.remoteWriteDetail':
      'Pode alterar arquivos e executar comandos com as permissões do usuário SSH remoto.',
    'composer.access.approval': 'Aprovação efetiva',
    'composer.access.current': 'Atual: {approval} · {scope}',
    'composer.access.inherit': 'Usar configuração herdada',
    'composer.access.inheritDetail': 'Volta a seguir o modo definido no projeto ou nas configurações globais.',
    'composer.access.scope.session': 'Substituição salva nesta conversa.',
    'composer.access.scope.project': 'Modo efetivo herdado do projeto.',
    'composer.access.scope.settings': 'Modo efetivo herdado das configurações globais.',
    'composer.access.scope.forced': 'Acesso pela internet exige aprovação manual.',
    'composer.access.remoteAutoSafe': 'No SSH, este modo pede confirmação e o modo efetivo é Manual.',
  },
  {
    'composer.access.label': 'Access',
    'composer.access.workspace': 'Project folder access',
    'composer.access.workspaceScope': 'Global setting on this computer, applied to upcoming runs.',
    'composer.access.readDetail': 'The agent can read files; changes are blocked.',
    'composer.access.writeDetail': 'Can change project files inside the configured sandbox.',
    'composer.access.remoteWriteDetail': 'Can change files and run commands with the remote SSH user permissions.',
    'composer.access.approval': 'Effective approval',
    'composer.access.current': 'Current: {approval} · {scope}',
    'composer.access.inherit': 'Use inherited setting',
    'composer.access.inheritDetail': 'Follow the mode set by the project or global settings again.',
    'composer.access.scope.session': 'Override saved for this conversation.',
    'composer.access.scope.project': 'Effective mode inherited from the project.',
    'composer.access.scope.settings': 'Effective mode inherited from global settings.',
    'composer.access.scope.forced': 'Internet access requires manual approval.',
    'composer.access.remoteAutoSafe': 'Over SSH, this mode asks for confirmation and the effective mode is Manual.',
  },
);
