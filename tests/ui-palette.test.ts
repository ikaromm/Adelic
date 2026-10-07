import { describe, expect, it, vi } from 'vitest';
import type { CommandEntry } from '../shared/commands';
import type { ProviderInfo } from '../shared/contracts';
import { fold, fuzzyScore } from '../src/palette/fuzzy';
import { RECENTS_KEY, RECENTS_MAX, loadRecents, recordRecent } from '../src/palette/recents';
import {
  PALETTE_GROUPS,
  buildActions,
  rankActions,
  type PaletteCallbacks,
  type PaletteState,
} from '../src/palette/actions';
import { isPaletteKey } from '../src/hooks/useGlobalShortcuts';

describe('palette fuzzy scorer', () => {
  it('ignores case and accents', () => {
    expect(fold('Configurações Ação')).toBe('configuracoes acao');
    expect(fuzzyScore('configuracoes', 'Abrir configurações')).not.toBeNull();
    expect(fuzzyScore('AÇÃO', 'acao rapida')).not.toBeNull();
  });
  it('matches subsequences and rejects the rest', () => {
    expect(fuzzyScore('nvcv', 'Nova conversa')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Nova conversa')).toBeNull();
    expect(fuzzyScore('conversas longas demais', 'conv')).toBeNull();
  });
  it('scores an empty query as a neutral match', () => {
    expect(fuzzyScore('', 'qualquer coisa')).toBe(0);
    expect(fuzzyScore('   ', 'qualquer coisa')).toBe(0);
  });
  it('prefers prefixes, then word starts, then contiguous text, then scattered letters', () => {
    const prefix = fuzzyScore('conf', 'Configurações')!;
    const word = fuzzyScore('conf', 'Abrir configurações')!;
    const inner = fuzzyScore('onf', 'Abrir configurações')!;
    const scattered = fuzzyScore('cfg', 'Abrir configurações')!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(scattered);
  });
  it('prefers word-start letters and shorter targets among scattered matches', () => {
    expect(fuzzyScore('ac', 'Abrir configurações')!).toBeGreaterThan(fuzzyScore('ac', 'Xabxc')!);
    expect(fuzzyScore('rap', 'Rápido')!).toBeGreaterThan(fuzzyScore('rap', 'Rápido demais para isto')!);
  });
});

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe('palette recents', () => {
  it('stores ids most recent first, without duplicates and bounded', () => {
    const storage = memoryStorage();
    for (let i = 0; i < 30; i++) recordRecent(`conversation:s${i}`, storage);
    recordRecent('conversation:s5', storage);
    const list = loadRecents(storage);
    expect(list).toHaveLength(RECENTS_MAX);
    expect(list[0]).toBe('conversation:s5');
    expect(list[1]).toBe('conversation:s29');
    expect(new Set(list).size).toBe(list.length);
  });
  it('never stores free text such as titles or message content', () => {
    const storage = memoryStorage();
    recordRecent('Mensagem secreta com espaços', storage);
    recordRecent(`command:${'x'.repeat(500)}`, storage);
    recordRecent('mode:fast', storage);
    expect(JSON.parse(storage.values.get(RECENTS_KEY)!)).toEqual(['mode:fast']);
  });
  it('drops malformed storage and survives a missing or failing store', () => {
    const storage = memoryStorage();
    storage.values.set(RECENTS_KEY, '{nope');
    expect(loadRecents(storage)).toEqual([]);
    storage.values.set(RECENTS_KEY, JSON.stringify(['mode:auto', 42, 'texto livre', 'mode:auto']));
    expect(loadRecents(storage)).toEqual(['mode:auto']);
    expect(loadRecents(null)).toEqual([]);
    expect(loadRecents()).toEqual([]); // no window in this environment
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(recordRecent('mode:deep', failing)).toEqual(['mode:deep']);
  });
});

const provider = (over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'codex',
  name: 'Codex',
  installed: true,
  available: true,
  status: 'ready',
  detail: '',
  models: [{ id: 'gpt-x', name: 'GPT X' }],
  defaultModel: 'gpt-x',
  capabilities: { fast: true, tools: true, approvals: true, cancel: true },
  ...over,
});
const command = (name: string, active = true): CommandEntry => ({
  id: name,
  name,
  description: `Descrição de ${name}`,
  template: 'corpo do modelo',
  source: 'builtin',
  projectId: null,
  readOnly: true,
  active,
});
const callbacks = (): PaletteCallbacks => ({
  newConversation: vi.fn(),
  search: vi.fn(),
  goTo: vi.fn(),
  toggleSidebar: vi.fn(),
  exportConversation: vi.fn(),
  openConversation: vi.fn(),
  openProject: vi.fn(),
  setModel: vi.fn(),
  setMode: vi.fn(),
  insertCommand: vi.fn(),
});
const state = (over: Partial<PaletteState> = {}): PaletteState => ({
  page: 'chat',
  session: { id: 's1', providerId: 'codex', model: undefined, mode: 'auto' },
  running: false,
  sessions: [
    { id: 's1', title: 'Relatório de vendas', updatedAt: '2026-10-01T10:00:00Z', projectId: null },
    { id: 's2', title: 'Migração do banco', updatedAt: '2026-10-05T10:00:00Z', projectId: 'p1' },
  ],
  projects: [{ id: 'p1', name: 'Adelic', path: '/home/x/adelic' }],
  providers: [provider(), provider({ id: 'claude', name: 'Claude', available: false, models: [] })],
  commands: [command('revisar'), command('sombra', false)],
  sidebarCollapsed: false,
  ...over,
});

