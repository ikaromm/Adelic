import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Folder, Layers3, Search, Settings as SettingsIcon, Sparkles, Zap } from 'lucide-react';
import type { Mode, Project, ProviderInfo } from '../shared/contracts';
import { t as translate, useI18n } from './i18n';

type Placement = { top: number; left: number; width: number; maxHeight: number; side: 'top' | 'bottom' };
type PopoverProps = {
  label: string;
  icon?: ReactNode;
  summary: string;
  title?: string;
  disabled?: boolean;
  focusFirst?: boolean;
  /** Preferred panel width in px; clamped to the viewport. */
  width?: number;
  className?: string;
  children: (close: (restoreFocus?: boolean) => void) => ReactNode;
};
const MARGIN = 8;
const GAP = 6;
const MAX_HEIGHT = 440;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

function Popover({
  label,
  icon,
  summary,
  title,
  disabled,
  focusFirst,
  width = 320,
  className = '',
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = true) => {
    setOpen(false);
    setPlacement(null);
    if (restoreFocus) trigger.current?.focus();
  };

  // Measure the rendered menu before paint so short menus stay attached to their trigger.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const node = panel.current;
      if (!rect || !node) return;
      const content = node.firstElementChild as HTMLElement | null;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const panelWidth = Math.max(0, Math.min(width, viewportWidth - MARGIN * 2));
      const left = Math.max(MARGIN, Math.min(rect.left, viewportWidth - panelWidth - MARGIN));
      // Content is capped by --popover-max-height; lift the cap while measuring so the menu can grow again.
      const previousCap = node.style.getPropertyValue('--popover-max-height');
      node.style.setProperty('--popover-max-height', `${MAX_HEIGHT}px`);
      const natural = Math.min(MAX_HEIGHT, (content?.scrollHeight ?? node.scrollHeight) + 2);
      node.style.setProperty('--popover-max-height', previousCap);
      const above = rect.top - GAP - MARGIN;
      const below = viewportHeight - rect.bottom - GAP - MARGIN;
      const side = above >= natural || above >= below ? 'top' : 'bottom';
      const maxHeight = Math.max(120, Math.min(MAX_HEIGHT, side === 'top' ? above : below));
      const height = Math.min(natural, maxHeight);
      const rawTop = side === 'top' ? rect.top - GAP - height : rect.bottom + GAP;
      const top = Math.max(MARGIN, Math.min(rawTop, viewportHeight - height - MARGIN));
      setPlacement((current) =>
        current &&
        current.top === top &&
        current.left === left &&
        current.width === panelWidth &&
        current.maxHeight === maxHeight &&
        current.side === side
          ? current
          : { top, left, width: panelWidth, maxHeight, side },
      );
    };
    place();
    if (focusFirst && !panel.current?.contains(document.activeElement)) {
      const selected = panel.current?.querySelector<HTMLElement>(
        '[aria-pressed="true"]:not(:disabled), [aria-selected="true"]:not(:disabled)',
      );
      (selected || panel.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true });
    }
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, width, focusFirst]);

  // The final max-height is only known after placement; keep the focused option visible inside the menu.
  useLayoutEffect(() => {
    if (!open || !placement) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== panel.current && panel.current?.contains(active))
      active.scrollIntoView({ block: 'nearest' });
  }, [open, placement]);

  const initialWidth = Math.max(
    0,
    Math.min(width, (typeof window === 'undefined' ? width : window.innerWidth) - MARGIN * 2),
  );
  const style: CSSProperties & Record<'--popover-max-height', string> = placement
    ? {
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
        '--popover-max-height': `${placement.maxHeight}px`,
      }
    : {
        position: 'fixed',
        top: 0,
        left: 0,
        width: initialWidth,
        maxHeight: MAX_HEIGHT,
        opacity: 0,
        '--popover-max-height': `${MAX_HEIGHT}px`,
      };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`composer-pill ${className}`.trim()}
        aria-label={`${label}: ${summary}`}
        title={title || label}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {icon}
        <span className="composer-pill-label">{summary}</span>
        <ChevronDown className="composer-pill-chevron" size={14} />
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={panel}
            role="dialog"
            aria-label={label}
            className="composer-popover"
            data-side={placement?.side || 'top'}
            style={style}
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && !panel.current?.contains(next) && !trigger.current?.contains(next)) close(false);
            }}
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              // Home/End keep moving the caret inside text fields such as "Buscar modelos".
              const target = event.target;
              if (
                (event.key === 'Home' || event.key === 'End') &&
                (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
              )
                return;
              const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) || [])];
              if (!items.length) return;
              event.preventDefault();
              const index = items.indexOf(document.activeElement as HTMLElement);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
              items[next]?.focus();
            }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

