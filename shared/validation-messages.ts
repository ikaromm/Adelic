// Validation messages of the request schemas (shared/schemas.ts) and of the forms that repeat the
// same checks (MCP, saved commands, automations, hooks). They live in shared/ because the UI uses
// the same constants; the server registers this catalog as its `validation` area
// (server/i18n/messages/validation.ts), and `parseBody(…, locale)` translates them. Keep pt-BR
// byte-identical: API clients and tests compare these texts.
import { DEFAULT_LOCALE, defineMessages, translate, type Locale, type Vars } from './i18n.js';

const catalog = defineMessages(
  {
    // Generic field errors (`<field> inválido`, `<field> deve ser booleano`, …).
    'validation.invalidField': '{field} inválido',
    'validation.booleanField': '{field} deve ser booleano',
    'validation.oneOf2': '{field} deve ser {a} ou {b}',
    'validation.oneOf3': '{field} deve ser {a}, {b} ou {c}',
    'validation.requiredField': '{field} obrigatório',
    'validation.confirm.update': 'confirm: true é obrigatório para atualizar',
    'validation.confirm.applyWorktree': 'confirm: true é obrigatório para aplicar no projeto',
    'validation.confirm.restore': 'confirm: true é obrigatório para desfazer alterações',
    'validation.confirm.discard': 'confirm: true é obrigatório para descartar alterações',
    'validation.confirm.push': 'confirm: true é obrigatório para enviar',
    'validation.projectFields': 'Campos de projeto inválidos',
    'validation.projectSpendLimits':
      'spendLimits inválido (monthlyTokens inteiro não negativo, monthlyCostUsd com até 2 casas; null remove)',
    'validation.spendLimits':
      'spendLimits inválido (tokens: inteiros não negativos; custo: dólares não negativos com até 2 casas; null remove o limite)',
    'validation.content': 'content obrigatório (máximo {max} caracteres)',
    'validation.attachmentIds': 'attachmentIds inválido (até {max} anexos, sem repetição)',
    'validation.attachmentName': 'name obrigatório (até {max} caracteres)',
    'validation.attachmentData': 'data deve ser o conteúdo do arquivo em base64',
    'validation.modelFallback': 'modelFallback inválido (até {max} modelos diferentes, cada um com providerId e model)',
    'validation.intRange': '{field} deve ser um inteiro entre {min} e {max}',
    'validation.intFromTo': '{field} deve ser um inteiro de {min} a {max}',
    'validation.terminalCommand': 'command obrigatório (máximo {max} caracteres)',
    'validation.planMarkdown': 'markdown obrigatório (máximo {max} caracteres)',
    'validation.mentionQuery': 'query deve ser um texto de até {max} caracteres',
    'validation.gitPaths': 'Informe paths ou all: true',
    'validation.gitMessage': 'Mensagem obrigatória, com até {max} caracteres',
    'validation.remoteUsername':
      'username: {min} a {max} caracteres, só letras minúsculas, números, ponto, hífen e sublinhado',
    'validation.remotePassword': 'password: de {min} a {max} caracteres',
    // Saved commands (shared/commands.ts).
    'validation.command.name':
      'Nome inválido: use de 1 a 32 letras minúsculas, números ou hífens, começando por letra ou número',
    'validation.command.description': 'Descrição até {max} caracteres',
    'validation.command.template': 'Modelo obrigatório (até {max} caracteres)',
    'validation.command.mode': 'mode deve ser fast, balanced ou deep',
    'validation.command.reserved': 'Nome reservado para uma ação embutida do Adelic',
    // MCP catalog (shared/mcp.ts).
    'validation.mcp.name':
      'Nome inválido: use de 1 a 48 letras minúsculas, números, _ ou -, começando por letra ou número',
    'validation.mcp.description': 'Descrição até {max} caracteres',
    'validation.mcp.command': 'Informe o comando: um caminho absoluto ou um nome encontrado no PATH',
    'validation.mcp.args': 'Até {max} argumentos, cada um com até {argMax} caracteres',
    'validation.mcp.env':
      'Até {max} variáveis com nomes válidos e sem repetição; valores literais até {valueMax} caracteres',
    'validation.mcp.literal': 'Informe o valor da variável literal',
    'validation.mcp.tools': 'Lista de ferramentas: até {max} nomes válidos, sem repetição',
    'validation.mcp.transport': 'Somente servidores locais (stdio) são aceitos nesta versão',
    'validation.mcp.duplicate': 'Já existe um servidor MCP com esse nome',
    'validation.mcp.notFound': 'Servidor MCP não encontrado',
    'validation.mcp.unknownIds': 'Servidor MCP desconhecido no catálogo',
    'validation.mcp.projectLimit': 'Até {max} servidores MCP por projeto, sem repetição',
    // Automations (AUTOMATION_MESSAGES).
    'validation.automation.name': 'Nome obrigatório (até {max} caracteres)',
    'validation.automation.prompt': 'Pedido obrigatório (até {max} caracteres)',
    'validation.automation.projectId': 'projectId obrigatório: automações rodam sempre num projeto',
    'validation.automation.schedule':
      'Agenda inválida: diária ou semanal com horário HH:MM (semanal com ao menos um dia de 0 a 6), ou intervalo de {min} a {max} horas',
    'validation.automation.timezone': 'Fuso horário desconhecido (use um nome IANA, como America/Sao_Paulo)',
    'validation.automation.deny': 'denyApprovalsAfterMinutes deve ser null ou um inteiro de 1 a {max}',
    // Project hooks (HOOKS_MESSAGES).
    'validation.hooks.afterEdit':
      'afterEdit inválido: até {max} verificações com name (até {nameMax} caracteres), command (até {commandMax}), timeoutSec de {timeoutMin} a {timeoutMax} e enabled',
    'validation.hooks.blockedCommands':
      'blockedCommands inválido: até {max} padrões de até {patternMax} caracteres, sem repetição',
  },
  {
    'validation.invalidField': 'Invalid {field}',
    'validation.booleanField': '{field} must be a boolean',
    'validation.oneOf2': '{field} must be {a} or {b}',
    'validation.oneOf3': '{field} must be {a}, {b} or {c}',
    'validation.requiredField': '{field} is required',
    'validation.confirm.update': 'confirm: true is required to update',
    'validation.confirm.applyWorktree': 'confirm: true is required to apply to the project',
    'validation.confirm.restore': 'confirm: true is required to undo changes',
    'validation.confirm.discard': 'confirm: true is required to discard changes',
    'validation.confirm.push': 'confirm: true is required to push',
    'validation.projectFields': 'Invalid project fields',
    'validation.projectSpendLimits':
      'Invalid spendLimits (monthlyTokens a non-negative integer, monthlyCostUsd with up to 2 decimals; null removes)',
    'validation.spendLimits':
      'Invalid spendLimits (tokens: non-negative integers; cost: non-negative dollars with up to 2 decimals; null removes the limit)',
    'validation.content': 'content is required (at most {max} characters)',
    'validation.attachmentIds': 'Invalid attachmentIds (up to {max} attachments, no repeats)',
    'validation.attachmentName': 'name is required (up to {max} characters)',
    'validation.attachmentData': 'data must be the file content in base64',
    'validation.modelFallback': 'Invalid modelFallback (up to {max} different models, each with providerId and model)',
    'validation.intRange': '{field} must be an integer between {min} and {max}',
    'validation.intFromTo': '{field} must be an integer from {min} to {max}',
    'validation.terminalCommand': 'command is required (at most {max} characters)',
    'validation.planMarkdown': 'markdown is required (at most {max} characters)',
    'validation.mentionQuery': 'query must be a text of up to {max} characters',
    'validation.gitPaths': 'Provide paths or all: true',
    'validation.gitMessage': 'A message is required, up to {max} characters',
    'validation.remoteUsername':
      'username: {min} to {max} characters, only lowercase letters, digits, dot, hyphen and underscore',
    'validation.remotePassword': 'password: {min} to {max} characters',
    'validation.command.name':
      'Invalid name: use 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit',
    'validation.command.description': 'Description up to {max} characters',
    'validation.command.template': 'Template is required (up to {max} characters)',
    'validation.command.mode': 'mode must be fast, balanced or deep',
    'validation.command.reserved': 'Name reserved for a built-in Adelic action',
    'validation.mcp.name':
      'Invalid name: use 1 to 48 lowercase letters, digits, _ or -, starting with a letter or digit',
    'validation.mcp.description': 'Description up to {max} characters',
    'validation.mcp.command': 'Enter the command: an absolute path or a name found in PATH',
    'validation.mcp.args': 'Up to {max} arguments, each up to {argMax} characters',
    'validation.mcp.env': 'Up to {max} variables with valid, unique names; literal values up to {valueMax} characters',
    'validation.mcp.literal': 'Enter the value of the literal variable',
    'validation.mcp.tools': 'Tool list: up to {max} valid names, no repeats',
    'validation.mcp.transport': 'Only local (stdio) servers are accepted in this version',
    'validation.mcp.duplicate': 'An MCP server with this name already exists',
    'validation.mcp.notFound': 'MCP server not found',
    'validation.mcp.unknownIds': 'Unknown MCP server in the catalog',
    'validation.mcp.projectLimit': 'Up to {max} MCP servers per project, no repeats',
    'validation.automation.name': 'Name is required (up to {max} characters)',
    'validation.automation.prompt': 'Request is required (up to {max} characters)',
    'validation.automation.projectId': 'projectId is required: automations always run in a project',
    'validation.automation.schedule':
      'Invalid schedule: daily or weekly at HH:MM (weekly with at least one day from 0 to 6), or an interval of {min} to {max} hours',
    'validation.automation.timezone': 'Unknown time zone (use an IANA name, such as America/Sao_Paulo)',
    'validation.automation.deny': 'denyApprovalsAfterMinutes must be null or an integer from 1 to {max}',
    'validation.hooks.afterEdit':
      'Invalid afterEdit: up to {max} checks with name (up to {nameMax} characters), command (up to {commandMax}), timeoutSec from {timeoutMin} to {timeoutMax} and enabled',
    'validation.hooks.blockedCommands':
      'Invalid blockedCommands: up to {max} patterns of up to {patternMax} characters, no repeats',
  },
);
export default catalog;

export type ValidationKey = keyof (typeof catalog)['pt-BR'] & string;
/** A validation message: its catalog key and variables, plus the pt-BR text (the API's historical text). */
export interface ValidationMessage {
  key: ValidationKey;
  vars?: Vars;
  text: string;
}

/** Text of a validation key in `locale` (pt-BR by default). */
export const validationText = (key: ValidationKey, vars?: Vars, locale: Locale = DEFAULT_LOCALE) =>
  translate(catalog, locale, key, vars);
export const isValidationKey = (value: unknown): value is ValidationKey =>
  typeof value === 'string' && Object.hasOwn(catalog['pt-BR'], value);
export const vmsg = (key: ValidationKey, vars?: Vars): ValidationMessage => ({
  key,
  ...(vars ? { vars } : {}),
  text: validationText(key, vars),
});
