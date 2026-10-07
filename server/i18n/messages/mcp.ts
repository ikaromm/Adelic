import { defineMessages } from '../../../shared/i18n.js';

// MCP catalog (server/http/mcp.ts, server/mcp.ts). Form validation shared with the UI lives in
// the `validation` area (validation.mcp.*). Keep pt-BR byte-identical.
export default defineMessages(
  {
    'mcp.invalid': 'Servidor MCP inválido',
    'mcp.commandNotExecutable': 'Comando não encontrado ou sem permissão de execução: {command}',
    'mcp.commandNotInPath': 'Comando não encontrado no PATH do Adelic: {command}',
  },
  {
    'mcp.invalid': 'Invalid MCP server',
    'mcp.commandNotExecutable': 'Command not found or not executable: {command}',
    'mcp.commandNotInPath': 'Command not found in Adelic’s PATH: {command}',
  },
);
