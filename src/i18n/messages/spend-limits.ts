import { defineMessages } from '../../../shared/i18n';

// Usage limits (src/components/SpendLimits.tsx): the Settings card, the project card, the
// conversation banner at 80% and the "Continuar mesmo assim" notice.
export default defineMessages(
  {
    'spendLimits.tokens': '{tokens} tokens',
    'spendLimits.noCost': 'custo não informado',
    'spendLimits.runs.zero': '{count} execuções',
    'spendLimits.runs.one': '{count} execução',
    'spendLimits.runs.other': '{count} execuções',
    'spendLimits.unknownCost.one': 'custo não informado em {count} execução',
    'spendLimits.unknownCost.other': 'custo não informado em {count} execuções',
    'spendLimits.today': 'Hoje',
    'spendLimits.month': 'Este mês',
    'spendLimits.noLimit': 'Sem limite',
    'spendLimits.tokensError': 'Use um número inteiro de tokens, ou deixe vazio.',
    'spendLimits.costError': 'Use dólares com até 2 casas, como 5,00.',
    'spendLimits.title': 'Limites de uso',
    'spendLimits.detail':
      'Antes de cada chamada ao agente, confere o uso de hoje e do mês (horário local). Uma resposta em andamento nunca é interrompida.',
    'spendLimits.enable': 'Limitar uso',
    'spendLimits.enableDetail':
      'Avisa em 80% e pede confirmação quando um limite é atingido. Desligado, nada é bloqueado.',
    'spendLimits.dailyTokens': 'Tokens por dia',
    'spendLimits.dailyTokensHint': 'Entrada + saída desde 00:00.',
    'spendLimits.monthlyTokens': 'Tokens por mês',
    'spendLimits.monthlyTokensHint': 'Entrada + saída no mês corrente.',
    'spendLimits.dailyCost': 'Custo por dia (US$)',
    'spendLimits.monthlyCost': 'Custo por mês (US$)',
    'spendLimits.costHint': 'Só conta execuções que informaram custo.',
    'spendLimits.allUsage': 'Uso de todas as conversas',
    'spendLimits.unavailable': 'Uso indisponível: {error}',
    'spendLimits.project.title': 'Uso do projeto',
    'spendLimits.project.detail': '{project} · conversas vinculadas a este projeto.',
    'spendLimits.project.offNote': 'Os limites valem quando "Limitar uso" está ligado.',
    'spendLimits.project.monthlyTokens': 'Tokens do projeto por mês',
    'spendLimits.project.monthlyCost': 'Custo do projeto por mês (US$)',
    'spendLimits.project.usage': 'Uso do projeto',
    // Banner lines, one per limit kind (shared/spend-limits.ts limitWarningMessage).
    'spendLimits.warning.dailyTokens': 'Uso em {percent}% do limite de tokens hoje ({used}/{limit}).',
    'spendLimits.warning.monthlyTokens': 'Uso em {percent}% do limite de tokens no mês ({used}/{limit}).',
    'spendLimits.warning.dailyCost': 'Uso em {percent}% do limite de custo hoje ({used}/{limit}).',
    'spendLimits.warning.monthlyCost': 'Uso em {percent}% do limite de custo no mês ({used}/{limit}).',
    'spendLimits.warning.projectMonthlyTokens':
      'Uso em {percent}% do limite de tokens do projeto no mês ({used}/{limit}).',
    'spendLimits.warning.projectMonthlyCost':
      'Uso em {percent}% do limite de custo do projeto no mês ({used}/{limit}).',
    'spendLimits.reached.dailyTokens':
      'Limite de tokens hoje atingido ({used}/{limit}). A próxima mensagem pede confirmação.',
    'spendLimits.reached.monthlyTokens':
      'Limite de tokens no mês atingido ({used}/{limit}). A próxima mensagem pede confirmação.',
    'spendLimits.reached.dailyCost':
      'Limite de custo hoje atingido ({used}/{limit}). A próxima mensagem pede confirmação.',
    'spendLimits.reached.monthlyCost':
      'Limite de custo no mês atingido ({used}/{limit}). A próxima mensagem pede confirmação.',
    'spendLimits.reached.projectMonthlyTokens':
      'Limite de tokens do projeto no mês atingido ({used}/{limit}). A próxima mensagem pede confirmação.',
    'spendLimits.reached.projectMonthlyCost':
      'Limite de custo do projeto no mês atingido ({used}/{limit}). A próxima mensagem pede confirmação.',
    'spendLimits.dismissWarning': 'Dispensar aviso de uso',
    'spendLimits.continue': 'Continuar mesmo assim',
    'spendLimits.dismiss': 'Dispensar aviso',
  },
  {
    'spendLimits.tokens': '{tokens} tokens',
    'spendLimits.noCost': 'cost not reported',
    'spendLimits.runs.zero': '{count} runs',
    'spendLimits.runs.one': '{count} run',
    'spendLimits.runs.other': '{count} runs',
    'spendLimits.unknownCost.one': 'cost not reported for {count} run',
    'spendLimits.unknownCost.other': 'cost not reported for {count} runs',
    'spendLimits.today': 'Today',
    'spendLimits.month': 'This month',
    'spendLimits.noLimit': 'No limit',
    'spendLimits.tokensError': 'Use a whole number of tokens, or leave it empty.',
    'spendLimits.costError': 'Use dollars with up to 2 decimals, like 5.00.',
    'spendLimits.title': 'Usage limits',
    'spendLimits.detail':
      "Before each agent call, checks today's and this month's usage (local time). A response in progress is never interrupted.",
    'spendLimits.enable': 'Limit usage',
    'spendLimits.enableDetail':
      'Warns at 80% and asks for confirmation when a limit is reached. Off, nothing is blocked.',
    'spendLimits.dailyTokens': 'Tokens per day',
    'spendLimits.dailyTokensHint': 'Input + output since 00:00.',
    'spendLimits.monthlyTokens': 'Tokens per month',
    'spendLimits.monthlyTokensHint': 'Input + output in the current month.',
    'spendLimits.dailyCost': 'Cost per day (USD)',
    'spendLimits.monthlyCost': 'Cost per month (USD)',
    'spendLimits.costHint': 'Only counts runs that reported a cost.',
    'spendLimits.allUsage': 'Usage of all conversations',
    'spendLimits.unavailable': 'Usage unavailable: {error}',
    'spendLimits.project.title': 'Project usage',
    'spendLimits.project.detail': '{project} · conversations linked to this project.',
    'spendLimits.project.offNote': 'The limits apply when "Limit usage" is on.',
    'spendLimits.project.monthlyTokens': 'Project tokens per month',
    'spendLimits.project.monthlyCost': 'Project cost per month (USD)',
    'spendLimits.project.usage': 'Project usage',
    'spendLimits.warning.dailyTokens': "Usage at {percent}% of today's token limit ({used}/{limit}).",
    'spendLimits.warning.monthlyTokens': "Usage at {percent}% of this month's token limit ({used}/{limit}).",
    'spendLimits.warning.dailyCost': "Usage at {percent}% of today's cost limit ({used}/{limit}).",
    'spendLimits.warning.monthlyCost': "Usage at {percent}% of this month's cost limit ({used}/{limit}).",
    'spendLimits.warning.projectMonthlyTokens':
      'Usage at {percent}% of the monthly project token limit ({used}/{limit}).',
    'spendLimits.warning.projectMonthlyCost': 'Usage at {percent}% of the monthly project cost limit ({used}/{limit}).',
    'spendLimits.reached.dailyTokens':
      "Today's token limit reached ({used}/{limit}). The next message asks for confirmation.",
    'spendLimits.reached.monthlyTokens':
      "This month's token limit reached ({used}/{limit}). The next message asks for confirmation.",
    'spendLimits.reached.dailyCost':
      "Today's cost limit reached ({used}/{limit}). The next message asks for confirmation.",
    'spendLimits.reached.monthlyCost':
      "This month's cost limit reached ({used}/{limit}). The next message asks for confirmation.",
    'spendLimits.reached.projectMonthlyTokens':
      'Monthly project token limit reached ({used}/{limit}). The next message asks for confirmation.',
    'spendLimits.reached.projectMonthlyCost':
      'Monthly project cost limit reached ({used}/{limit}). The next message asks for confirmation.',
    'spendLimits.dismissWarning': 'Dismiss usage warning',
    'spendLimits.continue': 'Continue anyway',
    'spendLimits.dismiss': 'Dismiss notice',
  },
);
