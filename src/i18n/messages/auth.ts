import { defineMessages } from '../../../shared/i18n';

// Remote login screen (src/RemoteGate.tsx).
export default defineMessages(
  {
    'auth.invalidToken': 'Token inválido.',
    'auth.badCredentials': 'Usuário ou senha incorretos.',
    'auth.tooManyAttempts': 'Muitas tentativas. Aguarde um minuto e tente de novo.',
    'auth.failed': 'Falha no login ({status}).',
    'auth.unavailable.title': 'Acesso remoto indisponível',
    'auth.unavailable.body':
      'Nenhuma conta foi criada. No computador onde o Adelic roda, abra Configurações › Acesso remoto e defina um usuário e uma senha.',
    'auth.title': 'Entrar no Adelic',
    'auth.hint.token': 'Informe o token configurado em ADELIC_REMOTE_TOKEN.',
    'auth.hint.internet': 'Acesso pela internet. Entre com o usuário e a senha definidos neste Adelic.',
    'auth.hint.remote': 'Acesso remoto. Entre com o usuário e a senha definidos neste Adelic.',
    'auth.username': 'Usuário',
    'auth.password': 'Senha',
    'auth.token': 'Token de acesso',
    'auth.submit': 'Entrar',
    'auth.usePassword': 'Entrar com usuário e senha',
    'auth.useToken': 'Entrar com o token (ADELIC_REMOTE_TOKEN)',
  },
  {
    'auth.invalidToken': 'Invalid token.',
    'auth.badCredentials': 'Incorrect username or password.',
    'auth.tooManyAttempts': 'Too many attempts. Wait a minute and try again.',
    'auth.failed': 'Sign-in failed ({status}).',
    'auth.unavailable.title': 'Remote access unavailable',
    'auth.unavailable.body':
      'No account has been created. On the computer running Adelic, open Settings › Remote access and set a username and password.',
    'auth.title': 'Sign in to Adelic',
    'auth.hint.token': 'Enter the token configured in ADELIC_REMOTE_TOKEN.',
    'auth.hint.internet': 'Internet access. Sign in with the username and password set on this Adelic.',
    'auth.hint.remote': 'Remote access. Sign in with the username and password set on this Adelic.',
    'auth.username': 'Username',
    'auth.password': 'Password',
    'auth.token': 'Access token',
    'auth.submit': 'Sign in',
    'auth.usePassword': 'Sign in with username and password',
    'auth.useToken': 'Sign in with the token (ADELIC_REMOTE_TOKEN)',
  },
);
