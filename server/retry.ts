// Intelligent retry for provider runs.
//
// The question is not only "is this error transient?" but "is it safe to repeat?". A run
// is retried automatically only while it has had no observable effect: no text streamed
// to the user, no tool started, no approval requested. Once any of that happened,
// repeating could run a command twice or duplicate an answer, so the run fails and the
// UI offers an explicit "Tentar de novo".

export type FailureKind =
  | 'transient' // timeouts, dropped streams, process crashes, 5xx, network resets
  | 'overloaded' // the model is at capacity / under high load (503, 529, "overloaded")
  | 'rate_limit' // this account hit a request limit (429, "rate limit", per-minute quotas)
  | 'permanent'; // auth, invalid input, policy blocks, missing binary, unsupported features

/** Capacity failures: waiting helps, and so does another model (docs/specs/retries.md). */
export const isCapacityKind = (kind: string | undefined) =>
  // 'capacity' is the single kind runs recorded before overloaded and rate_limit were split.
  kind === 'overloaded' || kind === 'rate_limit' || kind === 'capacity';

export interface Classified {
  kind: FailureKind;
  /** Short reason shown to the user. */
  reason: string;
}

// Order matters: permanent patterns win over transient ones ("auth timed out" is auth).
const PERMANENT: [RegExp, string][] = [
  [
    /\b(unauthori[sz]ed|401|403|forbidden|not logged in|login required|invalid api key|authentication)\b/i,
    'autenticação',
  ],
  // Billing quotas are permanent; per-minute quotas ("quota exceeded for ... per minute") are rate limits.
  [/\b(insufficient[_ ]quota|billing|payment required|402)\b/i, 'cota ou cobrança'],
  [/\b(context length|context window|too many tokens|maximum context|prompt is too long)\b/i, 'contexto grande demais'],
  [
    /(bloquead|não disponibiliza|não oferece|incompatível|não encontrado|not found|not installed|ENOENT)/i,
    'configuração',
  ],
  [/\b(invalid|malformed|bad request|400|unsupported|not supported)\b/i, 'pedido inválido'],
  [/(shutting down|cancelad|cancelled|canceled|aborted)/i, 'cancelado'],
];
// Rate limits first: "429 Too Many Requests, try again later" is a rate limit, not overload.
// No trailing \b on words that providers glue to `_error` (`rate_limit_error`, `overloaded_error`).
const CAPACITY: [RegExp, FailureKind, string][] = [
  [
    /(\brate[ _-]?limit|\btoo many requests|\b429\b|\bthrottl|\bquota\b|\bresource[_ ]exhausted)/i,
    'rate_limit',
    'limite de requisições',
  ],
  [
    /(\boverloaded|\bcapacity\b|\bhigh (load|demand)\b|\bserver is busy\b|\b(503|529)\b|\bservice unavailable\b|\btry again later\b)/i,
    'overloaded',
    'modelo sobrecarregado',
  ],
];
const TRANSIENT: [RegExp, string][] = [
  [/(timed? ?out|timeout|deadline exceeded|ETIMEDOUT)/i, 'tempo esgotado'],
  [
    /\b(ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|connection (reset|closed|refused)|stream (failed|ended|closed|error))\b/i,
    'conexão interrompida',
  ],
  [
    /\b(5\d\d|internal server error|bad gateway|service unavailable|gateway timeout)\b/i,
    'erro do servidor do provedor',
  ],
  [
    /(provider process exited|process (crashed|exited|terminated)|app-server encerrou|encerrou antes de concluir|SIGKILL|SIGSEGV)/i,
    'o agente encerrou inesperadamente',
  ],
  [/(provider request timed out)/i, 'tempo esgotado'],
];

export function classifyFailure(error: unknown): Classified {
  const text =
    error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
  for (const [pattern, reason] of PERMANENT) if (pattern.test(text)) return { kind: 'permanent', reason };
  for (const [pattern, kind, reason] of CAPACITY) if (pattern.test(text)) return { kind, reason };
  for (const [pattern, reason] of TRANSIENT) if (pattern.test(text)) return { kind: 'transient', reason };
  return { kind: 'permanent', reason: 'erro não reconhecido' };
}

export interface RetryPolicy {
  /** Extra attempts after the first (0 disables). */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_RETRY: RetryPolicy = { retries: 2, baseDelayMs: 2000, maxDelayMs: 30_000 };

/** Exponential backoff with jitter; capacity errors wait longer than transient ones. */
export function retryDelay(attempt: number, kind: FailureKind, policy: RetryPolicy, random = Math.random) {
  const base = policy.baseDelayMs * (isCapacityKind(kind) ? 3 : 1);
  const exponential = Math.min(policy.maxDelayMs, base * 2 ** (attempt - 1));
  return Math.round(exponential * (0.75 + random() * 0.5));
}

export interface RetryProgress {
  attempt: number;
  of: number;
  delayMs: number;
  reason: string;
  error: string;
}

/** Tracks whether a run did something that makes repeating it unsafe. */
export class EffectTracker {
  private effects: string[] = [];
  note(effect: 'text' | 'tool' | 'approval') {
    if (!this.effects.includes(effect)) this.effects.push(effect);
  }
  get any() {
    return this.effects.length > 0;
  }
  describe() {
    const names = {
      text: 'texto já exibido',
      tool: 'ferramenta já executada',
      approval: 'aprovação já pedida',
    } as const;
    return this.effects.map((e) => names[e as keyof typeof names]).join(', ');
  }
}

export class RetryAbortedError extends Error {}

/** Attached by withRetry to the error it finally throws (`error.retry`). */
export interface RetryInfo {
  kind: FailureKind;
  reason: string;
  attempts: number;
  why?: string;
  retryable: boolean;
  exhausted: boolean;
  hadEffects: boolean;
}
export const retryInfo = (error: unknown) => (error as { retry?: RetryInfo } | null)?.retry;

/**
 * Runs `attempt` until it succeeds, the error is not retryable, the run had effects,
 * the policy is exhausted, or the signal aborts. `attempt` receives a fresh tracker each
 * time so effects are judged per attempt.
 */
export async function withRetry<T>(
  attempt: (effects: EffectTracker, attemptNumber: number) => Promise<T>,
  options: {
    policy: RetryPolicy;
    signal: AbortSignal;
    onRetry: (progress: RetryProgress) => void;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    random?: () => number;
  },
): Promise<T> {
  const sleep = options.sleep ?? abortableSleep;
  for (let n = 1; ; n++) {
    const effects = new EffectTracker();
    try {
      return await attempt(effects, n);
    } catch (error) {
      if (options.signal.aborted) throw error;
      const { kind, reason } = classifyFailure(error);
      const exhausted = n > options.policy.retries;
      if (kind === 'permanent' || effects.any || exhausted) {
        if (error instanceof Error) {
          const why =
            kind === 'permanent'
              ? undefined
              : effects.any
                ? `não repetido automaticamente: ${effects.describe()}`
                : n > 1
                  ? `falhou após ${n} tentativas`
                  : undefined;
          (error as Error & { retry?: unknown }).retry = {
            kind,
            reason,
            attempts: n,
            why,
            retryable: kind !== 'permanent',
            // For the model fallback: it only follows an exhausted, effect-free attempt.
            exhausted,
            hadEffects: effects.any,
          } satisfies RetryInfo;
        }
        throw error;
      }
      const delayMs = retryDelay(n, kind, options.policy, options.random);
      options.onRetry({
        attempt: n + 1,
        of: options.policy.retries + 1,
        delayMs,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs, options.signal);
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new RetryAbortedError('Execução cancelada'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RetryAbortedError('Execução cancelada'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
