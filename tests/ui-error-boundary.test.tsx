import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ErrorBoundary } from '../src/ErrorBoundary';

function Broken(): never {
  throw new Error('falha sintética de renderização');
}

describe('ErrorBoundary', () => {
  it('renders children when nothing fails', () => {
    expect(
      renderToString(
        <ErrorBoundary scope="a conversa">
          <p>ok</p>
        </ErrorBoundary>,
      ),
    ).toContain('<p>ok</p>');
  });
  it('shows the scope, the error and recovery actions instead of a blank screen', () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error('falha sintética de renderização'));
    const boundary = new ErrorBoundary({ scope: 'a conversa', children: <Broken /> });
    boundary.state = state;
    const html = renderToString(<>{boundary.render()}</>);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Não foi possível exibir <!-- -->a conversa');
    expect(html).toContain('falha sintética de renderização');
    expect(html).toContain('Tentar de novo');
    expect(html).toContain('Recarregar');
  });
  it('clears the error when resetKey changes, so navigation recovers without reload', () => {
    const boundary = new ErrorBoundary({ scope: 'a memória', resetKey: 'memory', children: <p>ok</p> });
    boundary.state = { error: new Error('x') };
    const setState = vi.fn();
    boundary.setState = setState as never;
    boundary.componentDidUpdate({ resetKey: 'memory' });
    expect(setState).not.toHaveBeenCalled();
    (boundary as { props: unknown }).props = { scope: 'a memória', resetKey: 'settings', children: <p>ok</p> };
    boundary.componentDidUpdate({ resetKey: 'memory' });
    expect(setState).toHaveBeenCalledWith({ error: null });
  });
});