describe('palette action builders', () => {
  it('covers every group, in order, with stable ids', () => {
    const actions = buildActions(state(), callbacks());
    expect([...new Set(actions.map((a) => a.group))]).toEqual([...PALETTE_GROUPS]);
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
    expect(actions.find((a) => a.id === 'action:new')?.shortcut).toEqual(['Ctrl', 'K']);
    expect(buildActions(state({ isMac: true }), callbacks()).find((a) => a.id === 'action:new')?.shortcut).toEqual([
      '⌘',
      'K',
    ]);
  });
  it('lists conversations recent first and active commands only', () => {
    const actions = buildActions(state(), callbacks());
    expect(actions.filter((a) => a.group === 'Conversas').map((a) => a.label)).toEqual([
      'Migração do banco',
      'Relatório de vendas',
    ]);
    expect(actions.find((a) => a.id === 'conversation:s2')?.detail).toBe('Adelic');
    expect(actions.find((a) => a.id === 'conversation:s1')?.current).toBe(true);
    expect(actions.filter((a) => a.group === 'Comandos salvos').map((a) => a.label)).toEqual(['/revisar']);
  });
  it('disables agent and mode changes while a run is active, but not navigation', () => {
    const actions = buildActions(state({ running: true }), callbacks());
    for (const action of actions.filter((a) => a.group === 'Agente' || a.group === 'Modo')) {
      expect(action.disabled).toBe(true);
      expect(action.disabledReason).toMatch(/execução/);
    }
    expect(actions.find((a) => a.id === 'conversation:s2')?.disabled).toBeFalsy();
    expect(actions.find((a) => a.id === 'command:revisar')?.disabled).toBeFalsy();
    expect(actions.find((a) => a.id === 'export:md')?.disabled).toBeFalsy();
  });
  it('needs an open conversation for conversation actions', () => {
    const actions = buildActions(state({ session: undefined }), callbacks());
    for (const id of ['mode:fast', 'model:codex', 'export:json', 'command:revisar'])
      expect(actions.find((a) => a.id === id)?.disabledReason).toBe('Abra uma conversa primeiro');
    expect(actions.find((a) => a.id === 'action:new')?.disabled).toBeFalsy();
  });
  it('disables unavailable providers and marks the current model and mode', () => {
    const actions = buildActions(state(), callbacks());
    expect(actions.find((a) => a.id === 'model:claude')?.disabledReason).toMatch(/indisponível/);
    expect(actions.find((a) => a.id === 'model:codex')?.current).toBe(true);
    expect(actions.find((a) => a.id === 'model:codex:gpt-x')?.current).toBe(false);
    expect(actions.find((a) => a.id === 'mode:auto')?.current).toBe(true);
    expect(actions.filter((a) => a.group === 'Modo').map((a) => a.label)).toEqual(['Rápido', 'Auto', 'Completo']);
  });
  it('wires each action to its callback', () => {
    const cb = callbacks();
    const byId = new Map(buildActions(state(), cb).map((a) => [a.id, a]));
    byId.get('conversation:s2')!.run();
    byId.get('project:p1')!.run();
    byId.get('model:codex:gpt-x')!.run();
    byId.get('mode:deep')!.run();
    byId.get('command:revisar')!.run();
    byId.get('export:json')!.run();
    byId.get('action:settings')!.run();
    expect(cb.openConversation).toHaveBeenCalledWith('s2');
    expect(cb.openProject).toHaveBeenCalledWith('p1');
    expect(cb.setModel).toHaveBeenCalledWith('codex', 'gpt-x');
    expect(cb.setMode).toHaveBeenCalledWith('deep');
    expect(cb.insertCommand).toHaveBeenCalledWith('revisar');
    expect(cb.exportConversation).toHaveBeenCalledWith('s1', 'json');
    expect(cb.goTo).toHaveBeenCalledWith('settings');
  });
});

