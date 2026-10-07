// Local voice dictation (docs/specs/voice.md). The composer records audio in the browser and
// uploads it here; ffmpeg converts it to 16 kHz mono WAV and voxtype transcribes it with a
// model installed on this machine. Before every transcription the voxtype configuration is
// read and anything that is not a local engine is refused, so audio never leaves the machine
// through Adelic. Commands run with execFile (no shell) through an injectable runner.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { VOICE_BUSY, VOICE_REMOTE_REFUSAL, type VoiceMime, type VoiceStatus } from '../shared/voice.js';

export interface RunOptions {
  timeout: number;
  signal?: AbortSignal;
}
/** Runs a binary without a shell; rejects on a non-zero exit, a timeout (`killed`) or an abort. */
export type CommandRunner = (file: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>;
/** Absolute path of an executable, or undefined when it is not installed. */
export type BinaryFinder = (name: string) => Promise<string | undefined>;

export const FFMPEG_TIMEOUT_MS = 60_000;
export const VOXTYPE_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 10_000;

/** Engines that run a model on this machine (voxtype 1.1 `voxtype info engines`). */
export const LOCAL_ENGINES = new Set([
  'whisper',
  'parakeet',
  'moonshine',
  'sensevoice',
  'paraformer',
  'dolphin',
  'omnilingual',
  'cohere',
  'openvino',
]);
/** Engines that send audio to a hosted API. */
const REMOTE_ENGINES = new Set(['soniox']);
/** Whisper modes that keep audio local: in-process (`local`) or the whisper-cli subprocess (`cli`). */
const LOCAL_WHISPER_MODES = new Set(['local', 'cli']);
// Credentials a remote backend could pick up from the environment; never handed to voxtype.
const SECRET_ENV = /^(VOXTYPE_.*(KEY|TOKEN)|SONIOX_.*|OPENAI_.*)$/i;

const DEMUXER: Record<VoiceMime, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4' };
const EXTENSION: Record<VoiceMime, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

const unavailable = (reason: string): VoiceStatus => ({ available: false, reason });

/** Error carrying the HTTP status the route answers with. */
export class VoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True when the first bytes match the declared container (EBML, OggS or an ISO BMFF `ftyp` box). */
export function sniffAudio(bytes: Buffer, mime: VoiceMime) {
  if (mime === 'audio/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'audio/ogg') return bytes.subarray(0, 4).toString('latin1') === 'OggS';
  return bytes.subarray(4, 8).toString('latin1') === 'ftyp';
}

type ConfigMap = Record<string, unknown>;
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : undefined);
const present = (value: unknown) => value !== undefined && value !== null && value !== '';

/** `voxtype config get --json`: a flat object of dotted keys. Undefined when it is not one. */
export function parseConfigJson(stdout: string): ConfigMap | undefined {
  try {
    const data = JSON.parse(stdout) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
    return typeof (data as ConfigMap).engine === 'string' ? (data as ConfigMap) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fallback for the human-readable `voxtype config` (older versions without `config get`):
 * `[section]` headers and `key = value` lines become dotted keys. `[engine] engine` is `engine`.
 */
export function parseConfigText(stdout: string): ConfigMap | undefined {
  const map: ConfigMap = {};
  let section = '';
  for (const raw of stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(raw);
    if (header) {
      section = header[1]!.trim().toLowerCase();
      continue;
    }
    const pair = /^\s+([a-z_]+)\s*=\s*(.*?)\s*$/i.exec(raw);
    if (!pair || !section) continue;
    const value = pair[2]!.replace(/^"(.*)"$/, '$1');
    const key = section === 'engine' && pair[1] === 'engine' ? 'engine' : `${section}.${pair[1]}`;
    map[key] = value;
  }
  return typeof map.engine === 'string' ? map : undefined;
}

export type EngineCheck =
  { ok: true; engine: string; model?: string; whisperMode?: string } | { ok: false; reason: string };

/** Decides from the resolved configuration whether transcription stays on this machine. */
export function checkEngine(config: ConfigMap): EngineCheck {
  const engine = lower(config.engine);
  if (!engine) return { ok: false, reason: 'Ditado indisponível: não foi possível ler o motor do voxtype' };
  if (REMOTE_ENGINES.has(engine)) return { ok: false, reason: VOICE_REMOTE_REFUSAL };
  if (!LOCAL_ENGINES.has(engine))
    return { ok: false, reason: `Ditado indisponível: motor do voxtype não reconhecido (${engine.slice(0, 40)})` };
  const model = typeof config[`${engine}.model`] === 'string' ? (config[`${engine}.model`] as string) : undefined;
  if (engine !== 'whisper') return { ok: true, engine, model };
  const mode = lower(config['whisper.mode'] ?? config['whisper.backend']);
  // A remote mode, or a remote endpoint with an unconfirmed mode, means an OpenAI-compatible API.
  if (mode === 'remote' || mode === 'api' || (!mode && present(config['whisper.remote_endpoint'])))
    return { ok: false, reason: VOICE_REMOTE_REFUSAL };
  if (!mode || !LOCAL_WHISPER_MODES.has(mode))
    return {
      ok: false,
      reason: 'Ditado indisponível: não foi possível confirmar que o voxtype usa um modelo local',
    };
  return { ok: true, engine, model, whisperMode: mode };
}

/** Installed model names of `engine`, from `voxtype info models --json` or its text listing. */
export function parseInstalledModels(stdout: string, engine: string): string[] | undefined {
  try {
    const data = JSON.parse(stdout) as { engines?: Record<string, { models?: unknown }> };
    const models = data.engines?.[engine]?.models;
    if (!Array.isArray(models)) return undefined;
    return models
      .filter((m): m is { name: string; installed: true } => m?.installed === true && typeof m.name === 'string')
      .map((m) => m.name);
  } catch {
    // Text listing: an engine name alone on a line, then "  installed  <name>" rows.
    const installed: string[] = [];
    let current = '';
    let seen = false;
    for (const line of stdout.split('\n')) {
      if (/^[a-z][\w-]*\s*$/.test(line)) {
        current = line.trim();
        seen ||= current === engine;
        continue;
      }
      const row = /^\s*installed\s+(\S+)/.exec(line);
      if (row && current === engine) installed.push(row[1]!);
    }
    return seen ? installed : undefined;
  }
}

/** Whether `engine` is compiled into this voxtype; undefined when the listing cannot be read. */
export function parseEngineCompiled(stdout: string, engine: string): boolean | undefined {
  try {
    const data = JSON.parse(stdout) as unknown;
    if (!Array.isArray(data)) return undefined;
    const entry = data.find((e: { name?: unknown }) => e?.name === engine) as { compiled?: unknown } | undefined;
    return typeof entry?.compiled === 'boolean' ? entry.compiled : undefined;
  } catch {
    return undefined;
  }
}

/** Transcript from `voxtype transcribe` stdout, without its progress lines. */
export function parseTranscript(stdout: string) {
  return stdout
    .split('\n')
    .filter((line) => !/^(Loading audio file:|Audio format:|Processing \d+ samples)/.test(line.trim()))
    .join('\n')
    .trim();
}

const runtimeEnv = () => {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const [key, value] of Object.entries(process.env)) if (!SECRET_ENV.test(key)) env[key] = value;
  env.NO_COLOR = '1';
  return env;
};

export const execRunner: CommandRunner = (file, args, { timeout, signal }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, signal, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: runtimeEnv(), encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) return reject(Object.assign(error, { stderr: String(stderr ?? '') }));
        resolve({ stdout: String(stdout) });
      },
    );
  });

