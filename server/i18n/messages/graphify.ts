import { defineMessages } from '../../../shared/i18n.js';

// Graphify routes (server/graphify.ts). The tool's own errors are passed through. Keep pt-BR
// byte-identical.
export default defineMessages(
  {
    'graphify.queryRequired': 'Consulta obrigatória com até {max} caracteres',
  },
  {
    'graphify.queryRequired': 'A query is required, up to {max} characters',
  },
);
