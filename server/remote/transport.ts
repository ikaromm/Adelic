import { withObservation } from '../observability.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RemoteHost, RemoteProbe, RemoteToolName } from '../../shared/remote-hosts.js';
import { REMOTE_RUNNER_SOURCE } from './runner-source.js';

const MAX_FRAME = 1024 * 1024;
const STDERR_LIMIT = 8192;
const REMOTE_PATH = '/usr/local/bin:/usr/bin:/bin';
const TOOL_NAMES = new Set<RemoteToolName>([
  'exec',
  'read_file',
  'write_file',
  'replace_text',
  'list',
  'stat',
  'search',
  'git',
  'diagnose',
]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ERROR_CATEGORIES = ['timeout', 'not_found', 'permission', 'invalid_request', 'conflict', 'executor'] as const;
type RemoteErrorCategory = (typeof ERROR_CATEGORIES)[number];
const isErrorCategory = (value: unknown): value is RemoteErrorCategory =>
  typeof value === 'string' && ERROR_CATEGORIES.includes(value as RemoteErrorCategory);
export const reconstructRemoteError = (raw: string, rawCategory: unknown): Error & { category?: string } => {
  const category = isErrorCategory(rawCategory) ? rawCategory : undefined;
  const message = safeRemoteErrorMessage(category, raw);
  const error = new Error(message) as Error & { category?: string };
  if (category) error.category = category;
  return error;
};

const safeRemoteErrorMessage = (category: RemoteErrorCategory | undefined, raw: string): string => {
  // Only known runner diagnostics cross into provider context. SSH responses are untrusted;
  // old runners without a category remain supported, but their raw message is never forwarded.
  const safeMessages = [
    'file does not exist',
    'file exceeds read limit',
    'file must be read completely before replace_text',
    'expectedRevision must be a short string',
    'readRevision must be a short string',
    'expectedRevision and readRevision do not match',
    'file changed before edit',
    'file changed while reading',
    'file is not valid UTF-8',
    'read limit is too small for a UTF-8 character',
    'offset exceeds file size',
    'offset is not a UTF-8 boundary',
    'read limit must be between 1 and 49152 bytes',
    'unable to read UTF-8 boundary',
    'file exceeds edit limit',
    'edited file exceeds limit',
    'file is not valid UTF-8',
    'oldText must match exactly once',
    'parent directory does not exist',
    'path escapes project root',
    'path must be a string',
    'args must be an object',
    'tool arguments do not match the supported schema',
    'cwd is not a directory',
    'write_file is disabled for a read-only call',
    'replace_text is disabled for a read-only call',
    'content must be a string',
    'content exceeds write limit',
    'oldText must be a non-empty string',
    'newText must be a string',
    'replacement text exceeds limit',
    'edited file exceeds limit',
    'path is not a directory',
    'command cancelled',
  ];
  if (safeMessages.includes(raw)) return raw;
  if (category === 'timeout') return 'command timed out';
  if (category === 'not_found') return 'requested path was not found';
  if (category === 'permission') return 'permission denied';
  if (category === 'invalid_request') return 'invalid tool request or file';
  if (category === 'conflict') return 'file changed or replacement is ambiguous';
  return 'remote tool failed';
};

export const validateRemoteResult = (tool: RemoteToolName, value: unknown): unknown => {
  const isText = (item: unknown, limit: number): item is string =>
    typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= limit;
  if (!isRecord(value)) throw new Error(`Remote ${tool} result is not an object`);
  switch (tool) {
    case 'diagnose':
      if (
        !['repository', 'binary-only', 'unavailable', 'unverified'].includes(String(value.git)) ||
        !isRecord(value.tmp) ||
        typeof value.tmp['/tmp'] !== 'boolean' ||
        typeof value.tmp['/var/tmp'] !== 'boolean' ||
        !Array.isArray(value.browsers) ||
        value.browsers.length > 4 ||
        !value.browsers.every((name) =>
          ['chromium', 'chromium-browser', 'google-chrome', 'firefox'].includes(String(name)),
        ) ||
        (value.browserFunctional !== undefined &&
          (!Array.isArray(value.browserFunctional) ||
            !(value.browserFunctional as unknown[]).every((name) => (value.browsers as unknown[]).includes(name)))) ||
        !isRecord(value.binaries) ||
        Object.keys(value.binaries).length > 16 ||
        !Object.values(value.binaries).every((available) => typeof available === 'boolean') ||
        !isText(value.hostDependentTests, 512)
      )
        throw new Error('Remote diagnose result did not match its schema');
      break;
    case 'exec':
    case 'git':
      if (!Number.isInteger(value.exitCode) || !isText(value.stdout, 256 * 1024) || !isText(value.stderr, 256 * 1024)) {
        throw new Error(`Remote ${tool} result did not match its schema`);
      }
      break;
    case 'read_file':
      if (
        !isText(value.path, 4096) ||
        !isText(value.content, 48 * 1024) ||
        !Number.isSafeInteger(value.offset) ||
        (value.offset as number) < 0 ||
        !Number.isSafeInteger(value.bytesRead) ||
        (value.bytesRead as number) < 0 ||
        (value.bytesRead as number) > 48 * 1024 ||
        Buffer.byteLength(value.content, 'utf8') !== value.bytesRead ||
        !Number.isSafeInteger(value.totalBytes) ||
        (value.totalBytes as number) < 0 ||
        typeof value.truncated !== 'boolean' ||
        !Number.isSafeInteger(value.nextOffset) ||
        value.nextOffset !== (value.offset as number) + (value.bytesRead as number) ||
        !isText(value.revision, 128) ||
        !/^\d+:\d+:\d+:\d+:\d+$/.test(value.revision)
      ) {
        throw new Error('Remote read_file result did not match its schema');
      }
      break;
    case 'write_file':
      if (!isText(value.path, 4096) || !Number.isInteger(value.bytesWritten) || (value.bytesWritten as number) < 0) {
        throw new Error('Remote write_file result did not match its schema');
      }
      break;
    case 'replace_text':
      if (
        !isText(value.path, 4096) ||
        value.matches !== 1 ||
        !Number.isSafeInteger(value.bytesWritten) ||
        (value.bytesWritten as number) < 0 ||
        (value.bytesWritten as number) > 32 * 1024 * 1024
      ) {
        throw new Error('Remote replace_text result did not match its schema');
      }
      break;
    case 'list':
      if (
        !Array.isArray(value.entries) ||
        value.entries.length > 20000 ||
        typeof value.truncated !== 'boolean' ||
        !value.entries.every(
          (entry) =>
            isRecord(entry) &&
            isText(entry.name, 4096) &&
            isText(entry.path, 8192) &&
            typeof entry.directory === 'boolean',
        )
      ) {
        throw new Error('Remote list result did not match its schema');
      }
      break;
    case 'stat':
      if (
        !isText(value.path, 4096) ||
        !['directory', 'file', 'other'].includes(String(value.type)) ||
        !Number.isSafeInteger(value.size) ||
        !Number.isFinite(value.mtime)
      ) {
        throw new Error('Remote stat result did not match its schema');
      }
      break;
    case 'search':
      if (
        !Array.isArray(value.results) ||
        value.results.length > 1000 ||
        typeof value.truncated !== 'boolean' ||
        !isRecord(value.omittedFiles) ||
        !Number.isSafeInteger(value.omittedFiles.tooLarge) ||
        (value.omittedFiles.tooLarge as number) < 0 ||
        !Number.isSafeInteger(value.omittedFiles.unreadable) ||
        (value.omittedFiles.unreadable as number) < 0 ||
        !value.results.every(
          (entry) =>
            isRecord(entry) && isText(entry.path, 8192) && Number.isSafeInteger(entry.line) && isText(entry.text, 8192),
        )
      ) {
        throw new Error('Remote search result did not match its schema');
      }
      break;
  }
  return value;
};

const validateInfo = (value: unknown): { protocol: number; python: string; platform: string; root: string } => {
  if (
    !isRecord(value) ||
    value.protocol !== 1 ||
    typeof value.python !== 'string' ||
    typeof value.platform !== 'string' ||
    typeof value.root !== 'string'
  ) {
    throw new Error('Remote runner info did not match its schema');
  }
  return value as { protocol: number; python: string; platform: string; root: string };
};

export interface RemoteConnection {
  call(tool: RemoteToolName, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  info(): Promise<{ protocol: number; python: string; platform: string; root: string }>;
  close(): Promise<void>;
}

export interface RemoteHostServiceInstance {
  probe(target: string, port?: number): Promise<RemoteProbe>;
  test(host: RemoteHost): Promise<{ protocol: number; python: string; platform: string; root: string }>;
  install(host: RemoteHost): Promise<void>;
  connect(host: RemoteHost, cwd: string, options?: { readOnly?: boolean }): Promise<RemoteConnection>;
  /** One-off call for callers that do not need a persistent per-run connection. */
  call(
    host: RemoteHost,
    cwd: string,
    tool: RemoteToolName,
    args: Record<string, unknown>,
    signal: AbortSignal,
    options?: { readOnly?: boolean },
  ): Promise<unknown>;
  disconnect(hostId: string): Promise<void>;
  shutdown(): Promise<void>;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  signal: AbortSignal;
  abort?: () => void;
}

const childEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG,
  };
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  return env;
};

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const validTarget = (target: string): boolean =>
  target.length > 0 && target.length <= 255 && !target.startsWith('-') && /^[A-Za-z0-9_.@:[\]-]+$/.test(target);
