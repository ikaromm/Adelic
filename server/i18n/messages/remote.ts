import { defineMessages } from '../../../shared/i18n.js';

// Settings › Acesso remoto: account, sessions and the Funnel switch (server/http/remote-access.ts).
export default defineMessages(
  {
    'remote.invalidAccount': 'Usuário ou senha inválidos',
    'remote.sessionNotFound': 'Sessão não encontrada',
    'remote.enabledBoolean': 'enabled deve ser booleano',
    'remote.noFunnelPort': 'Este Adelic não tem a porta do Funnel configurada.',
    'remote.accountFirst': 'Crie o usuário e a senha antes de publicar na internet.',
  },
  {
    'remote.invalidAccount': 'Invalid username or password',
    'remote.sessionNotFound': 'Session not found',
    'remote.enabledBoolean': 'enabled must be a boolean',
    'remote.noFunnelPort': 'This Adelic has no Funnel port configured.',
    'remote.accountFirst': 'Create the username and password before publishing to the internet.',
  },
);