export function ModelMenu({
  providers,
  providerId,
  modelId,
  sessionId,
  disabled,
  onChange,
}: {
  providers: ProviderInfo[];
  providerId: ProviderInfo['id'];
  modelId?: string;
  sessionId?: string;
  disabled?: boolean;
  onChange: (providerId: ProviderInfo['id'], modelId?: string) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const [activeProvider, setActiveProvider] = useState(providerId);
  const currentProvider = providers.find((item) => item.id === providerId);
  const currentModel = currentProvider?.models.find((item) => item.id === modelId);
  useEffect(() => {
    setActiveProvider(providerId);
    setFilter('');
  }, [sessionId, providerId]);
  const suffix = currentProvider && !currentProvider.available ? t('composer.model.unavailableSuffix') : '';
  const summary = `${currentModel?.name || t('composer.model.default')} · ${currentProvider?.name || providerId}${suffix}`;
  const provider = providers.find((item) => item.id === activeProvider);
  const results = (provider?.models || []).filter((item) =>
    `${item.name} ${item.id} ${provider?.name}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Popover
      key={`${sessionId || ''}:${providerId}`}
      className="model-pill"
      label={t('composer.model.label')}
      icon={
        <span className="provider-glyph" aria-hidden="true">
          ✦
        </span>
      }
      summary={summary}
      title={summary}
      disabled={disabled}
      width={480}
    >
      {(close) => (
        <div className="model-menu">
          <div className="provider-rail" role="list" aria-label={t('composer.model.providers')}>
            {providers.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={
                  item.available ? item.name : t('composer.model.providerUnavailableAria', { name: item.name })
                }
                aria-pressed={activeProvider === item.id}
                className={activeProvider === item.id ? 'active' : ''}
                onClick={() => {
                  setActiveProvider(item.id);
                  setFilter('');
                }}
              >
                <span>{item.name}</span>
                {!item.available && <small>{t('composer.model.unavailable')}</small>}
              </button>
            ))}
          </div>
          <div className="model-browser">
            <label className="model-search">
              <Search size={14} />
              <input
                autoFocus
                aria-label={t('composer.model.search')}
                placeholder={t('composer.model.searchPlaceholder')}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <div
              className="model-results"
              role="listbox"
              aria-label={t('composer.model.listOf', {
                provider: provider?.name || t('composer.model.providerFallback'),
              })}
            >
              {provider && (
                <button
                  type="button"
                  disabled={!provider.available}
                  role="option"
                  aria-selected={providerId === provider.id && !modelId}
                  className="model-option"
                  onClick={() => {
                    onChange(provider.id, undefined);
                    close();
                  }}
                >
                  <span>
                    <strong>{t('composer.model.default')}</strong>
                    <small>
                      {provider.defaultModel || t('composer.model.providerDefault')}
                      {!provider.available ? t('composer.model.providerUnavailableSuffix') : ''}
                    </small>
                  </span>
                  {providerId === provider.id && !modelId && <Check size={15} />}
                </button>
              )}
              {results.map((model) => (
                <button
                  type="button"
                  disabled={!provider?.available}
                  role="option"
                  aria-selected={providerId === provider?.id && modelId === model.id}
                  className="model-option"
                  key={model.id}
                  onClick={() => {
                    onChange(provider!.id, model.id);
                    close();
                  }}
                >
                  <span>
                    <strong>{model.name}</strong>
                    <small>
                      {provider?.name} · {model.id}
                      {!provider?.available ? t('composer.model.providerUnavailableSuffix') : ''}
                    </small>
                  </span>
                  {providerId === provider?.id && modelId === model.id && <Check size={15} />}
                </button>
              ))}
              {results.length === 0 && (
                <p className="model-empty">
                  {provider?.available ? t('composer.model.noMatch') : t('composer.model.providerMissing')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function ChoiceMenu({
  label,
  icon,
  value,
  options,
  disabled,
  hint,
  title,
  width = 300,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  /** A disabled option stays visible with its detail explaining why it cannot be picked. */
  options: { value: string; label: string; detail?: string; disabled?: boolean }[];
  disabled?: boolean;
  hint?: ReactNode;
  /** Tooltip of the pill (defaults to the label). */
  title?: string;
  width?: number;
  onChange: (value: string) => void;
}) {
  const selected = options.find((item) => item.value === value);
  return (
    <Popover
      label={label}
      icon={icon}
      summary={selected?.label || value}
      title={title}
      disabled={disabled}
      focusFirst
      width={width}
    >
      {(close) => (
        <div className="choice-menu">
          <strong className="choice-menu-title">{label}</strong>
          {options.map((item) => (
            <button
              key={item.value}
              type="button"
              className="choice-option"
              aria-pressed={value === item.value}
              disabled={item.disabled}
              onClick={() => {
                onChange(item.value);
                close();
              }}
            >
              <span>
                <b>{item.label}</b>
                {item.detail && <small>{item.detail}</small>}
              </span>
              {value === item.value && <Check size={15} />}
            </button>
          ))}
          {hint && <div className="choice-hint">{hint}</div>}
        </div>
      )}
    </Popover>
  );
}

/** "Auto", "Rápido", "Completo" in the current locale. */
export const modeLabel = (mode: Mode) => translate(`mode.${mode}`);
const MODE_OPTIONS: { value: Mode; icon: ReactNode }[] = [
  { value: 'auto', icon: <Sparkles size={14} /> },
  { value: 'fast', icon: <Zap size={14} /> },
  { value: 'deep', icon: <Layers3 size={14} /> },
];

/** Project link and execution mode of the conversation, grouped in one composer menu. */
export function ConversationMenu({
  projects,
  projectId,
  mode,
  disabled,
  context,
  memoryScope,
  onProject,
  onMode,
  onConfigure,
}: {
  projects: Project[];
  projectId: string | null;
  mode: Mode;
  disabled?: boolean;
  context: string;
  /** Memory scope searched by this detached conversation (Settings › Memória), shown in the tooltip. */
  memoryScope?: string;
  onProject: (projectId: string | null) => void;
  onMode: (mode: Mode) => void;
  onConfigure?: () => void;
}) {
  const { t } = useI18n();
  const project = projects.find((item) => item.id === projectId);
  const projectName = project?.name || t('composer.conversation.noProject');
  const summary = `${projectName} · ${t(`mode.${mode}`)}`;
  const modeDetail = t(`mode.${mode}.detail`);
  return (
    <Popover
      className="context-pill"
      label={t('composer.conversation.label')}
      icon={<Folder size={14} />}
      summary={summary}
      title={
        memoryScope
          ? t('memorySettings.composer.title', { project: projectName, mode: t(`mode.${mode}`), scope: memoryScope })
          : t('composer.conversation.title', { project: projectName, mode: t(`mode.${mode}`) })
      }
      disabled={disabled}
      focusFirst
      width={340}
    >
      {(close) => (
        <div className="choice-menu conversation-menu">
          <strong className="choice-menu-title" id="conversation-menu-project">
            {t('composer.conversation.project')}
          </strong>
          <div className="choice-group" role="group" aria-labelledby="conversation-menu-project">
            <button
              type="button"
              className="choice-option"
              aria-pressed={!projectId}
              onClick={() => {
                onProject(null);
                close();
              }}
            >
              <span>
                <b>{t('composer.conversation.noProject')}</b>
                <small>{t('composer.conversation.noProjectDetail')}</small>
              </span>
              {!projectId && <Check size={15} />}
            </button>
            {projects.map((item) => (
              <button
                key={item.id}
                type="button"
                className="choice-option"
                aria-pressed={item.id === projectId}
                title={item.path}
                onClick={() => {
                  onProject(item.id);
                  close();
                }}
              >
                <span>
                  <b>{item.name}</b>
                  <small className="choice-path">{item.path}</small>
                </span>
                {item.id === projectId && <Check size={15} />}
              </button>
            ))}
          </div>
          <strong className="choice-menu-title" id="conversation-menu-mode">
            {t('composer.conversation.mode')}
          </strong>
          <div className="mode-switch" role="group" aria-labelledby="conversation-menu-mode">
            {MODE_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={mode === item.value ? 'selected' : ''}
                aria-pressed={mode === item.value}
                onClick={() => {
                  onMode(item.value);
                  close();
                }}
              >
                {item.icon}
                {t(`mode.${item.value}`)}
              </button>
            ))}
          </div>
          {modeDetail && <p className="mode-detail">{modeDetail}</p>}
          <div className="choice-hint conversation-context">
            <span
              className={`coordination-dot ${project && project.orchestration?.enabled === false ? 'muted' : ''} ${project ? '' : 'detached'}`.trim()}
              aria-hidden="true"
            />
            <span>{context}</span>
            {project && onConfigure && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  close(false);
                  onConfigure();
                }}
              >
                <SettingsIcon size={13} />
                {t('composer.conversation.configure')}
              </button>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