const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65535;
const validHostId = (id: string): boolean => /^[A-Za-z0-9_-]{1,80}$/.test(id);

const runCapture = (
  command: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, timeoutMs);
    const finish = (error?: Error, code?: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise({ code: code ?? 1, stdout, stderr });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_FRAME * 2) {
        child.kill('SIGKILL');
        finish(new Error(`${command} output exceeded limit`));
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(undefined, code));
  });

const parseKey = (line: string): { type: string; key: string } | undefined => {
  const fields = line.trim().split(/\s+/);
  const type = fields.length >= 3 ? fields[1] : fields[0];
  const key = fields.length >= 3 ? fields[2] : fields[1];
  if (!type || !key || !/^[A-Za-z0-9@._+-]+$/.test(type)) return undefined;
  try {
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length < 32 || decoded.toString('base64').replace(/=+$/, '') !== key.replace(/=+$/, ''))
      return undefined;
    return { type, key };
  } catch {
    return undefined;
  }
};

const fingerprint = (key: string): string =>
  `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`;

const checkedHost = (host: RemoteHost, forInstall = false): void => {
  if (!host || !validHostId(host.id) || !validTarget(host.target) || !validPort(host.port)) {
    throw new Error('Invalid remote host configuration');
  }
  if (!host.runnerPath || !host.runnerPath.startsWith('/') || host.runnerPath.includes('\0')) {
    throw new Error('runnerPath must be an absolute path');
  }
  if (forInstall && (host.runnerPath === '/' || /^\/(?:opt|usr|etc|bin|sbin)(?:\/|$)/.test(host.runnerPath))) {
    throw new Error(
      'runnerPath must be in a user-writable location; system paths require manual administrator installation',
    );
  }
  const key = parseKey(host.hostKey);
  if (!key || fingerprint(key.key) !== host.fingerprint)
    throw new Error('Remote host key does not match its fingerprint');
};

