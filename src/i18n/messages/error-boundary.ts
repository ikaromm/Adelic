import { defineMessages } from '../../../shared/i18n';

// Render error fallback (src/ErrorBoundary.tsx). `scope.*` names what failed; callers pass the pt-BR name.
export default defineMessages(
  {
    'errorBoundary.title': 'Não foi possível exibir {scope}',
    'errorBoundary.body':
      'Seus dados continuam salvos. Tente de novo; se o erro persistir, recarregue a janela e informe a mensagem abaixo.',
    'errorBoundary.retry': 'Tentar de novo',
    'errorBoundary.reload': 'Recarregar',
    'errorBoundary.scope.app': 'o Adelic',
    'errorBoundary.scope.conversation': 'a conversa',
    'errorBoundary.scope.terminal': 'o terminal',
    'errorBoundary.scope.git': 'o git',
    'errorBoundary.scope.activity': 'a atividade',
    'errorBoundary.scope.automations': 'as automações',
    'errorBoundary.scope.memory': 'a memória',
    'errorBoundary.scope.settings': 'as configurações',
  },
  {
    'errorBoundary.title': 'Could not display {scope}',
    'errorBoundary.body':
      'Your data is still saved. Try again; if the error persists, reload the window and report the message below.',
    'errorBoundary.retry': 'Try again',
    'errorBoundary.reload': 'Reload',
    'errorBoundary.scope.app': 'Adelic',
    'errorBoundary.scope.conversation': 'the conversation',
    'errorBoundary.scope.terminal': 'the terminal',
    'errorBoundary.scope.git': 'Git',
    'errorBoundary.scope.activity': 'the activity',
    'errorBoundary.scope.automations': 'the automations',
    'errorBoundary.scope.memory': 'the memory',
    'errorBoundary.scope.settings': 'the settings',
  },
);
