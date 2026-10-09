import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  Folder,
  Heart,
  Layers3,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { Mode, Project, ProviderInfo } from '../shared/contracts';
import { t as translate, useI18n } from './i18n';

type Placement = { top: number; left: number; width: number; maxHeight: number; side: 'top' | 'bottom' };
export type PopoverProps = {
  label: string;
  icon?: ReactNode;
  summary: string;
  /** Optional short visual label; the trigger keeps the full summary in its accessible name. */
  compactSummary?: string;
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

export function Popover({
  label,
  icon,
  summary,
  compactSummary,
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
        <span className="composer-pill-label">{compactSummary || summary}</span>
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
  compactSummary,
  onChange,
}: {
  providers: ProviderInfo[];
  providerId: ProviderInfo['id'];
  modelId?: string;
  sessionId?: string;
  disabled?: boolean;
  compactSummary?: string;
  onChange: (providerId: ProviderInfo['id'], modelId?: string) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const [activeProvider, setActiveProvider] = useState(providerId);
  const [favorites, setFavorites] = useState<string[]>(readFavoriteModels);
  const currentProvider = providers.find((item) => item.id === providerId);
  const currentModel = currentProvider?.models.find((item) => item.id === modelId);
  useEffect(() => {
    setActiveProvider(providerId);
    setFilter('');
  }, [sessionId, providerId]);
  useEffect(() => {
    try {
      window.localStorage.setItem(MODEL_FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
      // A storage restriction must not make model selection unusable.
    }
  }, [favorites]);
  const suffix =
    currentProvider && !currentProvider.available
      ? currentProvider.status === 'unknown'
        ? ` · ${t('modelPicker.provider.unknown')}`
        : t('composer.model.unavailableSuffix')
      : '';
  const summary = `${currentModel?.name || t('composer.model.default')} · ${currentProvider?.name || providerId}${suffix}`;
  const provider = providers.find((item) => item.id === activeProvider);
  const normalizedFilter = normalizeModelSearch(filter);
  const matches = providers.flatMap((item) =>
    item.models
      .filter((model) =>
        normalizeModelSearch(`${model.name} ${model.id} ${item.name} ${item.id}`).includes(normalizedFilter),
      )
      .map((model) => ({ provider: item, model })),
  );
  const results = normalizedFilter
    ? matches
    : (provider?.models || []).map((model) => ({ provider: provider!, model }));
  const defaultProviders = normalizedFilter
    ? providers.filter((item) => normalizeModelSearch(`${item.name} ${item.id}`).includes(normalizedFilter))
    : provider
      ? [provider]
      : [];
  const visibleProviders = providers.filter((item) =>
    normalizeModelSearch(`${item.name} ${item.id}`).includes(normalizedFilter),
  );
  const favoriteKey = (item: ProviderInfo, id: string) => `${item.id}:${id}`;
  const toggleFavorite = (item: ProviderInfo, id: string) => {
    const key = favoriteKey(item, id);
    setFavorites((current) => (current.includes(key) ? current.filter((value) => value !== key) : [...current, key]));
  };
  const renderModel = (
    item: { provider: ProviderInfo; model: ProviderInfo['models'][number] },
    closePopover: (restoreFocus?: boolean) => void,
    prefix = '',
  ) => {
    const selected = providerId === item.provider.id && modelId === item.model.id;
    const favorite = favorites.includes(favoriteKey(item.provider, item.model.id));
    return (
      <div className="model-choice-row" key={`${prefix}${favoriteKey(item.provider, item.model.id)}`}>
        <button
          type="button"
          disabled={!item.provider.available}
          className="model-option"
          aria-label={`${item.model.name} · ${item.provider.name} · ${item.model.id}${
            !item.provider.available
              ? ` · ${item.provider.status === 'unknown' ? t('modelPicker.provider.unknown') : t('composer.model.unavailable')}`
              : ''
          }`}
          aria-pressed={selected}
          onClick={() => {
            onChange(item.provider.id, item.model.id);
            closePopover();
          }}
        >
          <span>
            <strong>{item.model.name}</strong>
            <small>
              {item.provider.name} · {item.model.id}
              {!item.provider.available
                ? item.provider.status === 'unknown'
                  ? t('modelPicker.provider.unknown')
                  : t('composer.model.providerUnavailableSuffix')
                : ''}
            </small>
            <small className="model-capabilities">
              {t('modelPicker.providerCapabilities')}: {t('modelPicker.capability.tools')}:{' '}
              {item.provider.capabilities.tools ? t('modelPicker.value.supported') : t('modelPicker.value.unsupported')}
              {' · '}
              {t('modelPicker.capability.images')}:{' '}
              {typeof item.provider.capabilities.images === 'boolean'
                ? item.provider.capabilities.images
                  ? t('modelPicker.value.supported')
                  : t('modelPicker.value.unsupported')
                : t('modelPicker.value.unknown')}
              {' · '}
              {t('modelPicker.capability.reasoning')}:{' '}
              {typeof item.provider.capabilities.reasoning === 'boolean'
                ? item.provider.capabilities.reasoning
                  ? t('modelPicker.value.supported')
                  : t('modelPicker.value.unsupported')
                : t('modelPicker.value.unknown')}
            </small>
          </span>
          {selected && <Check size={15} />}
        </button>
        <button
          type="button"
          className={`model-favorite ${favorite ? 'active' : ''}`}
          aria-label={t(favorite ? 'modelPicker.removeFavorite' : 'modelPicker.addFavorite', {
            model: item.model.id,
            provider: item.provider.name,
          })}
          aria-pressed={favorite}
          onClick={() => toggleFavorite(item.provider, item.model.id)}
        >
          <Heart size={15} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      </div>
    );
  };
  const favoriteModels = providers.flatMap((item) =>
    item.models
      .filter((model) => favorites.includes(favoriteKey(item, model.id)))
      .filter(
        (model) =>
          !normalizedFilter ||
          normalizeModelSearch(`${model.name} ${model.id} ${item.name} ${item.id}`).includes(normalizedFilter),
      )
      .map((model) => ({ provider: item, model })),
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
      compactSummary={compactSummary}
      title={summary}
      disabled={disabled}
      width={520}
    >
      {(closePopover) => (
        <div className="model-menu">
          <div className="provider-rail" role="list" aria-label={t('composer.model.providers')}>
            {visibleProviders.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={
                  item.status === 'unknown'
                    ? t('modelPicker.provider.unknownAria', { name: item.name })
                    : item.available
                      ? item.name
                      : t('composer.model.providerUnavailableAria', { name: item.name })
                }
                aria-pressed={activeProvider === item.id}
                className={activeProvider === item.id ? 'active' : ''}
                onClick={() => setActiveProvider(item.id)}
              >
                <span>{item.name}</span>
                {!item.available && (
                  <small>
                    {item.status === 'unknown' ? t('modelPicker.provider.unknown') : t('composer.model.unavailable')}
                  </small>
                )}
              </button>
            ))}
            {visibleProviders.length === 0 && <p className="model-empty">{t('modelPicker.noProviders')}</p>}
          </div>
          <div className="model-browser">
            <label className="model-search">
              <Search size={14} aria-hidden="true" />
              <input
                autoFocus
                aria-label={t('composer.model.search')}
                placeholder={t('composer.model.searchPlaceholder')}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <div className="model-results" role="region" aria-label={t('modelPicker.results')}>
              {favoriteModels.length > 0 && (
                <section className="model-favorites" aria-label={t('modelPicker.favorites')}>
                  <strong>{t('modelPicker.favorites')}</strong>
                  {favoriteModels.map((item) => renderModel(item, closePopover, 'favorite:'))}
                </section>
              )}
              {defaultProviders.map((item) => (
                <button
                  key={`default:${item.id}`}
                  type="button"
                  disabled={!item.available}
                  aria-pressed={providerId === item.id && !modelId}
                  className="model-option model-default-option"
                  onClick={() => {
                    onChange(item.id, undefined);
                    closePopover();
                  }}
                >
                  <span>
                    <strong>{t('composer.model.default')}</strong>
                    <small>
                      {item.defaultModel || t('composer.model.providerDefault')} · {item.name}
                      {!item.available
                        ? item.status === 'unknown'
                          ? ` · ${t('modelPicker.provider.unknown')}`
                          : t('composer.model.providerUnavailableSuffix')
                        : ''}
                    </small>
                  </span>
                  {providerId === item.id && !modelId && <Check size={15} />}
                </button>
              ))}
              {results
                .filter((item) => !favorites.includes(favoriteKey(item.provider, item.model.id)))
                .map((item) => renderModel(item, closePopover))}
              {results.length === 0 && defaultProviders.length === 0 && favoriteModels.length === 0 && (
                <p className="model-empty">{t('composer.model.noMatch')}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
}

const MODEL_FAVORITES_KEY = 'adelic.model-picker.favorites.v1';
function readFavoriteModels(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const value: unknown = JSON.parse(window.localStorage.getItem(MODEL_FAVORITES_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeModelSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
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
  compactSummary,
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
  compactSummary?: string;
  onChange: (value: string) => void;
}) {
  const selected = options.find((item) => item.value === value);
  return (
    <Popover
      label={label}
      icon={icon}
      summary={selected?.label || value}
      compactSummary={compactSummary}
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