export const pathFinder: BinaryFinder = async (name) => {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
};

interface Ready {
  status: VoiceStatus;
  voxtype?: string;
  ffmpeg?: string;
  args?: string[];
}

export interface VoiceServiceOptions {
  run?: CommandRunner;
  find?: BinaryFinder;
  /** Parent of the private per-transcription folders (default: the system temp dir). */
  tmpRoot?: string;
  /** How long GET /api/transcribe/status reuses a result; transcriptions always re-check. */
  statusTtlMs?: number;
}

/** Status checks and the one-at-a-time transcription pipeline of one server. */
export class VoiceService {
  private readonly run: CommandRunner;
  private readonly find: BinaryFinder;
  private readonly tmpRoot: string;
  private readonly statusTtlMs: number;
  private cached?: { at: number; ready: Promise<Ready> };
  private busy = false;

  constructor(options: VoiceServiceOptions = {}) {
    this.run = options.run ?? execRunner;
    this.find = options.find ?? pathFinder;
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.statusTtlMs = options.statusTtlMs ?? 10_000;
  }

  get transcribing() {
    return this.busy;
  }

  async status(): Promise<VoiceStatus> {
    if (!this.cached || Date.now() - this.cached.at > this.statusTtlMs)
      this.cached = { at: Date.now(), ready: this.inspect() };
    return (await this.cached.ready).status;
  }

  private async query(binary: string, args: string[]) {
    try {
      return (await this.run(binary, args, { timeout: QUERY_TIMEOUT_MS })).stdout;
    } catch {
      return undefined;
    }
  }

