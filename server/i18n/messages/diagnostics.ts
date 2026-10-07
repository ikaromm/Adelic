import { defineMessages } from '../../../shared/i18n.js';

// Settings › Diagnóstico (server/http/diagnostics.ts). Versions, paths and the service's own
// errors are reported as they are. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'diagnostics.noVersion': 'não respondeu a --version',
    'diagnostics.invalidUrl': 'inválida: {detail}',
    'diagnostics.noStatusRoute': 'sem /admin/status',
  },
  {
    'diagnostics.noVersion': 'did not answer --version',
    'diagnostics.invalidUrl': 'invalid: {detail}',
    'diagnostics.noStatusRoute': 'no /admin/status',
  },
);
