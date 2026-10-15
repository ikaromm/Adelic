import { randomUUID } from 'node:crypto';
import type { RemoteRuntime, RemoteToolName } from '../shared/remote-hosts.js';

const MAX_OBSERVATIONS = 32;
const MAX_COMMAND_CHARS = 4096;
const MAX_FIELD_CHARS = 4096;
const MAX_PREVIEW_CHARS = 2000;

export interface ReviewObservation {
  id: string;
  runId: string;
  reviewTaskId: string;
  command: string | string[];
  cwd: string | null;
  root: string;
  executionKind: RemoteRuntime['executionKind'] | null;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  hasCompleteResult: boolean;
  exitCode?: number;
  errorPreview?: string;
}

interface ObservationInput {
  command: string | string[];
  cwd: string | null;
  root: string;
  executionKind: RemoteRuntime['executionKind'] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function withoutForgedObservationId(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, 'reviewObservationId')) return value;
  const copy = { ...value };
  delete copy.reviewObservationId;
  return copy;
}

function preview(text: string, remoteTruncated: boolean): { text: string; truncated: boolean } {
  return {
    text: text.slice(0, MAX_PREVIEW_CHARS),
    truncated: remoteTruncated || text.length > MAX_PREVIEW_CHARS,
  };
}

function captureWasTruncated(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.truncated === true || value.state === 'incomplete' || value.state === 'error';
}

function observationInput(remote: RemoteRuntime, args: Record<string, unknown>): ObservationInput | undefined {
  const command = args.command;
  if (
    (typeof command !== 'string' &&
      !(Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string'))) ||
    JSON.stringify(command).length > MAX_COMMAND_CHARS
  )
    return undefined;
  const cwd = args.cwd;
  if ((cwd !== undefined && typeof cwd !== 'string') || (typeof cwd === 'string' && cwd.length > MAX_FIELD_CHARS))
    return undefined;
  if (typeof remote.root !== 'string' || remote.root.length > MAX_FIELD_CHARS) return undefined;
  const executionKind = remote.executionKind;
  return {
    command: Array.isArray(command) ? [...command] : command,
    cwd: typeof cwd === 'string' ? cwd : null,
    root: remote.root,
    executionKind: executionKind === 'ssh' || executionKind === 'isolated-local' ? executionKind : null,
  };
}

/**
 * Bounded observations of reviewer executor calls. These records describe tool results and
 * attempts; they are not check results, source fingerprints, or proof that a command was safe.
 */
export class ReviewObservationLog {
  private readonly observations: ReviewObservation[] = [];

  constructor(
    readonly runId: string,
    readonly reviewTaskId: string,
  ) {}

  /** Return a pass-through runtime that records only bounded `exec` calls. */
  observe(remote: RemoteRuntime): RemoteRuntime {
    return {
      ...remote,
      call: async (tool: RemoteToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
        if (tool !== 'exec') return remote.call(tool, args, signal);
        const input = observationInput(remote, args);
        if (!input || this.observations.length >= MAX_OBSERVATIONS) {
          return withoutForgedObservationId(await remote.call(tool, args, signal));
        }
        let result: unknown;
        try {
          result = await remote.call(tool, args, signal);
        } catch (error) {
          let errorMessage = 'Falha não detalhada';
          try {
            errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, MAX_PREVIEW_CHARS);
          } catch {
            // Keep observation failures from replacing the original executor failure.
          }
          this.record({
            ...input,
            stdoutPreview: '',
            stderrPreview: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            hasCompleteResult: false,
            errorPreview: errorMessage,
          });
          throw error;
        }
        if (!isRecord(result)) return result;
        if (!Number.isInteger(result.exitCode)) return withoutForgedObservationId(result);
        if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string')
          return withoutForgedObservationId(result);
        const stdout = preview(result.stdout, captureWasTruncated(result.stdoutCapture));
        const stderr = preview(result.stderr, captureWasTruncated(result.stderrCapture));
        const observationId = this.record({
          ...input,
          stdoutPreview: stdout.text,
          stderrPreview: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          hasCompleteResult: true,
          exitCode: result.exitCode as number,
        });
        return observationId ? { ...result, reviewObservationId: observationId } : withoutForgedObservationId(result);
      },
    };
  }

  /** Return a defensive snapshot, never the mutable internal array or argv arrays. */
  snapshot(): readonly ReviewObservation[] {
    return this.observations.map((observation) => ({
      ...observation,
      command: Array.isArray(observation.command) ? [...observation.command] : observation.command,
    }));
  }

  /** Look up an observation only when both owning IDs match. */
  findOwned(runId: string, reviewTaskId: string, observationId: string): ReviewObservation | undefined {
    if (runId !== this.runId || reviewTaskId !== this.reviewTaskId) return undefined;
    const observation = this.observations.find((candidate) => candidate.id === observationId);
    return observation
      ? {
          ...observation,
          command: Array.isArray(observation.command) ? [...observation.command] : observation.command,
        }
      : undefined;
  }

  private record(observation: Omit<ReviewObservation, 'id' | 'runId' | 'reviewTaskId'>): string | undefined {
    if (this.observations.length >= MAX_OBSERVATIONS) return undefined;
    const id = randomUUID();
    this.observations.push({ id, runId: this.runId, reviewTaskId: this.reviewTaskId, ...observation });
    return id;
  }
}
