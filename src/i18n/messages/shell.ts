import { defineMessages } from '../../../shared/i18n';

// App shell: header breadcrumb and connection badge (src/App.tsx header).
export default defineMessages(
  {
    'shell.crumb.detached': 'Conversa avulsa',
    'shell.crumb.conversations': 'Conversas',
    'shell.connection.local': 'Local',
    'shell.connection.tailnet': 'Tailnet',
    'shell.connection.internet': 'Internet',
    'shell.connection.local.title': 'Executa neste computador; o servidor escuta somente em 127.0.0.1',
    'shell.connection.tailnet.title':
      'Conectado pela tailnet (Tailscale). Os agentes executam no computador onde o Adelic roda.',
    'shell.connection.internet.title':
      'Conectado pela internet (Tailscale Funnel). Os agentes executam no computador onde o Adelic roda; algumas opções ficam bloqueadas e comandos pedem aprovação.',
  },
  {
    'shell.crumb.detached': 'Standalone conversation',
    'shell.crumb.conversations': 'Conversations',
    'shell.connection.local': 'Local',
    'shell.connection.tailnet': 'Tailnet',
    'shell.connection.internet': 'Internet',
    'shell.connection.local.title': 'Runs on this computer; the server only listens on 127.0.0.1',
    'shell.connection.tailnet.title':
      'Connected through the tailnet (Tailscale). Agents run on the computer where Adelic runs.',
    'shell.connection.internet.title':
      'Connected over the internet (Tailscale Funnel). Agents run on the computer where Adelic runs; some options are blocked and commands ask for approval.',
  },
);
