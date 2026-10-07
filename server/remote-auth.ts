import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { isIP } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import {
  PASSWORD_MAX,
  passwordProblems,
  usernameProblem,
  type AccessKind,
  type LoginEventView,
  type RemoteAccountView,
  type RemoteSessionView,
} from '../shared/remote-access.js';

// Owner account, login sessions and the login log for remote access (docs/specs/remote-access.md).
// Only a DatabaseSync is needed, so the CLI (server/remote-user-cli.ts) can use this without
// opening the whole Store, whose startup repairs must not run while the server is up.

/** scrypt parameters stored with each hash, so they can be raised later without breaking logins. */
export interface PasswordHash {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: string;
  hash: string;
}
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 } as const;
const SALT_BYTES = 16;

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }) {
  // 128 * N * r bytes are needed (32 MiB at N=2^15, r=8); Node's default cap is exactly that.
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r };
  return new Promise<Buffer>((resolve, reject) =>
    scryptCallback(password.normalize('NFC'), salt, params.keylen, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_PARAMS);
  return { algo: 'scrypt', ...SCRYPT_PARAMS, salt: salt.toString('base64'), hash: key.toString('base64') };
}

/** Constant-time comparison of the derived key; malformed or oversized input never matches. */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (stored.algo !== 'scrypt' || password.length > PASSWORD_MAX) return false;
  const expected = Buffer.from(stored.hash, 'base64');
  if (!expected.length || stored.N > 2 ** 20 || stored.r > 32 || stored.p > 16) return false;
  const key = await scrypt(password, Buffer.from(stored.salt, 'base64'), {
    N: stored.N,
    r: stored.r,
    p: stored.p,
    keylen: expected.length,
  });
  return timingSafeEqual(key, expected);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');
/** Equal-length digests, so the comparison time does not depend on where the strings differ. */
export const sameSecret = (given: string, expected: string) => timingSafeEqual(sha256(given), sha256(expected));

