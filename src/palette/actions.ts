// Command palette registry (docs/specs/command-palette.md): pure builders that turn app
// state and callbacks into a flat list of actions, plus the ranking used by the dialog.
// Nothing here touches the DOM, so it is unit tested directly.
import type { CommandEntry } from '../../shared/commands';
import type { Mode, Project, ProviderInfo, Session } from '../../shared/contracts';
import { fold, fuzzyScore } from './fuzzy';

export const PALETTE_GROUPS = ['Ações', 'Conversas', 'Projetos', 'Agente', 'Modo', 'Comandos salvos'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];
export type PaletteIcon =
  | 'new'
  | 'search'
  | 'settings'
  | 'activity'
  | 'automations'
  | 'memory'
  | 'sidebar'
  | 'export'
  | 'conversation'
  | 'project'
  | 'agent'
  | 'mode'
  | 'command';
export type PalettePage = 'chat' | 'activity' | 'automations' | 'memory' | 'settings';

export interface PaletteAction {
  /** Stable id, also what the recents list stores (never titles or content). */
  id: string;
  group: PaletteGroup;
  label: string;
  detail?: string;
  /** Extra words matched by the filter but not shown. */
  keywords?: string;
  icon: PaletteIcon;
  /** Visual hint, one entry per key (e.g. ['Ctrl', 'K']). */
  shortcut?: string[];
  /** aria-keyshortcuts value, e.g. "Control+K". */
  ariaShortcut?: string;
  /** The current choice (model, mode, open conversation). */
  current?: boolean;
  disabled?: boolean;
  /** Shown instead of the detail while disabled. */
  disabledReason?: string;
  run: () => void;
}

export interface PaletteState {
  page: PalettePage;
  /** The open conversation, if any. */
  session?: Pick<Session, 'id' | 'providerId' | 'model' | 'mode'>;
  /** A run is active (or a send/settings write is in flight): conversation settings are locked. */
  running: boolean;
  sessions: Pick<Session, 'id' | 'title' | 'updatedAt' | 'projectId'>[];
  projects: Pick<Project, 'id' | 'name' | 'path'>[];
  providers: ProviderInfo[];
  commands: CommandEntry[];
  sidebarCollapsed: boolean;
  isMac?: boolean;
}

export interface PaletteCallbacks {
  newConversation: () => void;
  search: () => void;
  goTo: (page: Exclude<PalettePage, 'chat'>) => void;
  toggleSidebar: () => void;
  exportConversation: (sessionId: string, format: 'md' | 'json') => void;
  openConversation: (sessionId: string) => void;
  openProject: (projectId: string) => void;
  setModel: (providerId: ProviderInfo['id'], model?: string) => void;
  setMode: (mode: Mode) => void;
  insertCommand: (name: string) => void;
}

const MODES: { value: Mode; label: string; detail: string }[] = [
  { value: 'fast', label: 'Rápido', detail: 'Caminho curto com um executor' },
  { value: 'auto', label: 'Auto', detail: 'Rota escolhida por regras locais' },
  { value: 'deep', label: 'Completo', detail: 'Mais contexto e esforço' },
];
const NO_SESSION = 'Abra uma conversa primeiro';
const RUNNING = 'Indisponível durante a execução';

