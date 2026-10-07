import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ExternalLink, Monitor, Play, RotateCw, Square, SquareTerminal, X } from 'lucide-react';
import {
  TERMINAL_TIMEOUT_DEFAULT_SEC,
  detectDevServerUrls,
  outputText,
  validatePreviewUrl,
  type TerminalCommand,
} from '../../shared/terminal';
import { useI18n, type I18n } from '../i18n';
import { useStickToBottom } from '../hooks/useStickToBottom';
import { useTerminal } from '../hooks/useTerminal';
import { loadHistory, recordHistory } from '../terminal-history';

export type ToolsTab = 'terminal' | 'preview';

const TIMEOUTS = [1, 5, 10, 30, 60];

const statusLabel = (command: TerminalCommand, t: I18n['t']) => {
  switch (command.status) {
    case 'running':
      return t('tools.status.running');
    case 'exited':
      return t('tools.status.exited', { code: command.exitCode ?? '?' });
    case 'stopped':
      return t('tools.status.stopped');
    case 'timeout':
      return t('tools.status.timeout');
    default:
      return t('tools.status.failed');
  }
};
const statusClass = (command: TerminalCommand) =>
  command.status === 'running'
    ? 'running'
    : command.status === 'exited' && command.exitCode === 0
      ? 'ok'
      : command.status === 'stopped'
        ? 'warning'
        : 'error';