const checkPath = (path: string): void => {
  if (!path || !path.startsWith('/') || path.includes('\0')) throw new Error('cwd must be an absolute path');
};

export function RemoteHostService(dataDir: string, options: { configFile?: string } = {}): RemoteHostServiceInstance {
  const knownHostsDir = resolve(dataDir, 'remote-hosts', 'known_hosts');
  const active = new Map<string, Set<RemoteConnection>>();
  const configFile = options.configFile ?? process.env.ADELIC_SSH_CONFIG;
  const configArgs = configFile ? ['-F', configFile] : [];

  const knownHostPath = async (host: RemoteHost): Promise<{ file: string; alias: string }> => {
    checkedHost(host);
    await mkdir(knownHostsDir, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(knownHostsDir);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error('Pinned known_hosts directory must be a private directory');
    }
    await chmod(knownHostsDir, 0o700);
    const file = join(knownHostsDir, host.id);
    const alias = `adelic-${host.id}`;
    const parsed = parseKey(host.hostKey);
    if (!parsed) throw new Error('Invalid pinned host key');
    const contents = `${alias} ${parsed.type} ${parsed.key}\n`;
    try {
      const existing = await readFile(file, 'utf8');
      if (existing !== contents)
        throw new Error('Pinned host key changed; remove the saved host explicitly before trusting a new key');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        try {
          await link(temporary, file);
        } catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
          const concurrent = await readFile(file, 'utf8');
          if (concurrent !== contents)
            throw new Error('Pinned host key changed; remove the saved host explicitly before trusting a new key', {
              cause: createError,
            });
        }
      } finally {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true });
      }
    }
    const fileInfo = await lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
      throw new Error('Pinned known_hosts entry must be a regular file');
    await chmod(file, 0o600);
    return { file, alias };
  };

  const sshArgs = async (host: RemoteHost, remoteCommand?: string): Promise<string[]> => {
    const config = await runCapture('ssh', [...configArgs, '-G', '-p', String(host.port), host.target]);
    if (config.code !== 0)
      throw new Error(`ssh -G failed: ${config.stderr.trim() || 'unable to resolve SSH configuration'}`);
    if (config.stdout.split(/\r?\n/).some((line) => line.toLowerCase().startsWith('setenv '))) {
      throw new Error(
        'SSH SetEnv is configured for this target; remove it before using the credential-free remote runner',
      );
    }
    const known = await knownHostPath(host);
    const args = [
      '-T',
      ...configArgs,
      '-p',
      String(host.port),
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UpdateHostKeys=no',
      '-o',
      'VerifyHostKeyDNS=no',
      '-o',
      `UserKnownHostsFile=${known.file}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      `HostKeyAlias=${known.alias}`,
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'Tunnel=no',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'RemoteCommand=none',
      '-o',
      'RequestTTY=no',
      '-o',
      'StdinNull=no',
      '-o',
      'SessionType=default',
      '-o',
      'SendEnv=ADELIC_REMOTE_TRANSPORT_SENTINEL',
      '-o',
      'SetEnv=ADELIC_REMOTE_TRANSPORT=1',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      host.target,
    ];
    if (remoteCommand) args.push(remoteCommand);
    return args;
  };

  const probe = async (target: string, port?: number): Promise<RemoteProbe> => {
    if (!validTarget(target) || (port !== undefined && !validPort(port))) throw new Error('Invalid SSH target or port');
    const config = await runCapture('ssh', [
      ...configArgs,
      '-G',
      ...(port === undefined ? [] : ['-p', String(port)]),
      target,
    ]);
    if (config.code !== 0)
      throw new Error(`ssh -G failed: ${config.stderr.trim() || 'unable to resolve SSH configuration'}`);
    const hostnameLine = config.stdout.split(/\r?\n/).find((line) => line.toLowerCase().startsWith('hostname '));
    const hostname = hostnameLine?.slice('hostname '.length).trim();
    if (!hostname || !validTarget(hostname))
      throw new Error('SSH configuration did not provide a valid effective hostname');
    const portLine = config.stdout.split(/\r?\n/).find((line) => line.toLowerCase().startsWith('port '));
    const effectivePort = port ?? Number(portLine?.slice('port '.length).trim());
    if (!validPort(effectivePort)) throw new Error('SSH configuration did not provide a valid port');
    const scan = await runCapture('ssh-keyscan', ['-T', '7', '-p', String(effectivePort), hostname], 10000);
    const candidates = scan.stdout
      .split(/\r?\n/)
      .map(parseKey)
      .filter((value): value is { type: string; key: string } => Boolean(value));
    const key = candidates.sort((a, b) => {
      const priority = (type: string): number =>
        type === 'ssh-ed25519' ? 0 : type.startsWith('ecdsa-') ? 1 : type === 'ssh-rsa' ? 2 : 3;
      return priority(a.type) - priority(b.type);
    })[0];
    if (!key)
      throw new Error(`ssh-keyscan found no usable host key${scan.stderr.trim() ? `: ${scan.stderr.trim()}` : ''}`);
    return {
      target,
      port: effectivePort,
      hostname,
      fingerprint: fingerprint(key.key),
      hostKey: `${key.type} ${key.key}`,
    };
  };

  const connect = async (
    host: RemoteHost,
    cwd: string,
    options: { readOnly?: boolean } = {},
  ): Promise<RemoteConnection> => {
    checkedHost(host);
    checkPath(cwd);
    await mkdir(knownHostsDir, { recursive: true, mode: 0o700 });
    const remoteCommand = `env -i PATH=${quote(REMOTE_PATH)} python3 -u ${quote(host.runnerPath)} --root ${quote(cwd)}`;
    const args = await sshArgs(host, remoteCommand);
    const child = spawn('ssh', args, {
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const pending = new Map<string, PendingCall>();
    const cancelled = new Set<string>();
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = '';
    let closed = false;
    let nextId = 0;
    let unregister = (): void => {};

    const failAll = (error: Error): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unregister();
      for (const [id, item] of pending) {
        if (item.abort) item.signal.removeEventListener('abort', item.abort);
        item.reject(error);
        pending.delete(id);
      }
    };
    const writeFrame = (frame: Record<string, unknown>): void => {
      if (closed || child.stdin.destroyed) throw new Error('Remote SSH connection is closed');
      const data = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
      if (data.length > MAX_FRAME) throw new Error('Remote request exceeds frame limit');
      child.stdin.write(data);
    };
    const heartbeat = setInterval(() => {
      try {
        writeFrame({ method: 'heartbeat' });
      } catch (error) {
        failAll(error instanceof Error ? error : new Error(String(error)));
        child.kill('SIGTERM');
      }
    }, 5000);
    heartbeat.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      if (stdoutBuffer.length > MAX_FRAME * 2 && !stdoutBuffer.includes(0x0a)) {
        failAll(new Error('Remote runner sent an oversized frame'));
        child.kill('SIGTERM');
        return;
      }
      while (true) {
        const newline = stdoutBuffer.indexOf(0x0a);
        if (newline < 0) break;
        if (newline + 1 > MAX_FRAME) {
          failAll(new Error('Remote runner sent an oversized frame'));
          child.kill('SIGTERM');
          return;
        }
        const line = stdoutBuffer.subarray(0, newline).toString('utf8');
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        let response: unknown;
        try {
          response = JSON.parse(line);
        } catch {
          failAll(new Error('Remote runner sent invalid JSON'));
          child.kill('SIGTERM');
          return;
        }
        if (!response || typeof response !== 'object' || Array.isArray(response)) {
          failAll(new Error('Remote runner sent an invalid response envelope'));
          child.kill('SIGTERM');
          return;
        }
        const envelope = response as Record<string, unknown>;
        if (typeof envelope.id !== 'string' || typeof envelope.ok !== 'boolean') {
          failAll(new Error('Remote runner sent an invalid response schema'));
          child.kill('SIGTERM');
          return;
        }
        const fields = Object.keys(envelope).sort().join(',');
        const successFields = fields === 'id,ok,result';
        const errorFields = fields === 'error,id,ok' || fields === 'error,errorCategory,id,ok';
        if ((envelope.ok && !successFields) || (!envelope.ok && !errorFields)) {
          failAll(new Error('Remote runner sent an invalid response schema'));
          child.kill('SIGTERM');
          return;
        }
        if (!envelope.ok && typeof envelope.error !== 'string') {
          failAll(new Error('Remote runner sent an invalid response schema'));
          child.kill('SIGTERM');
          return;
        }
        const item = pending.get(envelope.id);
        if (!item) {
          if (cancelled.delete(envelope.id)) continue;
          failAll(new Error('Remote runner sent an unsolicited response'));
          child.kill('SIGTERM');
          return;
        }
        pending.delete(envelope.id);
        if (item.abort) item.signal.removeEventListener('abort', item.abort);
        if (envelope.ok && Object.hasOwn(envelope, 'result')) item.resolve(envelope.result);
        else if (!envelope.ok && typeof envelope.error === 'string') {
          item.reject(reconstructRemoteError(envelope.error, envelope.errorCategory));
        } else {
          item.reject(new Error('Remote runner response did not match its schema'));
          failAll(new Error('Remote runner response did not match its schema'));
          child.kill('SIGTERM');
          return;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once('error', (error) => failAll(error));
    child.once('close', (code, signal) => {
      failAll(
        new Error(`Remote SSH connection closed (${signal ?? code ?? 'unknown'})${stderr ? `: ${stderr.trim()}` : ''}`),
      );
    });

    const request = <T>(method: 'info' | 'call', extra: Record<string, unknown>, signal: AbortSignal): Promise<T> => {
      if (signal.aborted)
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Remote call cancelled'));
      if (closed) return Promise.reject(new Error('Remote SSH connection is closed'));
      const id = `${host.id}-${++nextId}`;
      return new Promise<T>((resolvePromise, reject) => {
        const item: PendingCall = { resolve: resolvePromise, reject, signal };
        item.abort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cancelled.add(id);
          if (cancelled.size > 1024) cancelled.delete(cancelled.values().next().value!);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Remote call cancelled'));
          try {
            writeFrame({ method: 'cancel', id });
          } catch {
            /* connection close rejects remaining calls */
          }
        };
        pending.set(id, item);
        signal.addEventListener('abort', item.abort, { once: true });
        try {
          writeFrame({ id, method, ...extra });
        } catch (error) {
          pending.delete(id);
          signal.removeEventListener('abort', item.abort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };
    const connection: RemoteConnection = {
      call(tool, argsValue, signal) {
        if (!TOOL_NAMES.has(tool)) return Promise.reject(new Error('Unsupported remote tool'));
        if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue))
          return Promise.reject(new Error('Remote tool arguments must be an object'));
        // Enforce policy in the service boundary, independently of caller-provided args
        // and before a request reaches the SSH proxy/runner.
        if (options.readOnly && ['exec', 'write_file', 'replace_text'].includes(tool))
          return Promise.reject(new Error(`${tool} is disabled for a read-only call`));
        // Inspection schemas are strict; only git accepts a readOnly policy bit.
        // Mutating tools were rejected above before reaching the runner.
        const boundedArgs = options.readOnly && tool === 'git' ? { ...argsValue, readOnly: true } : argsValue;
        const requestedTimeout = typeof argsValue.timeoutMs === 'number' ? argsValue.timeoutMs : 300000;
        const deadline = tool === 'exec' ? Math.min(300000, Math.max(1, requestedTimeout)) + 15000 : 30000;
        const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(deadline)]);
        return withObservation('ssh.tool', 'ssh', {}, () =>
          request('call', { tool, args: boundedArgs }, boundedSignal).then((result) =>
            validateRemoteResult(tool, result),
          ),
        );
      },
      info() {
        return request('info', {}, AbortSignal.timeout(5000)).then(validateInfo);
      },
      async close() {
        if (!closed) {
          failAll(new Error('Remote SSH connection closed'));
          child.stdin.end();
          child.kill('SIGTERM');
        }
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()));
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            exited,
            new Promise<void>((resolvePromise) => {
              timer = setTimeout(resolvePromise, 1500);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
          }
        }
      },
    };
    const set = active.get(host.id) ?? new Set<RemoteConnection>();
    set.add(connection);
    active.set(host.id, set);
    unregister = () => {
      set.delete(connection);
      if (set.size === 0 && active.get(host.id) === set) active.delete(host.id);
    };
    return connection;
  };

  const service: RemoteHostServiceInstance = {
    async probe(target, port) {
      return withObservation('ssh.probe', 'ssh', {}, () => probe(target, port));
    },
    async test(host) {
      const connection = await connect(host, '/');
      try {
        const info = await connection.info();
        if (
          info.protocol !== 1 ||
          typeof info.python !== 'string' ||
          typeof info.platform !== 'string' ||
          info.root !== '/'
        ) {
          throw new Error('Remote runner returned an invalid info handshake');
        }
        return info;
      } finally {
        await connection.close();
      }
    },
    async install(host) {
      checkedHost(host, true);
      const installCode =
        "import os,pathlib,sys; p=pathlib.Path(sys.argv[1]); (os.geteuid()==0 and sys.exit('refusing runner installation as root')); p.parent.mkdir(parents=True,exist_ok=True); data=sys.stdin.buffer.read(); t=p.with_name(p.name+'.adelic-tmp'); fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o700); f=os.fdopen(fd,'wb'); f.write(data); f.flush(); os.fsync(f.fileno()); f.close(); os.replace(t,p); os.chmod(p,0o700)";
      const args = await sshArgs(
        host,
        `env -i PATH=${quote(REMOTE_PATH)} python3 -c ${quote(installCode)} ${quote(host.runnerPath)}`,
      );
      const child = spawn('ssh', args, { env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stdout.resume();
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_LIMIT);
      });
      const result = new Promise<void>((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code === 0) resolvePromise();
          else
            reject(
              new Error(`Remote runner installation failed (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ''}`),
            );
        });
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.stdin.on('error', () => {
        /* SSH exit is reported by result. */
      });
      child.stdin.end(REMOTE_RUNNER_SOURCE, 'utf8');
      try {
        await result;
      } finally {
        clearTimeout(timer);
      }
    },
    async connect(host, cwd, options) {
      return withObservation('ssh.connect', 'ssh', {}, () => connect(host, cwd, options));
    },
    async call(host, cwd, tool, args, signal, options) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Remote call cancelled');
      const connection = await connect(host, cwd, options);
      try {
        return await connection.call(tool, args, signal);
      } finally {
        await connection.close();
      }
    },
    async disconnect(hostId) {
      const remaining = active.get(hostId);
      if (remaining) await Promise.all([...remaining].map((connection) => connection.close()));
    },
    async shutdown() {
      const activeConnections = [...active.values()].flatMap((set) => [...set]);
      active.clear();
      await Promise.all(activeConnections.map((connection) => connection.close()));
    },
  };

  return service;
}