/** Every palette action for the current state. Disabled actions stay listed, with a reason. */
export function buildActions(state: PaletteState, cb: PaletteCallbacks): PaletteAction[] {
  const mod = state.isMac ? '⌘' : 'Ctrl';
  const session = state.session;
  // Conversation settings: need an open conversation and no active run.
  const lock: Pick<PaletteAction, 'disabled' | 'disabledReason'> = !session
    ? { disabled: true, disabledReason: NO_SESSION }
    : state.running
      ? { disabled: true, disabledReason: RUNNING }
      : {};
  const actions: PaletteAction[] = [
    {
      id: 'action:new',
      group: 'Ações',
      label: 'Nova conversa',
      detail: 'Conversa avulsa, sem projeto',
      icon: 'new',
      shortcut: [mod, 'K'],
      ariaShortcut: state.isMac ? 'Meta+K' : 'Control+K',
      run: cb.newConversation,
    },
    {
      id: 'action:search',
      group: 'Ações',
      label: 'Buscar em conversas',
      detail: 'Títulos e mensagens',
      icon: 'search',
      shortcut: [mod, 'Shift', 'F'],
      ariaShortcut: state.isMac ? 'Meta+Shift+F' : 'Control+Shift+F',
      run: cb.search,
    },
    {
      id: 'action:settings',
      group: 'Ações',
      label: 'Abrir configurações',
      keywords: 'preferencias ajustes',
      icon: 'settings',
      current: state.page === 'settings',
      run: () => cb.goTo('settings'),
    },
    {
      id: 'action:activity',
      group: 'Ações',
      label: 'Abrir atividade',
      keywords: 'execucoes historico',
      icon: 'activity',
      current: state.page === 'activity',
      run: () => cb.goTo('activity'),
    },
    {
      id: 'action:automations',
      group: 'Ações',
      label: 'Abrir automações',
      keywords: 'agendamento agenda tarefas agendadas',
      icon: 'automations',
      current: state.page === 'automations',
      run: () => cb.goTo('automations'),
    },
    {
      id: 'action:memory',
      group: 'Ações',
      label: 'Abrir memória',
      keywords: 'ai-memory',
      icon: 'memory',
      current: state.page === 'memory',
      run: () => cb.goTo('memory'),
    },
    {
      id: 'action:sidebar',
      group: 'Ações',
      label: 'Alternar barra lateral',
      detail: state.sidebarCollapsed ? 'Expandir navegação' : 'Recolher navegação',
      keywords: 'navegacao menu',
      icon: 'sidebar',
      run: cb.toggleSidebar,
    },
    ...(['md', 'json'] as const).map((format): PaletteAction => ({
      id: `export:${format}`,
      group: 'Ações',
      label: `Exportar conversa (${format === 'md' ? 'Markdown' : 'JSON'})`,
      detail: format === 'md' ? 'Mensagens visíveis' : 'Detalhes completos',
      keywords: 'baixar download',
      icon: 'export',
      ...(session ? {} : { disabled: true, disabledReason: NO_SESSION }),
      run: () => session && cb.exportConversation(session.id, format),
    })),
  ];

  const projectName = new Map(state.projects.map((p) => [p.id, p.name]));
  for (const item of [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    actions.push({
      id: `conversation:${item.id}`,
      group: 'Conversas',
      label: item.title || 'Nova conversa',
      detail: item.projectId ? projectName.get(item.projectId) || 'Projeto' : 'Conversa avulsa',
      icon: 'conversation',
      current: item.id === session?.id && state.page === 'chat',
      run: () => cb.openConversation(item.id),
    });

  for (const project of state.projects)
    actions.push({
      id: `project:${project.id}`,
      group: 'Projetos',
      label: project.name,
      detail: project.path,
      icon: 'project',
      run: () => cb.openProject(project.id),
    });

  for (const provider of state.providers) {
    const unavailable = provider.available
      ? {}
      : { disabled: true, disabledReason: `${provider.name} indisponível neste computador` };
    const isProvider = session?.providerId === provider.id;
    actions.push({
      id: `model:${provider.id}`,
      group: 'Agente',
      label: `${provider.name} · Modelo padrão`,
      detail: provider.defaultModel || 'Padrão do provedor',
      keywords: 'agente provedor modelo',
      icon: 'agent',
      current: isProvider && !session?.model,
      ...(lock.disabled ? lock : unavailable),
      run: () => cb.setModel(provider.id, undefined),
    });
    for (const model of provider.models)
      actions.push({
        id: `model:${provider.id}:${model.id}`,
        group: 'Agente',
        label: `${provider.name} · ${model.name}`,
        detail: model.id,
        keywords: 'agente provedor modelo',
        icon: 'agent',
        current: isProvider && session?.model === model.id,
        ...(lock.disabled ? lock : unavailable),
        run: () => cb.setModel(provider.id, model.id),
      });
  }

  for (const mode of MODES)
    actions.push({
      id: `mode:${mode.value}`,
      group: 'Modo',
      label: mode.label,
      detail: mode.detail,
      keywords: 'modo execucao',
      icon: 'mode',
      current: session?.mode === mode.value,
      ...lock,
      run: () => cb.setMode(mode.value),
    });

  for (const command of state.commands.filter((c) => c.active))
    actions.push({
      id: `command:${command.name}`,
      group: 'Comandos salvos',
      label: `/${command.name}`,
      detail: command.description || undefined,
      keywords: 'comando slash',
      icon: 'command',
      ...(session ? {} : { disabled: true, disabledReason: NO_SESSION }),
      run: () => cb.insertCommand(command.name),
    });
  return actions;
}

export interface PaletteSection {
  /** "Recentes" only for the empty-query view; otherwise the action group. */
  title: PaletteGroup | 'Recentes';
  items: PaletteAction[];
}

/** Rows per group with an empty query (all groups still filter over every item). */
export const EMPTY_QUERY_LIMIT: Partial<Record<PaletteGroup, number>> = { Conversas: 8, Agente: 8 };
export const QUERY_GROUP_LIMIT = 12;
export const RECENT_SECTION_LIMIT = 5;
/** Score bonus for a recent action: the most recent gets the most, fading with age. */
const RECENT_BONUS = 120;
/** Matches only in keywords/group/detail rank below a contiguous match in the label. */
const SECONDARY_PENALTY = 500;

/** Score of an action for `query`, or null when it does not match. */
export function scoreAction(action: PaletteAction, query: string): number | null {
  const label = fuzzyScore(query, action.label);
  const haystack = `${action.group} ${action.label} ${action.detail ?? ''} ${action.keywords ?? ''}`;
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  let secondary: number | null = 0;
  for (const token of tokens) {
    const score = fuzzyScore(token, haystack);
    if (score === null) {
      secondary = null;
      break;
    }
    secondary += score;
  }
  const fallback = secondary === null ? null : secondary - SECONDARY_PENALTY;
  if (label === null) return fallback;
  return fallback === null ? label : Math.max(label, fallback);
}

/**
 * Sections to show. Empty query: up to five recent actions first, then every group in its
 * fixed order. With a query: matching items by score (recents get a bonus), and groups
 * ordered by their best item.
 */
export function rankActions(actions: PaletteAction[], query: string, recents: string[] = []): PaletteSection[] {
  const recency = new Map(recents.map((id, index) => [id, index]));
  const byId = new Map(actions.map((a) => [a.id, a]));
  if (!query.trim()) {
    const recent = recents
      .map((id) => byId.get(id))
      .filter((a): a is PaletteAction => Boolean(a))
      .slice(0, RECENT_SECTION_LIMIT);
    const shown = new Set(recent.map((a) => a.id));
    const sections: PaletteSection[] = recent.length ? [{ title: 'Recentes', items: recent }] : [];
    for (const group of PALETTE_GROUPS) {
      const items = actions.filter((a) => a.group === group && !shown.has(a.id)).slice(0, EMPTY_QUERY_LIMIT[group]);
      if (items.length) sections.push({ title: group, items });
    }
    return sections;
  }
  const scored = actions
    .map((action, order) => {
      const score = scoreAction(action, query);
      const rank = recency.get(action.id);
      const bonus = rank === undefined ? 0 : RECENT_BONUS * (1 - rank / Math.max(recents.length, 1));
      return { action, order, score: score === null ? null : score + bonus };
    })
    .filter((entry): entry is { action: PaletteAction; order: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const sections = new Map<PaletteGroup, PaletteAction[]>();
  for (const { action } of scored) {
    const items = sections.get(action.group) ?? [];
    if (items.length < QUERY_GROUP_LIMIT) items.push(action);
    sections.set(action.group, items);
  }
  // Map insertion order follows the best score of each group.
  return [...sections].map(([title, items]) => ({ title, items }));
}
