// Run activity texts with a catalog key (docs/i18n.md, "Run activity events"). Activity events
// are persisted with their `text` in the language the server produced them in (pt-BR); new
// events also carry `textKey` + `textVars`, so the UI can show them in its own locale and fall
// back to `text` for older events or unknown keys (src/i18n/eventText.ts). Shared by the server
// (which writes the pt-BR `text` from here) and the UI (which translates). Keep pt-BR
// byte-identical: specs and tests match these texts.
import { DEFAULT_LOCALE, defineMessages, translate, type Locale, type PluralBase, type Vars } from './i18n.js';

const catalog = defineMessages(
  {
    'event.compacting': 'Compactando a conversa…',
    'event.compacted': 'Conversa compactada',
    'event.compactedBefore': 'Conversa compactada antes desta mensagem: {reason}',
    'event.compactFailed': 'Não foi possível compactar a conversa: {error}',
    'event.compactSkipped': 'Não foi possível compactar a conversa ({error}); a mensagem seguiu sem compactar.',
    'event.commandExpanded': 'Comando /{name} ({source}) expandido',
    'event.commandExpandedMode': 'Comando /{name} ({source}) expandido; modo {mode} nesta execução',
    'event.commandSource.builtin': 'embutido',
    'event.commandSource.global': 'global',
    'event.commandSource.repo': 'do repositório',
    'event.commandSource.project': 'do projeto',
    'event.mode.auto': 'Auto',
    'event.mode.fast': 'Rápido',
    'event.mode.deep': 'Completo',
    'event.taskEffort': 'Esforço efetivo da tarefa “{title}”: {effort}',
    'event.taskEffortAuto': 'Esforço efetivo da tarefa “{title}”: Auto (nativo)',
    'event.memoryUnavailable': 'Memória indisponível: {detail}',
    'event.mentionIncluded.one': 'Arquivo mencionado incluído: {paths}',
    'event.mentionIncluded.other': 'Arquivos mencionados incluídos: {paths}',
    'event.mentionIgnored': 'Menção ignorada: {path} ({reason})',
    'event.graphifyTask': 'Graphify indisponível para {title}: {error}',
    'event.graphifyPlanning': 'Graphify indisponível para planejamento: {error}',
    'event.invalidPlan': 'Plano inválido; delegando tarefa integral: {error}',
    'event.steered': 'Orientação enviada ao agente: {content}',
    'event.retrying': '{reason}; tentando de novo ({attempt}/{of}) em {seconds} s',
    'event.retryingTask': '{task}: {reason}; tentando de novo ({attempt}/{of}) em {seconds} s',
    'event.approved': 'Aprovado',
    'event.denied': 'Negado',
    // The check headline (shared/hooks.ts checkHeadline).
    'event.check.running': 'Verificação: {name} em andamento',
    'event.check.passed': 'Verificação: {name} passou{seconds}',
    'event.check.failed': 'Verificação: {name} falhou (código {code})',
    'event.check.timeout': 'Verificação: {name} excedeu o tempo limite{seconds}',
    'event.check.cancelled': 'Verificação: {name} cancelada',
    'event.check.cancelledDetail': 'Verificação: {name} cancelada: {detail}',
    'event.check.error': 'Verificação: {name} não pôde rodar',
    'event.check.errorDetail': 'Verificação: {name} não pôde rodar: {detail}',
  },
  {
    'event.compacting': 'Compacting the conversation…',
    'event.compacted': 'Conversation compacted',
    'event.compactedBefore': 'Conversation compacted before this message: {reason}',
    'event.compactFailed': 'Could not compact the conversation: {error}',
    'event.compactSkipped': 'Could not compact the conversation ({error}); the message went on without compacting.',
    'event.commandExpanded': 'Command /{name} ({source}) expanded',
    'event.commandExpandedMode': 'Command /{name} ({source}) expanded; {mode} mode for this run',
    'event.commandSource.builtin': 'built-in',
    'event.commandSource.global': 'global',
    'event.commandSource.repo': 'from the repository',
    'event.commandSource.project': 'from the project',
    'event.mode.auto': 'Auto',
    'event.mode.fast': 'Fast',
    'event.mode.deep': 'Thorough',
    'event.taskEffort': 'Effective effort of task “{title}”: {effort}',
    'event.taskEffortAuto': 'Effective effort of task “{title}”: Auto (native)',
    'event.memoryUnavailable': 'Memory unavailable: {detail}',
    'event.mentionIncluded.one': 'Mentioned file included: {paths}',
    'event.mentionIncluded.other': 'Mentioned files included: {paths}',
    'event.mentionIgnored': 'Mention ignored: {path} ({reason})',
    'event.graphifyTask': 'Graphify unavailable for {title}: {error}',
    'event.graphifyPlanning': 'Graphify unavailable for planning: {error}',
    'event.invalidPlan': 'Invalid plan; delegating the whole task: {error}',
    'event.steered': 'Steering sent to the agent: {content}',
    'event.retrying': '{reason}; trying again ({attempt}/{of}) in {seconds} s',
    'event.retryingTask': '{task}: {reason}; trying again ({attempt}/{of}) in {seconds} s',
    'event.approved': 'Approved',
    'event.denied': 'Denied',
    'event.check.running': 'Check: {name} running',
    'event.check.passed': 'Check: {name} passed{seconds}',
    'event.check.failed': 'Check: {name} failed (exit code {code})',
    'event.check.timeout': 'Check: {name} timed out{seconds}',
    'event.check.cancelled': 'Check: {name} cancelled',
    'event.check.cancelledDetail': 'Check: {name} cancelled: {detail}',
    'event.check.error': 'Check: {name} could not run',
    'event.check.errorDetail': 'Check: {name} could not run: {detail}',
  },
);
export default catalog;

