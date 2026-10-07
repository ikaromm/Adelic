import { useCallback, useEffect, useState } from 'react';
import { appendOutput, type TerminalCommand, type TerminalEvent, type TerminalState } from '../../shared/terminal';
import { api } from '../api';

/** Applies one server event to the command list (output bounded like the server's). */
export function applyTerminalEvent(commands: TerminalCommand[], event: TerminalEvent): TerminalCommand[] {
  if (event.type === 'snapshot') return event.commands;
  if (event.type === 'command') {
    const index = commands.findIndex((command) => command.id === event.command.id);
    if (index < 0) return [...commands, { ...event.command, output: { chunks: [], bytes: 0, truncated: false } }];
    const next = [...commands];
    next[index] = { ...next[index], ...event.command };
    return next;
  }
  return commands.map((command) => {
    if (command.id !== event.id) return command;
    const output = {
      chunks: command.output.chunks.map((chunk) => ({ ...chunk })),
      bytes: command.output.bytes,
      truncated: command.output.truncated || Boolean(event.truncated),
    };
    for (const chunk of event.chunks) appendOutput(output, chunk.stream, chunk.text);
    return { ...command, output };
  });
}

/** Terminal state of a project while the panel is open: access, commands and live output. */
export function useTerminal(projectId: string, active: boolean) {
  const [state, setState] = useState<Omit<TerminalState, 'commands'> | null>(null);
  const [commands, setCommands] = useState<TerminalCommand[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let events: EventSource | undefined;
    setState(null);
    setCommands([]);
    setError('');
    api
      .terminal(projectId)
      .then((result) => {
        if (cancelled) return;
        const { commands: initial, ...rest } = result;
        setState(rest);
        setCommands(initial);
        if (!result.enabled) return;
        events = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/terminal/events`);
        events.onmessage = (message) => {
          let event: TerminalEvent;
          try {
            event = JSON.parse(message.data) as TerminalEvent;
          } catch {
            return;
          }
          setCommands((current) => applyTerminalEvent(current, event));
        };
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
      events?.close();
    };
  }, [projectId, active]);

  const run = useCallback(
    async (command: string, timeoutSec: number) => {
      setError('');
      try {
        const result = await api.runTerminal(projectId, command, timeoutSec);
        // The event stream normally delivers it first; this covers a slow stream.
        setCommands((current) =>
          current.some((item) => item.id === result.id)
            ? current
            : applyTerminalEvent(current, { type: 'command', command: result.command }),
        );
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [projectId],
  );
  const stop = useCallback(async (id: string) => {
    setError('');
    try {
      const result = await api.stopTerminal(id);
      setCommands((current) => applyTerminalEvent(current, { type: 'command', command: result }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  return { state, commands, error, run, stop };
}
