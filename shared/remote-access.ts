// Remote login (docs/specs/remote-access.md): shared rules and API shapes for the owner
// account, its sessions and the Tailscale Funnel option. Used by the server and the UI.

/**
 * Where a request came from. Only `local` (this computer, no proxy headers) skips login.
 * `tailnet`: the ADELIC_REMOTE_BIND listener or `tailscale serve` with a tailnet identity.
 * `internet`: Tailscale Funnel, or any proxied request that cannot be proven otherwise.
 */
export type AccessKind = 'local' | 'tailnet' | 'internet';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 64;
export const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
export const PASSWORD_MIN = 12;
/** Upper bound so a login request cannot make the server hash megabytes. */
export const PASSWORD_MAX = 256;
/** Generic login failure: never says whether the user or the password was wrong. */
export const LOGIN_FAILED = 'Usuário ou senha incorretos';

/**
 * Codes of the account rules below, for clients that translate them (src/i18n remoteAccess.*).
 * The pt-BR functions keep returning text: the server and the CLI print it as is.
 */
export type UsernameProblemKey = 'usernameLength' | 'usernameChars';
export type PasswordProblemKey = 'passwordShort' | 'passwordLong' | 'passwordSameAsUser';
export type PasswordHintKey = 'hintLength' | 'hintMix' | 'hintRepeat' | 'hintPredictable';

const USERNAME_PROBLEMS: Record<UsernameProblemKey, string> = {
  usernameLength: `O usuário deve ter de ${USERNAME_MIN} a ${USERNAME_MAX} caracteres.`,
  usernameChars: 'Use só letras minúsculas, números, ponto, hífen e sublinhado no usuário.',
};
const PASSWORD_PROBLEMS: Record<PasswordProblemKey, string> = {
  passwordShort: `A senha deve ter pelo menos ${PASSWORD_MIN} caracteres.`,
  passwordLong: `A senha deve ter no máximo ${PASSWORD_MAX} caracteres.`,
  passwordSameAsUser: 'A senha não pode ser igual ao usuário.',
};
const PASSWORD_HINTS: Record<PasswordHintKey, string> = {
  hintLength: 'Prefira 16 caracteres ou mais (uma frase com várias palavras funciona bem).',
  hintMix: 'Misture letras maiúsculas, minúsculas, números ou símbolos.',
  hintRepeat: 'Evite repetir os mesmos caracteres.',
  hintPredictable: 'Evite começos previsíveis como "123" ou "senha".',
};

/** Code of the problem that blocks the username; undefined when it is valid. */
export function usernameProblemKey(username: string): UsernameProblemKey | undefined {
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return 'usernameLength';
  if (!USERNAME_PATTERN.test(username)) return 'usernameChars';
  return undefined;
}
/** Problems that block the username; empty when it is valid. */
export function usernameProblem(username: string): string | undefined {
  const key = usernameProblemKey(username);
  return key && USERNAME_PROBLEMS[key];
}

/** Codes of the problems that block the password (policy); empty when it is accepted. */
export function passwordProblemKeys(username: string, password: string): PasswordProblemKey[] {
  const problems: PasswordProblemKey[] = [];
  if (password.length < PASSWORD_MIN) problems.push('passwordShort');
  if (password.length > PASSWORD_MAX) problems.push('passwordLong');
  if (username && password.trim().toLowerCase() === username.trim().toLowerCase()) problems.push('passwordSameAsUser');
  return problems;
}
/** Problems that block the password (policy); empty when it is accepted. */
export function passwordProblems(username: string, password: string): string[] {
  return passwordProblemKeys(username, password).map((key) => PASSWORD_PROBLEMS[key]);
}

/**
 * Advisory strength hints shown while typing, as codes; they never block a password that passes
 * the policy. Long passphrases are the recommendation, so length counts more than symbols.
 */
