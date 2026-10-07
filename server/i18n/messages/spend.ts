import { defineMessages } from '../../../shared/i18n.js';

// Usage limits refusal (server/usage.ts spendLimitError, shared/spend-limits.ts): one sentence per
// limit kind, so the label is translated with it. The numbers keep the format of the limit status
// (`usedText` / `limitText`). Keep pt-BR byte-identical to limitReachedMessage().
export default defineMessages(
  {
    'spend.reached.dailyTokens':
      "Limite de uso atingido: tokens hoje ({used}/{limit}). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
    'spend.reached.monthlyTokens':
      "Limite de uso atingido: tokens no mês ({used}/{limit}). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
    'spend.reached.dailyCost':
      "Limite de uso atingido: custo hoje ({used}/{limit}). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
    'spend.reached.monthlyCost':
      "Limite de uso atingido: custo no mês ({used}/{limit}). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
    'spend.reached.projectMonthlyTokens':
      "Limite de uso atingido: tokens do projeto no mês ({used}/{limit}). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
    'spend.reached.projectMonthlyCost':
      "Limite de uso atingido: custo do projeto no mês ({used}/{limit}). Ajuste em Configurações ou use 'Continuar mesmo assim'.",
  },
  {
    'spend.reached.dailyTokens':
      "Usage limit reached: tokens today ({used}/{limit}). Adjust it in Settings or use 'Continue anyway'.",
    'spend.reached.monthlyTokens':
      "Usage limit reached: tokens this month ({used}/{limit}). Adjust it in Settings or use 'Continue anyway'.",
    'spend.reached.dailyCost':
      "Usage limit reached: cost today ({used}/{limit}). Adjust it in Settings or use 'Continue anyway'.",
    'spend.reached.monthlyCost':
      "Usage limit reached: cost this month ({used}/{limit}). Adjust it in Settings or use 'Continue anyway'.",
    'spend.reached.projectMonthlyTokens':
      "Usage limit reached: project tokens this month ({used}/{limit}). Adjust it in Settings or use 'Continue anyway'.",
    'spend.reached.projectMonthlyCost':
      "Usage limit reached: project cost this month ({used}/{limit}). Adjust it in Settings or use 'Continue anyway'.",
  },
);