/** Terminal and local preview of one project (docs/specs/terminal-preview.md). */
export function ToolsPanel({
  projectId,
  projectName,
  tab,
  onTab,
  onClose,
}: {
  projectId: string;
  projectName: string;
  tab: ToolsTab;
  onTab: (tab: ToolsTab) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const terminal = useTerminal(projectId, true);
  const [preview, setPreview] = useState('');
  return (
    <aside className="tools-panel" aria-label={t('tools.label', { project: projectName })}>
      <div className="tools-panel-header">
        <div className="tools-tabs" role="tablist" aria-label={t('tools.tabs')}>
          <button
            type="button"
            role="tab"
            id="tools-tab-terminal"
            aria-controls="tools-terminal"
            aria-selected={tab === 'terminal'}
            className={tab === 'terminal' ? 'active' : ''}
            onClick={() => onTab('terminal')}
          >
            <SquareTerminal size={14} /> {t('tools.tab.terminal')}
          </button>
          <button
            type="button"
            role="tab"
            id="tools-tab-preview"
            aria-controls="tools-preview"
            aria-selected={tab === 'preview'}
            className={tab === 'preview' ? 'active' : ''}
            onClick={() => onTab('preview')}
          >
            <Monitor size={14} /> {t('tools.tab.preview')}
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('tools.closeLabel')}
          title={t('tools.close')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div
        role="tabpanel"
        id="tools-terminal"
        aria-labelledby="tools-tab-terminal"
        className="tools-tabpanel"
        hidden={tab !== 'terminal'}
      >
        <TerminalTab
          projectId={projectId}
          terminal={terminal}
          onPreview={(url) => {
            setPreview(url);
            onTab('preview');
          }}
        />
      </div>
      <div
        role="tabpanel"
        id="tools-preview"
        aria-labelledby="tools-tab-preview"
        className="tools-tabpanel"
        hidden={tab !== 'preview'}
      >
        <PreviewTab url={preview} onUrl={setPreview} remote={terminal.state?.remote === true} />
      </div>
    </aside>
  );
}

function TerminalTab({
  projectId,
  terminal,
  onPreview,
}: {
  projectId: string;
  terminal: ReturnType<typeof useTerminal>;
  onPreview: (url: string) => void;
}) {
  const { t, tRich } = useI18n();
  const { state, commands, error, run, stop } = terminal;
  const [command, setCommand] = useState('');
  const [timeoutMin, setTimeoutMin] = useState(TERMINAL_TIMEOUT_DEFAULT_SEC / 60);
  const [history, setHistory] = useState(() => loadHistory(projectId));
  const [cursor, setCursor] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const draftRef = useRef('');
  const output = useStickToBottom<HTMLDivElement>(
    [projectId],
    [commands.length, commands.at(-1)?.output.bytes, commands.at(-1)?.status],
  );
  useEffect(() => {
    setHistory(loadHistory(projectId));
    setCursor(null);
  }, [projectId]);
  const running = commands.filter((item) => item.status === 'running').length;
  const full = state ? running >= state.maxRunning : false;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = command.trim();
    if (!text || sending) return;
    setSending(true);
    const ok = await run(text, timeoutMin * 60);
    setSending(false);
    if (!ok) return;
    setHistory(recordHistory(projectId, text));
    setCursor(null);
    setCommand('');
    output.stick();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!history.length) return;
    event.preventDefault();
    if (event.key === 'ArrowUp') {
      if (cursor === null) draftRef.current = command;
      const next = cursor === null ? history.length - 1 : Math.max(0, cursor - 1);
      setCursor(next);
      setCommand(history[next]);
    } else if (cursor !== null) {
      const next = cursor + 1;
      if (next >= history.length) {
        setCursor(null);
        setCommand(draftRef.current);
      } else {
        setCursor(next);
        setCommand(history[next]);
      }
    }
  };
  return (
    <div className="terminal-tab">
      <p className="tools-note">
        {tRich(
          !state
            ? 'tools.terminal.note'
            : state.sandbox === 'workspace-write'
              ? 'tools.terminal.noteWrite'
              : 'tools.terminal.noteRead',
          { yes: <code>--yes</code>, ci: <code>CI=1</code> },
        )}
      </p>
      {state && !state.enabled && (
        <div className="inline-notice error-notice" role="alert">
          {state.reason}
        </div>
      )}
      <div
        className="terminal-output"
        ref={output.ref}
        onScroll={output.onScroll}
        role="log"
        aria-label={t('tools.terminal.output')}
        tabIndex={0}
      >
        {!commands.length && <p className="terminal-empty">{t('tools.terminal.empty')}</p>}
        {commands.map((item) => (
          <TerminalEntry key={item.id} command={item} onStop={() => void stop(item.id)} onPreview={onPreview} />
        ))}
      </div>
      {error && (
        <div className="inline-notice error-notice" role="alert">
          {error}
        </div>
      )}
      <form className="terminal-form" onSubmit={(event) => void submit(event)} aria-label={t('tools.terminal.form')}>
        <span className="terminal-prompt" aria-hidden="true">
          $
        </span>
        <input
          className="terminal-input"
          aria-label={t('tools.terminal.command')}
          placeholder="npm test"
          value={command}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={state?.enabled === false}
          onChange={(event) => {
            setCommand(event.target.value);
            setCursor(null);
          }}
          onKeyDown={onKeyDown}
        />
        <label className="terminal-timeout">
          <span className="visually-hidden">{t('tools.terminal.timeout')}</span>
          <select
            aria-label={t('tools.terminal.timeout')}
            value={timeoutMin}
            onChange={(event) => setTimeoutMin(Number(event.target.value))}
            disabled={state?.enabled === false}
          >
            {TIMEOUTS.map((minutes) => (
              <option key={minutes} value={minutes}>
                {t('tools.terminal.minutes', { minutes })}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary-button"
          disabled={!command.trim() || sending || full || !state?.enabled}
          title={full ? t('tools.terminal.full', { max: state?.maxRunning ?? 0 }) : t('tools.terminal.runTitle')}
        >
          <Play size={14} /> {t('tools.terminal.run')}
        </button>
      </form>
      {state?.enabled && (
        <p className="terminal-meta">{t('tools.terminal.meta', { running, max: state.maxRunning })}</p>
      )}
    </div>
  );
}

function TerminalEntry({
  command,
  onStop,
  onPreview,
}: {
  command: TerminalCommand;
  onStop: () => void;
  onPreview: (url: string) => void;
}) {
  const { t, fmt } = useI18n();
  const urls = useMemo(() => detectDevServerUrls(outputText(command.output)), [command.output]);
  return (
    <section className="terminal-entry" aria-label={t('tools.terminal.entry', { command: command.command })}>
      <header className="terminal-entry-header">
        <code className="terminal-command">$ {command.command}</code>
        <span className={`terminal-status ${statusClass(command)}`}>{statusLabel(command, t)}</span>
        {command.durationMs !== undefined && (
          <span className="terminal-duration">{fmt.duration(command.durationMs)}</span>
        )}
        {command.status === 'running' && (
          <button type="button" className="danger-button terminal-stop" onClick={onStop}>
            <Square size={11} fill="currentColor" /> {t('tools.terminal.stop')}
          </button>
        )}
      </header>
      {command.output.truncated && <p className="terminal-truncated">{t('tools.terminal.truncated')}</p>}
      {command.output.chunks.length > 0 && (
        <pre className="terminal-text">
          {command.output.chunks.map((chunk, index) => (
            <span key={index} className={chunk.stream === 'stderr' ? 'stderr' : undefined}>
              {chunk.text}
            </span>
          ))}
        </pre>
      )}
      {command.error && <p className="terminal-error">{command.error}</p>}
      {urls.length > 0 && (
        <div className="terminal-urls">
          {urls.map((url) => (
            <button key={url} type="button" className="secondary-button" onClick={() => onPreview(url)}>
              <Monitor size={13} /> {t('tools.terminal.openPreview')} <span className="terminal-url">{url}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function PreviewTab({ url, onUrl, remote }: { url: string; onUrl: (url: string) => void; remote: boolean }) {
  const { t, tRich } = useI18n();
  const [input, setInput] = useState(url);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setInput(url);
    setError('');
  }, [url]);
  const current = url ? validatePreviewUrl(url, window.location.origin) : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validatePreviewUrl(input, window.location.origin);
    if (!result.ok) {
      setError(t(`tools.preview.error.${result.code}`));
      return;
    }
    setError('');
    if (result.url === url) setReload((n) => n + 1);
    onUrl(result.url);
  };
  return (
    <div className="preview-tab">
      <form className="preview-form" onSubmit={submit} aria-label={t('tools.preview.address')} noValidate>
        <input
          aria-label={t('tools.preview.address')}
          placeholder="http://localhost:5173"
          value={input}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'preview-error' : undefined}
          onChange={(event) => setInput(event.target.value)}
        />
        <button className="primary-button">{t('tools.preview.open')}</button>
      </form>
      {error && (
        <p className="preview-error" id="preview-error" role="alert">
          {error}
        </p>
      )}
      {remote && <p className="tools-note warning">{t('tools.preview.remote')}</p>}
      {current?.ok && (
        <>
          <div className="preview-actions">
            <span className="preview-current" title={current.url}>
              {current.url}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={t('tools.preview.reloadLabel')}
              title={t('tools.preview.reload')}
              disabled={!current.frameable}
              onClick={() => setReload((n) => n + 1)}
            >
              <RotateCw size={15} />
            </button>
            <a
              className="icon-button"
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('tools.preview.openBrowser')}
              title={t('tools.preview.openBrowser')}
            >
              <ExternalLink size={15} />
            </a>
          </div>
          {current.frameable ? (
            <iframe
              key={`${current.url}#${reload}`}
              className="preview-frame"
              title={t('tools.preview.frame')}
              src={current.url}
              sandbox="allow-scripts allow-forms allow-same-origin"
              referrerPolicy="no-referrer"
            />
          ) : (
            <p className="tools-note">{t('tools.preview.ipv6')}</p>
          )}
        </>
      )}
      {!url && (
        <p className="tools-note">
          {tRich('tools.preview.hint', { action: <strong>{t('tools.terminal.openPreview')}</strong> })}
        </p>
      )}
    </div>
  );
}
