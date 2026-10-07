import { defineMessages } from '../../../shared/i18n.js';

// Scheduled automations (server/automations.ts, server/http/automations.ts). The result stored on
// the automation (`lastResult.detail`) is history and stays in the language it was recorded in;
// only the API answer is translated. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'automations.invalid': 'Automação inválida',
    'automations.notFound': 'Automação não encontrada',
    'automations.globalOff': 'Automações desativadas em Configurações',
    'automations.skippedActive': 'ignorada: execução em andamento',
  },
  {
    'automations.invalid': 'Invalid automation',
    'automations.notFound': 'Automation not found',
    'automations.globalOff': 'Automations are turned off in Settings',
    'automations.skippedActive': 'skipped: a run is in progress',
  },
);
