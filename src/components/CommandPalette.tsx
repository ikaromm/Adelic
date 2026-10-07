import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  Brain,
  CalendarClock,
  Check,
  Command,
  Download,
  Folder,
  Gauge,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { rankActions, type PaletteAction, type PaletteIcon } from '../palette/actions';

const ICONS: Record<PaletteIcon, ReactNode> = {
  new: <Plus size={15} />,
  search: <Search size={15} />,
  settings: <SettingsIcon size={15} />,
  activity: <Activity size={15} />,
  automations: <CalendarClock size={15} />,
  memory: <Brain size={15} />,
  sidebar: <PanelLeft size={15} />,
  export: <Download size={15} />,
  conversation: <MessageSquare size={15} />,
  project: <Folder size={15} />,
  agent: <Bot size={15} />,
  mode: <Gauge size={15} />,
  command: <Command size={15} />,
};
const PAGE_STEP = 8;

/**
 * Command palette dialog (docs/specs/command-palette.md). Focus stays in the text field,
 * a combobox controlling a grouped listbox through aria-activedescendant.
 */
export function CommandPalette({
  actions,
  recents,
  onRun,
  onClose,
}: {
  actions: PaletteAction[];
  recents: string[];
  onRun: (action: PaletteAction) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => rankActions(actions, query, recents), [actions, query, recents]);
  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections]);
  // The active row survives re-ranking while it is still listed; otherwise the first enabled one.
  const activeIndex = useMemo(() => {
    const kept = activeId ? flat.findIndex((a) => a.id === activeId) : -1;
    if (kept !== -1) return kept;
    const enabled = flat.findIndex((a) => !a.disabled);
    return enabled === -1 ? (flat.length ? 0 : -1) : enabled;
  }, [flat, activeId]);
  const active = activeIndex === -1 ? undefined : flat[activeIndex];
  const optionId = (action: PaletteAction) => `${baseId}-option-${flat.indexOf(action)}`;

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActiveId(null), [query]);
  useEffect(() => {
    if (!active) return;
    const element = list.current?.querySelector<HTMLElement>(`[data-action-id="${CSS.escape(active.id)}"]`);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const move = (index: number) => {
    if (!flat.length) return;
    setActiveId(flat[Math.max(0, Math.min(flat.length - 1, index))].id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const last = flat.length - 1;
    switch (event.key) {
      case 'ArrowDown':
        move(activeIndex >= last ? 0 : activeIndex + 1);
        break;
      case 'ArrowUp':
        move(activeIndex <= 0 ? last : activeIndex - 1);
        break;
      case 'PageDown':
        move(activeIndex + PAGE_STEP);
        break;
      case 'PageUp':
        move(activeIndex - PAGE_STEP);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(last);
        break;
      case 'Enter':
        if (active && !active.disabled) onRun(active);
        break;
      case 'Tab':
        // Only the field takes focus inside the modal dialog.
        break;
      case 'Escape':
        // Keep Escape from also reaching the window-level dismiss handler.
        event.nativeEvent.stopImmediatePropagation();
        onClose();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card palette-card" role="dialog" aria-modal="true" aria-label="Paleta de comandos">
        <label className="search-field palette-field">
          <Command size={15} aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-label="Buscar ações"
            aria-expanded={flat.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            placeholder="Ação, conversa, projeto ou comando…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div ref={list} id={listboxId} className="palette-list" role="listbox" aria-label="Ações">
          {sections.map((section, sectionIndex) => {
            const headingId = `${baseId}-group-${sectionIndex}`;
            return (
              <div key={section.title} role="group" aria-labelledby={headingId} className="palette-group">
                <div id={headingId} role="presentation" className="palette-group-title">
                  {section.title}
                </div>
                {section.items.map((action) => {
                  const selected = action === active;
                  const detail = action.disabled ? action.disabledReason : action.detail;
                  return (
                    <div
                      key={action.id}
                      id={optionId(action)}
                      data-action-id={action.id}
                      role="option"
                      aria-selected={selected}
                      aria-disabled={action.disabled || undefined}
                      aria-keyshortcuts={action.ariaShortcut}
                      className={`palette-option${selected ? ' active' : ''}${action.disabled ? ' disabled' : ''}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => !selected && setActiveId(action.id)}
                      onClick={() => !action.disabled && onRun(action)}
                    >
                      <span className="palette-option-icon" aria-hidden="true">
                        {ICONS[action.icon]}
                      </span>
                      <span className="palette-option-text">
                        <span className="palette-option-label">{action.label}</span>
                        {detail && <span className="palette-option-detail">{detail}</span>}
                      </span>
                      {action.current && (
                        <span className="palette-option-current">
                          <Check size={14} aria-hidden="true" />
                          <span className="visually-hidden">atual</span>
                        </span>
                      )}
                      {action.shortcut && (
                        <span className="palette-option-keys" aria-hidden="true">
                          {action.shortcut.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {flat.length === 0 && <p className="muted-empty palette-empty">Nada encontrado para “{query.trim()}”.</p>}
        </div>
        <p className="palette-hint" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navegar
          </span>
          <span>
            <kbd>Enter</kbd> executar
          </span>
          <span>
            <kbd>Esc</kbd> fechar
          </span>
        </p>
      </div>
    </div>
  );
}