describe('palette ranking', () => {
  const actions = buildActions(state(), callbacks());
  it('shows recents first, then every group in order, with an empty query', () => {
    const sections = rankActions(actions, '', ['mode:deep', 'conversation:gone', 'conversation:s1']);
    expect(sections.map((s) => s.title)).toEqual(['Recentes', ...PALETTE_GROUPS]);
    expect(sections[0].items.map((a) => a.id)).toEqual(['mode:deep', 'conversation:s1']);
    // Recent items are not repeated in their own group.
    expect(sections.find((s) => s.title === 'Modo')!.items.map((a) => a.id)).not.toContain('mode:deep');
  });
  it('filters across groups, accent-insensitively, ordering groups by their best match', () => {
    const sections = rankActions(actions, 'migracao');
    expect(sections[0].title).toBe('Conversas');
    expect(sections[0].items[0].id).toBe('conversation:s2');
    expect(rankActions(actions, 'configuracoes')[0].items[0].id).toBe('action:settings');
    expect(rankActions(actions, 'completo')[0].items[0].id).toBe('mode:deep');
    expect(rankActions(actions, 'zzzz')).toEqual([]);
  });
  it('matches group names and keywords too, below direct label matches', () => {
    const modes = rankActions(actions, 'modo').flatMap((s) => s.items.map((a) => a.id));
    expect(modes).toEqual(expect.arrayContaining(['mode:fast', 'mode:auto', 'mode:deep']));
    expect(rankActions(actions, 'nova')[0].items[0].id).toBe('action:new');
  });
  it('ranks a recent selection above an equal match', () => {
    const plain = rankActions(actions, 'rel').flatMap((s) => s.items.map((a) => a.id));
    const boosted = rankActions(actions, 'rel', ['conversation:s1']).flatMap((s) => s.items.map((a) => a.id));
    expect(boosted[0]).toBe('conversation:s1');
    expect(plain).toContain('conversation:s1');
  });
});

describe('palette shortcut', () => {
  const key = (over: Partial<KeyboardEvent> = {}) =>
    ({ key: 'p', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...over }) as Pick<
      KeyboardEvent,
      'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing'
    >;
  it('recognises Ctrl+P and Cmd+P, but not Shift/Alt variants, plain P or IME composition', () => {
    expect(isPaletteKey(key())).toBe(true);
    expect(isPaletteKey(key({ ctrlKey: false, metaKey: true, key: 'P' }))).toBe(true);
    expect(isPaletteKey(key({ shiftKey: true }))).toBe(false);
    expect(isPaletteKey(key({ altKey: true }))).toBe(false);
    expect(isPaletteKey(key({ ctrlKey: false }))).toBe(false);
    expect(isPaletteKey(key({ isComposing: true }))).toBe(false);
  });
});