type CatalogKey = keyof (typeof catalog)['pt-BR'] & string;
/** An event text key, or the base of a plural (`event.mentionIncluded`, called with `count`). */
export type EventTextKey = CatalogKey | PluralBase<CatalogKey>;
const keys = new Set<string>(
  Object.keys(catalog['pt-BR']).flatMap((key) => (key.endsWith('.other') ? [key, key.slice(0, -6)] : [key])),
);
export const isEventTextKey = (value: unknown): value is EventTextKey => typeof value === 'string' && keys.has(value);

/**
 * Text of an event key in `locale` (pt-BR by default). Variables that are themselves event keys
 * (`{ source: { key: 'event.commandSource.repo' } }`) are translated first.
 */
export function eventText(key: EventTextKey, vars?: EventVars, locale: Locale = DEFAULT_LOCALE): string {
  return translate(catalog, locale, key, resolveVars(vars, locale));
}
/** Variables of an event text: plain values, or a nested key (a label translated with the sentence). */
export type EventVars = Record<string, string | number | { key: EventTextKey }>;
function resolveVars(vars: EventVars | undefined, locale: Locale): Vars | undefined {
  if (!vars) return undefined;
  const out: Vars = {};
  for (const [name, value] of Object.entries(vars))
    out[name] = typeof value === 'object' ? translate(catalog, locale, value.key) : value;
  return out;
}
/** Key and variables of a check headline; eventText() of it equals checkHeadline() in pt-BR. */
export function checkHeadlineKey(result: {
  name: string;
  status: string;
  durationMs?: number;
  exitCode?: number | null;
  detail?: string;
}): { key: EventTextKey; vars: EventVars } {
  const seconds = result.durationMs === undefined ? '' : ` (${Math.max(0, Math.round(result.durationMs / 1000))} s)`;
  const name = result.name;
  switch (result.status) {
    case 'running':
      return { key: 'event.check.running', vars: { name } };
    case 'passed':
      return { key: 'event.check.passed', vars: { name, seconds } };
    case 'failed':
      return { key: 'event.check.failed', vars: { name, code: result.exitCode ?? '?' } };
    case 'timeout':
      return { key: 'event.check.timeout', vars: { name, seconds } };
    case 'cancelled':
      return result.detail
        ? { key: 'event.check.cancelledDetail', vars: { name, detail: result.detail } }
        : { key: 'event.check.cancelled', vars: { name } };
    default:
      return result.detail
        ? { key: 'event.check.errorDetail', vars: { name, detail: result.detail } }
        : { key: 'event.check.error', vars: { name } };
  }
}
/** The pt-BR `text` of a new event plus its key, ready to spread into a RunEvent. */
export const eventFields = (key: EventTextKey, vars?: EventVars) => ({
  text: eventText(key, vars),
  textKey: key,
  ...(vars ? { textVars: vars } : {}),
});
