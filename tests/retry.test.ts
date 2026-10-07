import { describe, expect, it, vi } from 'vitest';
import {
  classifyFailure,
  isCapacityKind,
  retryDelay,
  withRetry,
  DEFAULT_RETRY,
  type RetryProgress,
} from '../server/retry.js';

describe('failure classification', () => {
  it.each([
    ['Kiro stream failed: The operation timed out.', 'transient'],
    ['Provider request timed out: session/prompt', 'transient'],
    ['Provider process exited (0)', 'transient'],
    ['Codex app-server encerrou antes de concluir o turno.', 'transient'],
    ['read ECONNRESET', 'transient'],
    ['HTTP 500 Internal Server Error', 'transient'],
    ['502 Bad Gateway', 'transient'],
    ['Selected model is at capacity. Please try a different model.', 'overloaded'],
    ['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded'],
    ['The model is currently under high load, please retry', 'overloaded'],
    ['HTTP 529', 'overloaded'],
    ['HTTP 503 Service Unavailable: model overloaded', 'overloaded'],
    ['Server is busy, try again later', 'overloaded'],
    ['429 Too Many Requests', 'rate_limit'],
    ['rate limit exceeded', 'rate_limit'],
    ['{"type":"rate_limit_error"}', 'rate_limit'],
    ['Quota exceeded for requests per minute', 'rate_limit'],
    ['RESOURCE_EXHAUSTED: quota', 'rate_limit'],
    ['Too many requests, try again later', 'rate_limit'],
    ['Request throttled', 'rate_limit'],
    ['401 Unauthorized', 'permanent'],
    ['Not logged in. Run login first.', 'permanent'],
    ['authentication timed out', 'permanent'],
    ['insufficient_quota', 'permanent'],
    ['You exceeded your current quota, please check your plan and billing details', 'permanent'],
    ['401 Unauthorized: rate limit', 'permanent'],
    ['prompt is too long for the context window', 'permanent'],
    ['Execução Codex bloqueada: configuração MCP efetiva desconhecida', 'permanent'],
    ['Este provedor não disponibiliza ferramentas', 'permanent'],
    ['Execução cancelada', 'permanent'],
    ['something odd happened', 'permanent'],
  ])('%s → %s', (message, kind) => {
    expect(classifyFailure(new Error(message)).kind).toBe(kind);
  });

  it('names the capacity kinds for the user', () => {
    expect(classifyFailure(new Error('overloaded')).reason).toBe('modelo sobrecarregado');
    expect(classifyFailure(new Error('429')).reason).toBe('limite de requisições');
  });

  it('treats both capacity kinds and the legacy one alike', () => {
    expect(['overloaded', 'rate_limit', 'capacity', 'transient', 'permanent', undefined].map(isCapacityKind)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter, waits longer on capacity and is capped', () => {
    const mid = () => 0.5;
    expect(retryDelay(1, 'transient', DEFAULT_RETRY, mid)).toBe(2000);
    expect(retryDelay(2, 'transient', DEFAULT_RETRY, mid)).toBe(4000);
    expect(retryDelay(1, 'overloaded', DEFAULT_RETRY, mid)).toBe(6000);
    expect(retryDelay(1, 'rate_limit', DEFAULT_RETRY, mid)).toBe(6000);
    expect(retryDelay(10, 'transient', DEFAULT_RETRY, mid)).toBe(30_000);
    expect(retryDelay(1, 'transient', DEFAULT_RETRY, () => 0)).toBe(1500);
    expect(retryDelay(1, 'transient', DEFAULT_RETRY, () => 1)).toBe(2500);
  });
});

describe('withRetry', () => {
  const options = (onRetry = vi.fn<(p: RetryProgress) => void>()) => ({
    policy: DEFAULT_RETRY,
    signal: new AbortController().signal,
    onRetry,
    sleep: vi.fn(async () => {}),
    random: () => 0.5,
  });

  it('retries a transient failure that had no effect, then succeeds', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const result = await withRetry(async () => {
      if (++calls < 3) throw new Error('The operation timed out.');
      return 'ok';
    }, options(onRetry));
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry.mock.calls.map(([p]) => [p.attempt, p.of, p.delayMs, p.reason])).toEqual([
      [2, 3, 2000, 'tempo esgotado'],
      [3, 3, 4000, 'tempo esgotado'],
    ]);
  });

  it('never repeats a run that already streamed text or ran a tool', async () => {
    for (const effect of ['text', 'tool', 'approval'] as const) {
      let calls = 0;
      const error = await withRetry(async (effects) => {
        calls++;
        effects.note(effect);
        throw new Error('stream failed');
      }, options()).catch((e) => e);
      expect(calls).toBe(1);
      expect(error.retry).toMatchObject({
        kind: 'transient',
        retryable: true,
        why: expect.stringMatching(/não repetido/),
      });
    }
  });

  it('does not retry permanent errors and stops after the policy', async () => {
    let calls = 0;
    const permanent = await withRetry(async () => {
      calls++;
      throw new Error('401 Unauthorized');
    }, options()).catch((e) => e);
    expect(calls).toBe(1);
    expect(permanent.retry).toMatchObject({ kind: 'permanent', retryable: false });
    calls = 0;
    const exhausted = await withRetry(async () => {
      calls++;
      throw new Error('ETIMEDOUT');
    }, options()).catch((e) => e);
    expect(calls).toBe(3);
    expect(exhausted.retry).toMatchObject({
      attempts: 3,
      why: 'falhou após 3 tentativas',
      exhausted: true,
      hadEffects: false,
    });
  });

  it('stops waiting as soon as the run is cancelled', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = withRetry(
      async () => {
        calls++;
        throw new Error('timed out');
      },
      {
        policy: { ...DEFAULT_RETRY, baseDelayMs: 60_000 },
        signal: controller.signal,
        onRetry: () => controller.abort(),
      },
    );
    await expect(pending).rejects.toThrow(/cancelada/);
    expect(calls).toBe(1);
  });
});
