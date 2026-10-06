import { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

type HastNode = { type?: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

function hastText(node?: HastNode): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  return (node.children || []).map(hastText).join('');
}

function codeLanguage(node?: HastNode): string {
  const code = node?.children?.find((child) => child.tagName === 'code');
  const className = code?.properties?.className;
  const classes = Array.isArray(className) ? className.map(String) : typeof className === 'string' ? className.split(/\s+/) : [];
  const language = classes.find((item) => item.startsWith('language-'));
  return language ? language.slice('language-'.length) : '';
}

/** Copies text; falls back to a temporary textarea where the Clipboard API is denied (the desktop shell denies permissions). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Fall back to execCommand below. */ }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  Object.assign(area.style, { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    active?.focus({ preventScroll: true });
  }
}

export function CopyButton({ text, label = 'Copiar', className = '' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1800);
  };
  const status = state === 'copied' ? 'Copiado' : state === 'failed' ? 'Não foi possível copiar' : '';
  return <>
    <button type="button" className={`copy-button ${state === 'idle' ? '' : state} ${className}`.trim()} aria-label={label} title={status || label} onClick={() => void copy()}>
      {state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
    </button>
    <span className="visually-hidden" role="status" aria-live="polite">{status}</span>
  </>;
}

const components: Components = {
  a({ node: _node, href, children, ...props }) {
    if (href && /^(https?:|mailto:)/i.test(href)) return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    if (href?.startsWith('#')) return <a {...props} href={href}>{children}</a>;
    // Relative and file links would navigate away from the app; keep the target visible instead.
    return <span className="local-link" title={href}>{children}</span>;
  },
  pre({ node, children }) {
    const hast = node as unknown as HastNode | undefined;
    const language = codeLanguage(hast);
    // mdast-util-to-hast appends one "\n" to every fenced block; removing it copies exactly what was authored.
    const text = hastText(hast).replace(/\n$/, '');
    return <div className="code-block">
      <div className="code-block-header"><span>{language || 'texto'}</span><CopyButton text={text} label="Copiar código" /></div>
      <pre>{children}</pre>
    </div>;
  },
};

const rehypeOptions = { footnoteLabel: 'Notas', footnoteBackLabel: 'Voltar ao texto' };

export function Markdown({ children, className = 'markdown-content' }: { children: string; className?: string }) {
  return <div className={className}><ReactMarkdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={rehypeOptions} components={components}>{children}</ReactMarkdown></div>;
}
