import { defineMessages } from '../../../shared/i18n.js';

// "Continuar com outro agente" (server/provider-handoff.ts). The summary text and the markers
// stored in the conversation are history and stay pt-BR. Keep pt-BR byte-identical.
export default defineMessages(
  {
    'handoff.providerNotFound': 'Provedor não encontrado',
    'handoff.sameAgent': 'Escolha um agente diferente do atual',
    'handoff.unavailable': '{name} está indisponível neste computador',
    'handoff.cancelled': 'Passagem cancelada',
  },
  {
    'handoff.providerNotFound': 'Provider not found',
    'handoff.sameAgent': 'Choose an agent different from the current one',
    'handoff.unavailable': '{name} is unavailable on this computer',
    'handoff.cancelled': 'Handoff cancelled',
  },
);
