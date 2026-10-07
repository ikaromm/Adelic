import { defineMessages } from '../../../shared/i18n.js';

// Integrated terminal (server/http/terminal.ts, server/terminal.ts). The command output itself is
// never translated. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'terminal.remoteDisabled':
      'O terminal está desativado no acesso remoto. Ative "Permitir terminal pelo acesso remoto" em Configurações, neste computador.',
    'terminal.internetDisabled':
      'O terminal nunca fica disponível pelo acesso pela internet (Tailscale Funnel). Use este computador ou a tailnet.',
    'terminal.commandNotFound': 'Comando não encontrado',
    'terminal.invalidCommand': 'Comando inválido',
    'terminal.emptyBody': 'Envie um corpo JSON vazio ({})',
    'terminal.busy': 'Já há {count} comandos em execução neste projeto. Pare um deles antes.',
  },
  {
    'terminal.remoteDisabled':
      'The terminal is turned off for remote access. Turn on "Allow the terminal over remote access" in Settings, on this computer.',
    'terminal.internetDisabled':
      'The terminal is never available over internet access (Tailscale Funnel). Use this computer or the tailnet.',
    'terminal.commandNotFound': 'Command not found',
    'terminal.invalidCommand': 'Invalid command',
    'terminal.emptyBody': 'Send an empty JSON body ({})',
    'terminal.busy': 'Commands running in this project: {count} (the limit). Stop one of them first.',
  },
);