  /** Reads the voxtype setup and builds the transcription arguments, or explains why not. */
  private async inspect(): Promise<Ready> {
    const [voxtype, ffmpeg] = await Promise.all([this.find('voxtype'), this.find('ffmpeg')]);
    if (!voxtype) return { status: unavailable('Ditado indisponível: voxtype não encontrado no PATH') };
    if (!ffmpeg) return { status: unavailable('Ditado indisponível: ffmpeg não encontrado no PATH') };
    const json = await this.query(voxtype, ['config', 'get', '--json']);
    let config = json === undefined ? undefined : parseConfigJson(json);
    if (!config) {
      const text = await this.query(voxtype, ['config']);
      config = text === undefined ? undefined : parseConfigText(text);
    }
    if (!config) return { status: unavailable('Ditado indisponível: não foi possível ler a configuração do voxtype') };
    const engine = checkEngine(config);
    if (!engine.ok) return { status: unavailable(engine.reason) };

    const [engines, models, help] = await Promise.all([
      this.query(voxtype, ['info', 'engines', '--json']),
      this.query(voxtype, ['info', 'models', '--json', '--engine', engine.engine]),
      this.query(voxtype, ['--help']),
    ]);
    if (engines !== undefined && parseEngineCompiled(engines, engine.engine) === false)
      return { status: unavailable(`Ditado indisponível: o motor ${engine.engine} não está compilado neste voxtype`) };
    const installed = models === undefined ? undefined : parseInstalledModels(models, engine.engine);
    if (engine.model && isAbsolute(engine.model)) {
      const exists = await stat(engine.model).then(
        (s) => s.isFile() || s.isDirectory(),
        () => false,
      );
      if (!exists) return { status: unavailable('Ditado indisponível: o arquivo de modelo do voxtype não existe') };
    } else if (!installed) {
      return { status: unavailable('Ditado indisponível: não foi possível listar os modelos do voxtype') };
    } else if (!installed.length) {
      return {
        status: unavailable('Ditado indisponível: nenhum modelo local do voxtype instalado (voxtype setup model)'),
      };
    } else if (engine.model && !installed.includes(engine.model)) {
      return {
        status: unavailable(`Ditado indisponível: o modelo ${engine.model.slice(0, 60)} do voxtype não está instalado`),
      };
    }

    // The verified engine and local mode are passed explicitly, so a later config change
    // between this check and the run cannot switch to a remote backend.
    const flags = help ?? '';
    const args = [
      ...(/--quiet\b/.test(flags) ? ['-q'] : []),
      ...(/--engine\b/.test(flags) ? ['--engine', engine.engine] : []),
      ...(engine.whisperMode && /--whisper-mode\b/.test(flags) ? ['--whisper-mode', engine.whisperMode] : []),
    ];
    const model = engine.model && isAbsolute(engine.model) ? 'modelo local' : engine.model;
    return { status: { available: true, engine: engine.engine, ...(model ? { model } : {}) }, voxtype, ffmpeg, args };
  }

  /**
   * Converts and transcribes one recording. Only one runs at a time (409 otherwise); the
   * private temp folder is removed whatever happens.
   */
  async transcribe(audio: Buffer, mime: VoiceMime, signal?: AbortSignal): Promise<{ text: string }> {
    if (this.busy) throw new VoiceError(409, VOICE_BUSY);
    this.busy = true;
    let dir: string | undefined;
    try {
      this.cached = { at: Date.now(), ready: this.inspect() };
      const ready = await this.cached.ready;
      if (!ready.status.available || !ready.voxtype || !ready.ffmpeg || !ready.args)
        throw new VoiceError(503, ready.status.reason ?? 'Ditado indisponível');
      dir = await mkdtemp(join(this.tmpRoot, 'adelic-voice-'));
      await chmod(dir, 0o700);
      const input = join(dir, `in.${EXTENSION[mime]}`);
      const output = join(dir, 'out.wav');
      await writeFile(input, audio, { mode: 0o600 });
      await this.step(
        ready.ffmpeg,
        [
          ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'],
          // Local files only, with the demuxer of the declared type (no playlists or URLs).
          ...['-protocol_whitelist', 'file', '-f', DEMUXER[mime], '-i', input],
          ...['-vn', '-ac', '1', '-ar', '16000', '-t', '130', output],
        ],
        FFMPEG_TIMEOUT_MS,
        signal,
        'Não foi possível converter o áudio',
        'A conversão do áudio passou de 60 s',
      );
      const { stdout } = await this.step(
        ready.voxtype,
        [...ready.args, 'transcribe', output],
        VOXTYPE_TIMEOUT_MS,
        signal,
        'O voxtype não conseguiu transcrever o áudio',
        'A transcrição passou de 120 s',
      );
      return { text: parseTranscript(stdout) };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.busy = false;
    }
  }

  private async step(
    binary: string,
    args: string[],
    timeout: number,
    signal: AbortSignal | undefined,
    failure: string,
    timedOut: string,
  ) {
    if (signal?.aborted) throw new VoiceError(499, 'Ditado cancelado');
    try {
      return await this.run(binary, args, { timeout, signal });
    } catch (e) {
      const err = e as { name?: string; killed?: boolean; code?: unknown; stderr?: string };
      if (signal?.aborted || err.name === 'AbortError') throw new VoiceError(499, 'Ditado cancelado');
      if (err.killed || err.code === 'ETIMEDOUT') throw new VoiceError(504, timedOut);
      const detail = (err.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 200);
      throw new VoiceError(502, detail ? `${failure}: ${detail}` : failure);
    }
  }
}
