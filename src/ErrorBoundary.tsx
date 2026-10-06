import { Component, type ErrorInfo, type ReactNode } from 'react';

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
      <div className={this.props.fullScreen ? 'error-boundary error-boundary-full' : 'error-boundary'} role="alert">
        <h2>Não foi possível exibir {this.props.scope}</h2>
        <p>
          Seus dados continuam salvos. Tente de novo; se o erro persistir, recarregue a janela e informe a mensagem
          abaixo.
        </p>
        <pre>{error.message || String(error)}</pre>
        <div className="error-boundary-actions">
          <button type="button" className="primary-button" onClick={() => this.setState({ error: null })}>
            Tentar de novo
          </button>
          <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
            Recarregar
          </button>
        </div>
      </div>
    );
  }
}
