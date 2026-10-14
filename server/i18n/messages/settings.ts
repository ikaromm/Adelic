import { defineMessages } from '../../../shared/i18n.js';

// Settings, usage and skills (server/http/settings.ts). Keep pt-BR byte-identical.
export default defineMessages(
  {
    'settings.invalid': 'Configuração inválida',
    'settings.automationsInternet': 'Automações não podem ser alteradas pelo acesso pela internet.',
    'settings.skillNotFound': 'Skill não encontrada',
    'settings.skillBodyInvalid':
      'O corpo completo da skill não pode ser carregado; verifique os limites e o arquivo SKILL.md.',
  },
  {
    'settings.invalid': 'Invalid settings',
    'settings.automationsInternet': 'Automations cannot be changed through internet access.',
    'settings.skillNotFound': 'Skill not found',
    'settings.skillBodyInvalid': 'The complete skill body cannot be loaded; check the limits and SKILL.md file.',
  },
);
