import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { ProviderInfo } from '../shared/contracts';

type PopoverProps = { label: string; icon?: ReactNode; summary: string; title?: string; disabled?: boolean; focusFirst?: boolean; children: (close: (restoreFocus?: boolean) => void) => ReactNode };

function Popover({ label, icon, summary, title, disabled, focusFirst, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, left: 8, width: 344 });
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = true) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(0, Math.min(440, window.innerWidth - 16));
      const height = Math.min(360, Math.max(180, window.innerHeight - 16));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const above = rect.top - height - 8;
      const below = rect.bottom + 8;
      const top = above >= 8 ? above : Math.min(below, window.innerHeight - height - 8);
      setPosition({ left, top: Math.max(8, Math.min(top, window.innerHeight - height - 8)), width });
    };
    place();
    if (focusFirst) panel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, focusFirst]);
  return <>
    <button ref={trigger} type="button" className="composer-pill" aria-label={label} title={title} aria-haspopup="dialog" aria-controls={id} aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)}>{icon}<span>{summary}</span><ChevronDown size={13} /></button>
    {open && createPortal(<div id={id} ref={panel} role="dialog" aria-label={label} className="composer-popover" style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, maxHeight: Math.max(180, Math.min(360, window.innerHeight - 16)) }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || [])];
        const index = items.indexOf(document.activeElement as HTMLElement); if (!items.length) return;
        event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    }}>{children(close)}</div>, document.body)}
  </>;
}

export function ModelMenu({ providers, providerId, modelId, sessionId, disabled, onChange }: { providers: ProviderInfo[]; providerId: ProviderInfo['id']; modelId?: string; sessionId?: string; disabled?: boolean; onChange: (providerId: ProviderInfo['id'], modelId?: string) => void }) {
  const [filter, setFilter] = useState('');
  const [activeProvider, setActiveProvider] = useState(providerId);
  const currentProvider = providers.find((item) => item.id === providerId);
  const currentModel = currentProvider?.models.find((item) => item.id === modelId);
  useEffect(() => { setActiveProvider(providerId); setFilter(''); }, [sessionId, providerId]);
  const suffix = currentProvider && !currentProvider.available ? ' · Indisponível' : '';
  const summary = `${currentModel?.name || 'Modelo padrão'} · ${currentProvider?.name || providerId}${suffix}`;
  const provider = providers.find((item) => item.id === activeProvider);
  const results = (provider?.models || []).filter((item) => `${item.name} ${item.id} ${provider?.name}`.toLowerCase().includes(filter.toLowerCase()));
  return <Popover key={`${sessionId || ''}:${providerId}`} label="Escolher modelo e provedor" icon={<span className="provider-glyph">✦</span>} summary={summary} title={summary} disabled={disabled}>{(close) => <div className="model-menu">
    <div className="provider-rail" role="list" aria-label="Provedores">{providers.map((item) => <button key={item.id} type="button" aria-label={`${item.name}${item.available ? '' : ', indisponível'}`} aria-pressed={activeProvider === item.id} className={activeProvider === item.id ? 'active' : ''} onClick={() => { setActiveProvider(item.id); setFilter(''); }}>{item.name}{!item.available && <small>Indisponível</small>}</button>)}</div>
    <div className="model-browser"><label className="model-search"><Search size={14} /><input autoFocus aria-label="Buscar modelos" placeholder="Buscar modelos…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <div className="model-results" role="listbox" aria-label={`Modelos de ${provider?.name || 'provedor'}`}>
        {provider && <button type="button" disabled={!provider.available} role="option" aria-selected={providerId === provider.id && !modelId} className="model-option" onClick={() => { onChange(provider.id, undefined); close(); }}><span><strong>Modelo padrão</strong><small>{provider.defaultModel || 'Usa o padrão do provedor'}{!provider.available ? ' · Provedor indisponível' : ''}</small></span>{providerId === provider.id && !modelId && <Check size={15} />}</button>}
        {results.map((model) => <button type="button" disabled={!provider?.available} role="option" aria-selected={providerId === provider?.id && modelId === model.id} className="model-option" key={model.id} onClick={() => { onChange(provider!.id, model.id); close(); }}><span><strong>{model.name}</strong><small>{provider?.name} · {model.id}{!provider?.available ? ' · Provedor indisponível' : ''}</small></span>{providerId === provider?.id && modelId === model.id && <Check size={15} />}</button>)}
        {results.length === 0 && <p className="model-empty">{provider?.available ? 'Nenhum modelo corresponde à busca.' : 'Este provedor está indisponível neste computador.'}</p>}
      </div>
    </div>
  </div>}</Popover>;
}

export function ChoiceMenu({ label, icon, value, options, disabled, hint, onChange }: { label: string; icon: ReactNode; value: string; options: { value: string; label: string; detail?: string }[]; disabled?: boolean; hint?: ReactNode; onChange: (value: string) => void }) {
  const selected = options.find((item) => item.value === value);
  return <Popover label={label} icon={icon} summary={selected?.label || value} disabled={disabled} focusFirst>{(close) => <div className="choice-menu"><strong>{label}</strong>{options.map((item) => <button key={item.value} type="button" className="choice-option" aria-pressed={value === item.value} onClick={() => { onChange(item.value); close(); }}><span><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</span>{value === item.value && <Check size={15} />}</button>)}{hint && <div className="choice-hint">{hint}</div>}</div>}</Popover>;
}