export function passwordHintKeys(password: string): { score: 0 | 1 | 2 | 3; hints: PasswordHintKey[] } {
  const hints: PasswordHintKey[] = [];
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const unique = new Set(password).size;
  if (password.length < 16) hints.push('hintLength');
  if (classes < 3 && password.length < 20) hints.push('hintMix');
  if (password.length && unique < Math.min(8, password.length / 2)) hints.push('hintRepeat');
  if (/^(?:123|abc|qwe|senha|password|adelic)/i.test(password)) hints.push('hintPredictable');
  let score: 0 | 1 | 2 | 3 = 0;
  if (password.length >= PASSWORD_MIN) score = 1;
  if (password.length >= 16 && classes >= 2 && hints.length <= 1) score = 2;
  if (password.length >= 20 && classes >= 3 && !hints.length) score = 3;
  return { score, hints };
}
/** passwordHintKeys with the pt-BR texts (server CLI). */
export function passwordHints(password: string): { score: 0 | 1 | 2 | 3; hints: string[] } {
  const { score, hints } = passwordHintKeys(password);
  return { score, hints: hints.map((key) => PASSWORD_HINTS[key]) };
}

export interface RemoteAccountView {
  username: string;
  createdAt: string;
  passwordChangedAt: string;
}
export interface RemoteSessionView {
  id: string;
  kind: Exclude<AccessKind, 'local'>;
  /** 'password' (the account) or 'token' (legacy ADELIC_REMOTE_TOKEN login on the tailnet). */
  method: 'password' | 'token';
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  /** The session of the request that asked for the list. */
  current?: boolean;
}
export interface LoginEventView {
  at: string;
  ok: boolean;
  kind: Exclude<AccessKind, 'local'>;
  /** Attempted username, bounded and sanitized; empty for token logins. */
  username: string;
  ip: string;
  userAgent: string;
  /** Why it failed: wrong credentials, rate limited or no account. */
  reason?: 'credentials' | 'rate-limit' | 'no-account';
}
/** GET /api/remote-access: what the Settings card shows. */
export interface RemoteAccessState {
  kind: AccessKind;
  account: RemoteAccountView | null;
  sessions: RemoteSessionView[];
  logins: LoginEventView[];
  /** ADELIC_REMOTE_BIND listener, when configured. */
  tailnet: { url: string; token: boolean } | null;
  /** Local listener that receives Funnel traffic (always classified as internet). */
  funnel: { port: number; listening: boolean; wanted: boolean; lastError?: string } | null;
  internetManualApproval: boolean;
}
/** GET /api/auth/status. */
export interface AuthStatus {
  remote: boolean;
  authenticated: boolean;
  kind: AccessKind;
  /** How this client can log in: the account, the legacy token (tailnet only) or not at all. */
  login: 'password' | 'token' | 'unavailable' | 'none';
  /** The legacy ADELIC_REMOTE_TOKEN is also accepted here (tailnet listener only). */
  token: boolean;
  username?: string;
}

/** GET /api/remote-access/tailscale: read-only probe of the local Tailscale CLI. */
export interface TailscaleState {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  backendState?: string;
  /** MagicDNS name, e.g. host.tailnet.ts.net (no trailing dot). */
  dnsName?: string;
  /** The tailnet allows HTTPS certificates for this node ("https" capability). */
  https: boolean;
  /** The "funnel" node attribute is set for this node. */
  funnelAllowed: boolean;
  /** Port 443 is in the allowed Funnel ports (absent attribute: Tailscale's default 443/8443/10000). */
  port443Allowed: boolean;
  /** Funnel currently publishes https://<dnsName>/ to this Adelic. */
  funnelOn: boolean;
  /** Funnel still points to the port of an earlier start; "Publicar" re-applies it. */
  stale?: boolean;
  /** Another target already uses https://<dnsName>:443/ (Adelic will not replace it). */
  conflict?: string;
  publicUrl?: string;
  error?: string;
  /** What the tailnet admin or operator must do before Funnel can be enabled. */
  requirements: { text: string; url?: string }[];
}