/** Single line, printable, bounded: values that come from the request (user agent, attempted user). */
export function boundedText(value: unknown, max: number) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, max);
}
export function cleanIp(value: string | undefined) {
  const ip = (value ?? '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  return isIP(ip) ? ip : 'desconhecido';
}

export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;
/** lastSeenAt is written at most this often, so reads do not turn into a write per request. */
const TOUCH_EVERY_MS = 60_000;
const LOGINS_KEPT = 200;
export const OWNER_ID = 'owner';
/** user_id of sessions opened with the legacy ADELIC_REMOTE_TOKEN (tailnet only). */
export const TOKEN_USER_ID = 'legacy-token';

interface StoredAccount {
  username: string;
  password: PasswordHash;
  createdAt: string;
  passwordChangedAt: string;
}
interface StoredSession {
  publicId: string;
  kind: Exclude<AccessKind, 'local'>;
  method: 'password' | 'token';
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
}
export interface SessionContext {
  kind: Exclude<AccessKind, 'local'>;
  ip: string;
  userAgent: string;
}
export interface ValidSession {
  /** SHA-256 of the cookie value: the row key; never sent to the client. */
  key: string;
  publicId: string;
  userId: string;
  method: 'password' | 'token';
}

/** A hash computed once and verified against when there is no account (similar timing either way). */
let dummyHash: Promise<PasswordHash> | undefined;
const dummy = () => (dummyHash ??= hashPassword(randomBytes(18).toString('base64')));

export class RemoteAccounts {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}
  private iso() {
    return new Date(this.now()).toISOString();
  }
  private stored(): StoredAccount | undefined {
    const row = this.db.prepare('SELECT data FROM remote_users WHERE id=?').get(OWNER_ID) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as StoredAccount) : undefined;
  }
  account(): RemoteAccountView | null {
    const a = this.stored();
    return a ? { username: a.username, createdAt: a.createdAt, passwordChangedAt: a.passwordChangedAt } : null;
  }
  hasAccount() {
    return Boolean(this.stored());
  }
  /**
   * Creates or replaces the owner account. Every session ends: a new password must log in again
   * everywhere. Callers make sure the request is local (UI on this computer or the CLI).
   */
  async setAccount(username: string, password: string) {
    const problem = usernameProblem(username) ?? passwordProblems(username, password)[0];
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    const hash = await hashPassword(password);
    const previous = this.stored();
    const now = this.iso();
    const account: StoredAccount = {
      username,
      password: hash,
      createdAt: previous?.createdAt ?? now,
      passwordChangedAt: now,
    };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO remote_users(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(OWNER_ID, JSON.stringify(account));
      this.db.prepare('DELETE FROM remote_sessions').run();
    });
    return this.account()!;
  }
  deleteAccount() {
    this.transaction(() => {
      this.db.prepare('DELETE FROM remote_users').run();
      this.db.prepare('DELETE FROM remote_sessions').run();
    });
  }
  /** Checks username and password; always runs one scrypt so a missing account looks the same. */
  async checkPassword(username: string, password: string) {
    const account = this.stored();
    const valid = await verifyPassword(password, account?.password ?? (await dummy()));
    const sameUser = sameSecret(username, account?.username ?? '\u0000');
    return Boolean(account) && valid && sameUser;
  }
  private transaction(work: () => void) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      work();
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  // ---- Sessions ----
  /** Returns the cookie value; only its SHA-256 is stored. */
  createSession(userId: string, method: 'password' | 'token', context: SessionContext) {
    const token = randomBytes(32).toString('base64url');
    const now = this.iso();
    const data: StoredSession = {
      publicId: randomBytes(9).toString('base64url'),
      kind: context.kind,
      method,
      createdAt: now,
      lastSeenAt: now,
      ip: context.ip,
      userAgent: boundedText(context.userAgent, 160),
    };
    this.db
      .prepare('INSERT INTO remote_sessions(id,user_id,data) VALUES(?,?,?)')
      .run(sha256hex(token), userId, JSON.stringify(data));
    return { token, publicId: data.publicId };
  }
  private expired(data: StoredSession) {
    const now = this.now();
    return (
      now - Date.parse(data.lastSeenAt) > SESSION_IDLE_MS || now - Date.parse(data.createdAt) > SESSION_ABSOLUTE_MS
    );
  }
  /**
   * Looks the cookie up. Expired sessions are deleted; a password session needs the account to
   * still exist, and legacy token sessions are refused outside the tailnet.
   */
  validate(token: string | undefined, context: SessionContext): ValidSession | undefined {
    if (!token || token.length > 128) return undefined;
    const key = sha256hex(token);
    const row = this.db.prepare('SELECT user_id, data FROM remote_sessions WHERE id=?').get(key) as
      { user_id: string; data: string } | undefined;
    if (!row) return undefined;
    const data = JSON.parse(row.data) as StoredSession;
    if (this.expired(data)) {
      this.db.prepare('DELETE FROM remote_sessions WHERE id=?').run(key);
      return undefined;
    }
    if (data.method === 'token' && context.kind !== 'tailnet') return undefined;
    if (data.method === 'password' && (row.user_id !== OWNER_ID || !this.hasAccount())) return undefined;
    if (this.now() - Date.parse(data.lastSeenAt) >= TOUCH_EVERY_MS) {
      const next: StoredSession = {
        ...data,
        lastSeenAt: this.iso(),
        ip: context.ip,
        userAgent: boundedText(context.userAgent, 160) || data.userAgent,
      };
      this.db.prepare('UPDATE remote_sessions SET data=? WHERE id=?').run(JSON.stringify(next), key);
    }
    return { key, publicId: data.publicId, userId: row.user_id, method: data.method };
  }
  /**
   * Whether a session row is still usable, without touching it: open event streams are checked
   * with this, so a revocation by the CLI (another process) also ends them.
   */
  alive(key: string) {
    const row = this.db.prepare('SELECT user_id, data FROM remote_sessions WHERE id=?').get(key) as
      { user_id: string; data: string } | undefined;
    if (!row) return false;
    const data = JSON.parse(row.data) as StoredSession;
    if (this.expired(data)) return false;
    return data.method === 'token' || this.hasAccount();
  }
  /** Active sessions, newest activity first; expired ones are removed on the way. */
  listSessions(currentKey?: string): RemoteSessionView[] {
    const rows = this.db.prepare('SELECT id, data FROM remote_sessions').all() as { id: string; data: string }[];
    const views: RemoteSessionView[] = [];
    for (const row of rows) {
      const data = JSON.parse(row.data) as StoredSession;
      if (this.expired(data)) {
        this.db.prepare('DELETE FROM remote_sessions WHERE id=?').run(row.id);
        continue;
      }
      views.push({
        id: data.publicId,
        kind: data.kind,
        method: data.method,
        createdAt: data.createdAt,
        lastSeenAt: data.lastSeenAt,
        ip: data.ip,
        userAgent: data.userAgent,
        ...(row.id === currentKey ? { current: true } : {}),
      });
    }
    return views.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
  /** Ends one session by its public id; returns the row key, so open streams can be closed. */
  revokeSession(publicId: string): string | undefined {
    const rows = this.db.prepare('SELECT id, data FROM remote_sessions').all() as { id: string; data: string }[];
    const row = rows.find((r) => (JSON.parse(r.data) as StoredSession).publicId === publicId);
    if (!row) return undefined;
    this.db.prepare('DELETE FROM remote_sessions WHERE id=?').run(row.id);
    return row.id;
  }
  revokeByKey(key: string) {
    this.db.prepare('DELETE FROM remote_sessions WHERE id=?').run(key);
  }
  revokeAll() {
    return Number(this.db.prepare('DELETE FROM remote_sessions').run().changes);
  }

  // ---- Login log ("Últimos acessos") ----
  recordLogin(event: Omit<LoginEventView, 'at'>) {
    const entry: LoginEventView = {
      at: this.iso(),
      ok: event.ok,
      kind: event.kind,
      username: boundedText(event.username, 64).replace(/[^\w.@-]/g, '?'),
      ip: event.ip,
      userAgent: boundedText(event.userAgent, 160),
      ...(event.reason ? { reason: event.reason } : {}),
    };
    this.db.prepare('INSERT INTO remote_logins(data) VALUES(?)').run(JSON.stringify(entry));
    this.db
      .prepare('DELETE FROM remote_logins WHERE id NOT IN (SELECT id FROM remote_logins ORDER BY id DESC LIMIT ?)')
      .run(LOGINS_KEPT);
  }
  listLogins(limit = 30): LoginEventView[] {
    return (
      this.db.prepare('SELECT data FROM remote_logins ORDER BY id DESC LIMIT ?').all(limit) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as LoginEventView);
  }
}

