import { defineMessages } from '../../../shared/i18n.js';

// Remote access login and the request guard (server/http/auth.ts). Keep pt-BR byte-identical
// to the text it replaced.
export default defineMessages(
  {
    'auth.required': 'Autenticação necessária',
    'auth.loginFailed': 'Usuário ou senha incorretos',
    'auth.tooManyAttempts': 'Muitas tentativas; aguarde um minuto',
    'auth.loginNotNeeded': 'Login só é necessário no acesso remoto',
    'auth.localOnly': 'Esta opção só pode ser alterada neste computador, não pelo acesso remoto',
    'auth.internetBlocked': 'Indisponível no acesso pela internet; use este computador ou a tailnet.',
    'auth.externalOrigin': 'Origem externa bloqueada',
    'auth.jsonRequired': 'Mutação exige application/json',
  },
  {
    'auth.required': 'Authentication required',
    'auth.loginFailed': 'Incorrect username or password',
    'auth.tooManyAttempts': 'Too many attempts; wait a minute',
    'auth.loginNotNeeded': 'Login is only needed for remote access',
    'auth.localOnly': 'This option can only be changed on this computer, not through remote access',
    'auth.internetBlocked': 'Unavailable when accessed over the internet; use this computer or the tailnet.',
    'auth.externalOrigin': 'External origin blocked',
    'auth.jsonRequired': 'Mutations require application/json',
  },
);
