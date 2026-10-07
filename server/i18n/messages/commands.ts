import { defineMessages } from '../../../shared/i18n.js';

// Saved slash commands (server/http/commands.ts). Field validation lives in the `validation`
// area. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'commands.invalid': 'Comando inválido',
    'commands.duplicate': 'Já existe um comando com esse nome neste escopo',
    'commands.notFound': 'Comando não encontrado',
  },
  {
    'commands.invalid': 'Invalid command',
    'commands.duplicate': 'A command with this name already exists in this scope',
    'commands.notFound': 'Command not found',
  },
);
