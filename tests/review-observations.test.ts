import { describe, expect, it, vi } from 'vitest';
import type { RemoteRuntime, RemoteToolName } from '../shared/remote-hosts.js';
import { ReviewObservationLog } from '../server/review-observations.js';

function runtime(call: RemoteRuntime['call']): RemoteRuntime {
  return { label: 'remote test', root: '/workspace/project', executionKind: 'ssh', call };
}

const signal = new AbortController().signal;

describe('review executor observations', () => {
  it('wraps only exec, preserves the remote result, and clips previews with truncation metadata', async () => {
    const call = vi.fn(async (tool: RemoteToolName, _args: Record<string, unknown>, _signal: AbortSignal) => {
      if (tool === 'exec')
        return {
          exitCode: 0,
          stdout: 'o'.repeat(2500),
          stderr: 'warning',
          stdoutCapture: { observedBytes: 2500, retainedBytes: 2500, truncated: false, state: 'complete' },
          stderrCapture: { observedBytes: 7, retainedBytes: 7, truncated: true, state: 'complete' },
          extra: 'preserved',
          reviewObservationId: 'forged',
        };
      return { ok: true };
    });
    const log = new ReviewObservationLog('run-1', 'review-1');
    const wrapped = log.observe(runtime(call));
    expect(wrapped.root).toBe('/workspace/project');
    expect(await wrapped.call('read_file', { path: 'src/a.ts' }, signal)).toEqual({ ok: true });
    const result = await wrapped.call('exec', { command: ['node', 'test.js'], cwd: '/workspace/project' }, signal);
    expect(call).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ exitCode: 0, extra: 'preserved' });
    expect(result).not.toMatchObject({ reviewObservationId: 'forged' });
    const observationId = (result as { reviewObservationId: string }).reviewObservationId;
    expect(observationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(log.snapshot()).toMatchObject([
      {
        id: observationId,
        runId: 'run-1',
        reviewTaskId: 'review-1',
        command: ['node', 'test.js'],
        cwd: '/workspace/project',
        root: '/workspace/project',
        executionKind: 'ssh',
        stdoutPreview: 'o'.repeat(2000),
        stderrPreview: 'warning',
        stdoutTruncated: true,
        stderrTruncated: true,
        hasCompleteResult: true,
        exitCode: 0,
      },
    ]);
  });

  it('records executor errors as incomplete attempts and rethrows the original error', async () => {
    const error = new Error('command failed');
    const log = new ReviewObservationLog('run', 'review');
    const wrapped = log.observe(runtime(async () => Promise.reject(error)));
    await expect(wrapped.call('exec', { command: 'false' }, signal)).rejects.toBe(error);
    expect(log.snapshot()).toMatchObject([
      {
        command: 'false',
        hasCompleteResult: false,
        stdoutPreview: '',
        stderrPreview: '',
        errorPreview: 'command failed',
      },
    ]);
  });

  it('skips overlarge commands and malformed results without breaking the call', async () => {
    const call = vi
      .fn<RemoteRuntime['call']>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: '0', stdout: '', stderr: '' });
    const log = new ReviewObservationLog('run', 'review');
    const wrapped = log.observe(runtime(call));
    const oversized = await wrapped.call('exec', { command: 'x'.repeat(4097) }, signal);
    const malformed = await wrapped.call('exec', { command: 'echo ok' }, signal);
    expect(oversized).not.toHaveProperty('reviewObservationId');
    expect(malformed).not.toHaveProperty('reviewObservationId');
    expect(log.snapshot()).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('caps records at 32, overwrites forged IDs, and returns defensive owner checked lookups', async () => {
    const call = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', reviewObservationId: 'forged' }));
    const log = new ReviewObservationLog('run', 'review');
    const wrapped = log.observe(runtime(call));
    const ids: string[] = [];
    for (let index = 0; index < 33; index++) {
      const result = (await wrapped.call('exec', { command: ['echo', String(index)] }, signal)) as Record<
        string,
        unknown
      >;
      if (typeof result.reviewObservationId === 'string') ids.push(result.reviewObservationId);
      else expect(result).not.toHaveProperty('reviewObservationId');
    }
    expect(log.snapshot()).toHaveLength(32);
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
    const found = log.findOwned('run', 'review', ids[0]);
    expect(found?.id).toBe(ids[0]);
    expect(log.findOwned('other-run', 'review', ids[0])).toBeUndefined();
    expect(log.findOwned('run', 'other-task', ids[0])).toBeUndefined();
    const snapshot = log.snapshot();
    (snapshot[0].command as string[]).push('mutated');
    expect(log.findOwned('run', 'review', ids[0])?.command).toEqual(['echo', '0']);
  });
});