/**
 * Failed-login limits. Per client address: at most `perIp` failures per minute (429 after that).
 * Globally: past `globalFree` failures in ten minutes, every attempt waits an exponentially
 * growing delay capped at `maxDelayMs`. There is never a permanent lockout: the owner can always
 * log in after the delay.
 */
export class LoginLimiter {
  private perAddress = new Map<string, number[]>();
  private global: number[] = [];
  constructor(
    private readonly options: {
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      perIp?: number;
      globalFree?: number;
      maxDelayMs?: number;
    } = {},
  ) {}
  private get now() {
    return (this.options.now ?? Date.now)();
  }
  /** True when this address already used its failures for the current minute. */
  blocked(address: string) {
    const recent = (this.perAddress.get(address) ?? []).filter((at) => this.now - at < 60_000);
    if (recent.length) this.perAddress.set(address, recent);
    else this.perAddress.delete(address);
    return recent.length >= (this.options.perIp ?? 5);
  }
  /** Delay before checking a password, from the failures of the last ten minutes. */
  delayMs() {
    this.global = this.global.filter((at) => this.now - at < 600_000);
    const over = this.global.length - (this.options.globalFree ?? 20);
    if (over < 0) return 0;
    return Math.min(this.options.maxDelayMs ?? 30_000, 250 * 2 ** Math.min(over, 10));
  }
  async throttle() {
    const ms = this.delayMs();
    if (ms) await (this.options.sleep ?? ((wait) => new Promise<void>((done) => setTimeout(done, wait))))(ms);
    return ms;
  }
  /**
   * Counts an attempt as a failure right away (so concurrent attempts see it), and lets the
   * caller turn it into a success once the password matched.
   */
  reserve(address: string) {
    const at = this.now;
    this.fail(address, at);
    let done = false;
    return {
      settle: (ok: boolean) => {
        if (done) return;
        done = true;
        if (!ok) return;
        const i = this.global.lastIndexOf(at);
        if (i >= 0) this.global.splice(i, 1);
        this.succeed(address);
      },
    };
  }
  fail(address: string, at = this.now) {
    this.perAddress.set(address, [...(this.perAddress.get(address) ?? []), at]);
    this.global.push(at);
    // Bounded memory under a flood of distinct addresses.
    if (this.perAddress.size > 10_000) this.perAddress.delete(this.perAddress.keys().next().value!);
    if (this.global.length > 10_000) this.global.splice(0, this.global.length - 10_000);
  }
  succeed(address: string) {
    this.perAddress.delete(address);
  }
}
