// Intelligent retry for provider runs.
//
// The question is not only "is this error transient?" but "is it safe to repeat?". A run
// is retried automatically only while it has had no observable effect: no text streamed
// to the user, no tool started, no approval requested. Once any of that happened,
// repeating could run a command twice or duplicate an answer, so the run fails and the
// UI offers an explicit "Tentar de novo".

export type FailureKind =
  | 'transient' // timeouts, dropped streams, process crashes, 5xx, network resets
  | 'capacity' // rate limits, overloaded / at-capacity models
  | 'permanent'; // auth, invalid input, policy blocks, missing binary, unsupported features

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
  [/\b(quota exceeded|insufficient[_ ]quota|billing|payment required|402)\b/i, 'cota ou cobrança'],
  [/\b(context length|context window|too many tokens|maximum context|prompt is too long)\b/i, 'contexto grande demais'],
  [
    /(bloquead|não disponibiliza|não oferece|incompatível|não encontrado|not found|not installed|ENOENT)/i,
    'configuração',
  ],
  [/\b(invalid|malformed|bad request|400|unsupported|not supported)\b/i, 'pedido inválido'],
  [/(shutting down|cancelad|cancelled|canceled|aborted)/i, 'cancelado'],
];
const CAPACITY: [RegExp, string][] = [
  [/\b(at capacity|overloaded|capacity|server is busy|try again later)\b/i, 'modelo sobrecarregado'],
  [/\b(rate[ -]?limit|too many requests|429|throttl)/i, 'limite de requisições'],
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
  for (const [pattern, reason] of CAPACITY) if (pattern.test(text)) return { kind: 'capacity', reason };
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
  const base = policy.baseDelayMs * (kind === 'capacity' ? 3 : 1);
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
          };
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
