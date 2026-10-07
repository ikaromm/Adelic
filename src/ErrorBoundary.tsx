import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getLocale, t as translate, useI18n, type Locale, type MessageKey } from './i18n';

/** Scope names callers pass (pt-BR) and their catalog keys; an unknown scope is shown as given. */
const SCOPES: Record<string, MessageKey> = {
  'o Adelic': 'errorBoundary.scope.app',
  'a conversa': 'errorBoundary.scope.conversation',
  'o terminal': 'errorBoundary.scope.terminal',
  'o git': 'errorBoundary.scope.git',
  'a atividade': 'errorBoundary.scope.activity',
  'as automações': 'errorBoundary.scope.automations',
  'a memória': 'errorBoundary.scope.memory',
  'as configurações': 'errorBoundary.scope.settings',
};
/** The same scopes as App.tsx passes them, already translated (`t('app.scope.*')`) in either locale. */
const APP_SCOPES: Record<string, MessageKey> = {
  conversation: 'errorBoundary.scope.conversation',
  terminal: 'errorBoundary.scope.terminal',
  git: 'errorBoundary.scope.git',
  activity: 'errorBoundary.scope.activity',
  automations: 'errorBoundary.scope.automations',
  memory: 'errorBoundary.scope.memory',
  settings: 'errorBoundary.scope.settings',
};
/** What failed, in `locale` ("a memória" or "the memory" → the current language). */
export const errorScopeName = (scope: string, locale: Locale = getLocale()) => {
  if (Object.hasOwn(SCOPES, scope)) return translate(SCOPES[scope], undefined, locale);
  // App.tsx passes t('app.scope.<x>') in the language active when it rendered.
  for (const [name, key] of Object.entries(APP_SCOPES))
    for (const lang of ['pt-BR', 'en'] as const)
      if (translate(`app.scope.${name}` as MessageKey, undefined, lang) === scope)
        return translate(key, undefined, locale);
  return scope;
};

function Fallback({
  scope,
  error,
  fullScreen,
  onRetry,
}: {
  scope: string;
  error: Error;
  fullScreen?: boolean;
  onRetry: () => void;
}) {
  const { t, locale } = useI18n();
  const name = errorScopeName(scope, locale);
  return (
    <div className={fullScreen ? 'error-boundary error-boundary-full' : 'error-boundary'} role="alert">
      <h2>{t('errorBoundary.title', { scope: name })}</h2>
      <p>{t('errorBoundary.body')}</p>
      <pre>{error.message || String(error)}</pre>
      <div className="error-boundary-actions">
        <button type="button" className="primary-button" onClick={onRetry}>
          {t('errorBoundary.retry')}
        </button>
        <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
          {t('errorBoundary.reload')}
        </button>
      </div>
    </div>
  );
}

/**
 * Catches render errors so one broken screen does not blank the whole app.
 * `scope` names what failed in the fallback; `resetKey` clears the error when the
 * user navigates elsewhere (e.g. the current page), so recovery needs no reload.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; scope: string; resetKey?: unknown; fullScreen?: boolean },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console for diagnosis; no data leaves the machine.
    console.error(`[Adelic] Falha ao exibir ${this.props.scope}:`, error, info.componentStack);
  }

  componentDidUpdate(previous: { resetKey?: unknown }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Fallback
        scope={this.props.scope}
        error={error}
        fullScreen={this.props.fullScreen}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}
