import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRegistry } from '../shared/contracts.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import {
  checkEngine,
  execRunner,
  parseConfigJson,
  parseConfigText,
  parseEngineCompiled,
  parseInstalledModels,
  parseTranscript,
  pathFinder,
  sniffAudio,
  VoiceService,
  type CommandRunner,
} from '../server/voice.js';
import {
  formatElapsed,
  insertDictation,
  MAX_VOICE_BYTES,
  VOICE_BUSY,
  VOICE_REMOTE_REFUSAL,
  voiceMime,
} from '../shared/voice.js';
import { dictationBlocker, recorderMime } from '../src/hooks/useVoiceDictation.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix = 'adelic-voice-test-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// What voxtype 1.1.0 printed on the development machine (secrets absent there too).
const LOCAL_CONFIG = {
  engine: 'whisper',
  'whisper.mode': 'local',
  'whisper.model': 'large-v3',
  'whisper.remote_endpoint': null,
  'whisper.remote_api_key': null,
};
const MODELS = JSON.stringify({
  engines: {
    whisper: {
      default: 'base.en',
      models: [
        { name: 'tiny', installed: false },
        { name: 'base', installed: true },
        { name: 'large-v3', installed: true },
      ],
    },
  },
});
const ENGINES = JSON.stringify([
  { name: 'whisper', compiled: true, active: true },
  { name: 'parakeet', compiled: false, active: false },
]);
const HELP = 'Options:\n  -q, --quiet\n      --engine <ENGINE>\n      --whisper-mode <MODE>\n';
const TRANSCRIPT =
  'Loading audio file: "out.wav"\nAudio format: 16000 Hz, 1 channel(s), Int\nProcessing 16000 samples (1.00s)...\n\nOlá mundo\n';
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);

interface Call {
  file: string;
  args: string[];
  timeout: number;
}
type Responder = (call: Call) => string | Promise<string> | Error;

/** Fake voxtype/ffmpeg: answers each command from `overrides`, else the local defaults above. */
function fakeRunner(overrides: Partial<Record<string, Responder>> = {}) {
  const calls: Call[] = [];
  const run: CommandRunner = async (file, args, { timeout, signal }) => {
    const call = { file, args, timeout };
    calls.push(call);
    const key = file.endsWith('ffmpeg')
      ? 'ffmpeg'
      : args.includes('transcribe')
        ? 'transcribe'
        : args.slice(0, 2).join(' ') === 'config get'
          ? 'config get'
          : args[0] === 'config'
            ? 'config'
            : args[0] === 'info'
              ? `info ${args[1]}`
              : args[0]!;
    const defaults: Record<string, Responder> = {
      'config get': () => JSON.stringify(LOCAL_CONFIG),
      'info engines': () => ENGINES,
      'info models': () => MODELS,
      '--help': () => HELP,
      ffmpeg: () => '',
      transcribe: () => TRANSCRIPT,
    };
    const responder = overrides[key] ?? defaults[key];
    if (!responder) throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const out = await responder(call);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { run, calls };
}
const allFound = async (name: string) => `/usr/bin/${name}`;

describe('voxtype output parsing', () => {
  it('reads the JSON config and the text config of older versions', () => {
    expect(parseConfigJson(JSON.stringify(LOCAL_CONFIG))?.['whisper.mode']).toBe('local');
    expect(parseConfigJson('not json')).toBeUndefined();
    expect(parseConfigJson('[1,2]')).toBeUndefined();
    expect(parseConfigJson('{"audio.device":"default"}')).toBeUndefined();
    const text = parseConfigText(
      'Current Configuration\n\n\u001b[1m[engine]\u001b[0m\n  engine = Whisper\n\n[whisper]\n  model = "large-v3"\n  mode = Remote\n  language = Single("pt")\n',
    );
    expect(text).toMatchObject({ engine: 'Whisper', 'whisper.model': 'large-v3', 'whisper.mode': 'Remote' });
    expect(parseConfigText('nothing here')).toBeUndefined();
  });

  it('accepts only local engines and modes, refusing remote backends', () => {
    expect(checkEngine(LOCAL_CONFIG)).toEqual({ ok: true, engine: 'whisper', model: 'large-v3', whisperMode: 'local' });
    expect(checkEngine({ ...LOCAL_CONFIG, 'whisper.mode': 'cli' })).toMatchObject({ ok: true, whisperMode: 'cli' });
    expect(checkEngine({ engine: 'Parakeet', 'parakeet.model': 'parakeet-tdt-0.6b-v3' })).toMatchObject({
      ok: true,
      engine: 'parakeet',
    });
    const refused = { ok: false, reason: VOICE_REMOTE_REFUSAL };
    expect(checkEngine({ ...LOCAL_CONFIG, 'whisper.mode': 'remote' })).toEqual(refused);
    expect(checkEngine({ ...LOCAL_CONFIG, 'whisper.mode': ' Remote ' })).toEqual(refused);
    expect(checkEngine({ engine: 'whisper', 'whisper.remote_endpoint': 'http://example.invalid/v1' })).toEqual(refused);
    expect(checkEngine({ engine: 'soniox' })).toEqual(refused);
    // Unknown engines or modes are not assumed to be local.
    expect(checkEngine({ engine: 'whisper' })).toMatchObject({ ok: false });
    expect(checkEngine({ ...LOCAL_CONFIG, 'whisper.mode': 'cloud' })).toMatchObject({ ok: false });
    expect(checkEngine({ engine: 'deepgram' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('deepgram'),
    });
    expect(checkEngine({})).toMatchObject({ ok: false });
  });

  it('lists installed models from JSON or text, and compiled engines', () => {
    expect(parseInstalledModels(MODELS, 'whisper')).toEqual(['base', 'large-v3']);
    expect(parseInstalledModels(MODELS, 'parakeet')).toBeUndefined();
    const text = 'Model catalog  (/x)\n\nwhisper\n             tiny\n  installed  base\n\nparakeet\n             p1\n';
    expect(parseInstalledModels(text, 'whisper')).toEqual(['base']);
    expect(parseInstalledModels(text, 'parakeet')).toEqual([]);
    expect(parseInstalledModels(text, 'moonshine')).toBeUndefined();
    expect(parseEngineCompiled(ENGINES, 'whisper')).toBe(true);
    expect(parseEngineCompiled(ENGINES, 'parakeet')).toBe(false);
    expect(parseEngineCompiled('text', 'whisper')).toBeUndefined();
    expect(parseEngineCompiled('{}', 'whisper')).toBeUndefined();
  });

  it('keeps only the transcript from voxtype output', () => {
    expect(parseTranscript(TRANSCRIPT)).toBe('Olá mundo');
    expect(parseTranscript('Loading audio file: "x"\n\n')).toBe('');
  });

  it('checks the audio container signature', () => {
    expect(sniffAudio(WEBM, 'audio/webm')).toBe(true);
    expect(sniffAudio(Buffer.from('OggS\0\0\0\0'), 'audio/ogg')).toBe(true);
    expect(sniffAudio(Buffer.from('\0\0\0\x1cftypM4A '), 'audio/mp4')).toBe(true);
    expect(sniffAudio(Buffer.from('#EXTM3U\nhttp://x'), 'audio/webm')).toBe(false);
    expect(sniffAudio(WEBM, 'audio/ogg')).toBe(false);
  });
});

describe('voice status', () => {
  it('reports the local engine and model when everything is installed', async () => {
    const { run } = fakeRunner();
    expect(await new VoiceService({ run, find: allFound }).status()).toEqual({
      available: true,
      engine: 'whisper',
      model: 'large-v3',
    });
  });

  it('explains missing binaries', async () => {
    const { run } = fakeRunner();
    const without = (missing: string) =>
      new VoiceService({ run, find: async (n) => (n === missing ? undefined : `/x/${n}`) });
    expect(await without('voxtype').status()).toMatchObject({
      available: false,
      reason: expect.stringContaining('voxtype não encontrado'),
    });
    expect(await without('ffmpeg').status()).toMatchObject({
      available: false,
      reason: expect.stringContaining('ffmpeg não encontrado'),
    });
  });

  it('refuses a remote backend before anything else', async () => {
    const { run, calls } = fakeRunner({
      'config get': () =>
        JSON.stringify({
          ...LOCAL_CONFIG,
          'whisper.mode': 'remote',
          'whisper.remote_endpoint': 'https://api.example.invalid',
        }),
    });
    expect(await new VoiceService({ run, find: allFound }).status()).toEqual({
      available: false,
      reason: VOICE_REMOTE_REFUSAL,
    });
    expect(calls.some((c) => c.args.includes('transcribe'))).toBe(false);
  });

  it('falls back to the text config when `config get --json` is not supported', async () => {
    const { run } = fakeRunner({
      'config get': () => new Error('unrecognized subcommand'),
      config: () => '[engine]\n  engine = Whisper\n\n[whisper]\n  model = "base"\n',
    });
    // Old text output without a mode: local cannot be confirmed, so it stays unavailable.
    expect(await new VoiceService({ run, find: allFound }).status()).toMatchObject({
      available: false,
      reason: expect.stringContaining('modelo local'),
    });
    const both = fakeRunner({ 'config get': () => new Error('x'), config: () => new Error('x') });
    expect(await new VoiceService({ run: both.run, find: allFound }).status()).toMatchObject({
      reason: expect.stringContaining('configuração'),
    });
  });

  it('requires an installed model of a compiled engine', async () => {
    const none = fakeRunner({
      'info models': () => JSON.stringify({ engines: { whisper: { models: [{ name: 'base', installed: false }] } } }),
    });
    expect(await new VoiceService({ run: none.run, find: allFound }).status()).toMatchObject({
      available: false,
      reason: expect.stringContaining('nenhum modelo local'),
    });
    const other = fakeRunner({ 'config get': () => JSON.stringify({ ...LOCAL_CONFIG, 'whisper.model': 'medium' }) });
    expect(await new VoiceService({ run: other.run, find: allFound }).status()).toMatchObject({
      reason: expect.stringContaining('medium'),
    });
    const unlisted = fakeRunner({ 'info models': () => new Error('x') });
    expect(await new VoiceService({ run: unlisted.run, find: allFound }).status()).toMatchObject({
      reason: expect.stringContaining('listar os modelos'),
    });
    const notCompiled = fakeRunner({ 'info engines': () => JSON.stringify([{ name: 'whisper', compiled: false }]) });
    expect(await new VoiceService({ run: notCompiled.run, find: allFound }).status()).toMatchObject({
      reason: expect.stringContaining('não está compilado'),
    });
  });

  it('accepts an absolute model path only when the file exists', async () => {
    const dir = tempDir();
    const absolute = fakeRunner({ 'config get': () => JSON.stringify({ ...LOCAL_CONFIG, 'whisper.model': dir }) });
    expect(await new VoiceService({ run: absolute.run, find: allFound }).status()).toEqual({
      available: true,
      engine: 'whisper',
      model: 'modelo local',
    });
    const missing = fakeRunner({
      'config get': () => JSON.stringify({ ...LOCAL_CONFIG, 'whisper.model': join(dir, 'nope.bin') }),
    });
    expect(await new VoiceService({ run: missing.run, find: allFound }).status()).toMatchObject({
      reason: expect.stringContaining('não existe'),
    });
  });

  it('caches the status for a short time', async () => {
    const { run, calls } = fakeRunner();
    const service = new VoiceService({ run, find: allFound, statusTtlMs: 60_000 });
    await service.status();
    const count = calls.length;
    await service.status();
    expect(calls.length).toBe(count);
  });
});

describe('transcription pipeline', () => {
  it('converts with ffmpeg, transcribes with the verified local engine and cleans up', async () => {
    const root = tempDir();
    let seenDir = '';
    const { run, calls } = fakeRunner({
      ffmpeg: (call) => {
        const input = call.args[call.args.indexOf('-i') + 1]!;
        seenDir = join(input, '..');
        expect(statSync(seenDir).mode & 0o777).toBe(0o700);
        expect(statSync(input).mode & 0o777).toBe(0o600);
        return '';
      },
    });
    const service = new VoiceService({ run, find: allFound, tmpRoot: root });
    expect(await service.transcribe(WEBM, 'audio/webm')).toEqual({ text: 'Olá mundo' });
    const ffmpeg = calls.find((c) => c.file.endsWith('ffmpeg'))!;
    expect(ffmpeg.timeout).toBe(60_000);
    expect(ffmpeg.args).toEqual(
      expect.arrayContaining([
        '-nostdin',
        '-y',
        '-protocol_whitelist',
        'file',
        '-f',
        'webm',
        '-ac',
        '1',
        '-ar',
        '16000',
      ]),
    );
    expect(ffmpeg.args.at(-1)).toBe(join(seenDir, 'out.wav'));
    const voxtype = calls.find((c) => c.args.includes('transcribe'))!;
    expect(voxtype.timeout).toBe(120_000);
    expect(voxtype.args).toEqual([
      '-q',
      '--engine',
      'whisper',
      '--whisper-mode',
      'local',
      'transcribe',
      join(seenDir, 'out.wav'),
    ]);
    expect(existsSync(seenDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('omits flags this voxtype does not have', async () => {
    const { run, calls } = fakeRunner({ '--help': () => 'Usage: voxtype' });
    await new VoiceService({ run, find: allFound, tmpRoot: tempDir() }).transcribe(WEBM, 'audio/webm');
    expect(calls.find((c) => c.args.includes('transcribe'))!.args).toEqual([
      'transcribe',
      expect.stringMatching(/out\.wav$/),
    ]);
  });

  it('re-checks the engine before transcribing and refuses a remote one', async () => {
    let mode = 'local';
    const { run, calls } = fakeRunner({
      'config get': () => JSON.stringify({ ...LOCAL_CONFIG, 'whisper.mode': mode }),
    });
    const root = tempDir();
    const service = new VoiceService({ run, find: allFound, tmpRoot: root, statusTtlMs: 60_000 });
    expect((await service.status()).available).toBe(true);
    mode = 'remote';
    await expect(service.transcribe(WEBM, 'audio/webm')).rejects.toMatchObject({
      status: 503,
      message: VOICE_REMOTE_REFUSAL,
    });
    expect(calls.some((c) => c.file.endsWith('ffmpeg'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('cleans up after a conversion failure, a transcription failure and a timeout', async () => {
    const root = tempDir();
    const failing = fakeRunner({
      ffmpeg: () => Object.assign(new Error('exit 1'), { stderr: 'x\nInvalid data found' }),
    });
    await expect(
      new VoiceService({ run: failing.run, find: allFound, tmpRoot: root }).transcribe(WEBM, 'audio/webm'),
    ).rejects.toMatchObject({
      status: 502,
      message: 'Não foi possível converter o áudio: Invalid data found',
    });
    const broken = fakeRunner({ transcribe: () => new Error('exit 1') });
    await expect(
      new VoiceService({ run: broken.run, find: allFound, tmpRoot: root }).transcribe(WEBM, 'audio/webm'),
    ).rejects.toMatchObject({
      status: 502,
      message: 'O voxtype não conseguiu transcrever o áudio',
    });
    const slow = fakeRunner({
      transcribe: () => Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL' }),
    });
    await expect(
      new VoiceService({ run: slow.run, find: allFound, tmpRoot: root }).transcribe(WEBM, 'audio/webm'),
    ).rejects.toMatchObject({
      status: 504,
    });
    const slowFfmpeg = fakeRunner({ ffmpeg: () => Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
    await expect(
      new VoiceService({ run: slowFfmpeg.run, find: allFound, tmpRoot: root }).transcribe(WEBM, 'audio/webm'),
    ).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining('60 s'),
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('stops on abort and cleans up', async () => {
    const root = tempDir();
    const controller = new AbortController();
    const { run } = fakeRunner({
      ffmpeg: () => {
        controller.abort();
        return Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    });
    await expect(
      new VoiceService({ run, find: allFound, tmpRoot: root }).transcribe(WEBM, 'audio/webm', controller.signal),
    ).rejects.toMatchObject({
      status: 499,
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('runs one transcription at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { run } = fakeRunner({ transcribe: async () => (await gate, TRANSCRIPT) });
    const service = new VoiceService({ run, find: allFound, tmpRoot: tempDir() });
    const first = service.transcribe(WEBM, 'audio/webm');
    await expect(service.transcribe(WEBM, 'audio/webm')).rejects.toMatchObject({ status: 409, message: VOICE_BUSY });
    expect(service.transcribing).toBe(true);
    release();
    await expect(first).resolves.toEqual({ text: 'Olá mundo' });
    expect(service.transcribing).toBe(false);
    await expect(service.transcribe(WEBM, 'audio/webm')).resolves.toEqual({ text: 'Olá mundo' });
  });
});

describe('default runner and finder', () => {
  it('runs a binary without a shell and reports timeouts as killed', async () => {
    expect(
      (await execRunner(process.execPath, ['-e', 'process.stdout.write("ok $HOME")'], { timeout: 5000 })).stdout,
    ).toMatch(/^ok /);
    await expect(
      execRunner(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeout: 100 }),
    ).rejects.toMatchObject({ killed: true });
    await expect(
      execRunner(process.execPath, ['-e', 'console.error("bad");process.exit(3)'], { timeout: 5000 }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('bad'),
    });
  });

  it('does not pass transcription API keys to child processes', async () => {
    const saved = process.env.VOXTYPE_WHISPER_API_KEY;
    process.env.VOXTYPE_WHISPER_API_KEY = 'secret-for-test';
    try {
      const { stdout } = await execRunner(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.VOXTYPE_WHISPER_API_KEY))'],
        { timeout: 5000 },
      );
      expect(stdout).toBe('undefined');
    } finally {
      if (saved === undefined) delete process.env.VOXTYPE_WHISPER_API_KEY;
      else process.env.VOXTYPE_WHISPER_API_KEY = saved;
    }
  });

  it('finds executables on PATH', async () => {
    const saved = process.env.PATH;
    process.env.PATH = ['', '/nonexistent-dir', join(process.execPath, '..')].join(':');
    try {
      expect(await pathFinder('node')).toBe(process.execPath.replace(/\/[^/]+$/, '/node'));
      expect(await pathFinder('definitely-not-a-binary-xyz')).toBeUndefined();
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('dictation helpers', () => {
  it('normalises accepted audio types', () => {
    expect(voiceMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(voiceMime(' AUDIO/OGG ')).toBe('audio/ogg');
    expect(voiceMime('video/webm')).toBeUndefined();
    expect(voiceMime('audio/wav')).toBeUndefined();
  });

  it('inserts at the caret with spacing only where needed', () => {
    expect(insertDictation('', 0, 0, ' olá ')).toEqual({ value: 'olá', caret: 3 });
    expect(insertDictation('ab', 1, 1, 'X')).toEqual({ value: 'a X b', caret: 3 });
    expect(insertDictation('a ', 2, 2, 'X')).toEqual({ value: 'a X', caret: 3 });
    expect(insertDictation('trocar isto aqui', 7, 11, 'aquilo')).toEqual({ value: 'trocar aquilo aqui', caret: 13 });
    expect(insertDictation('abc', 99, 99, 'd')).toEqual({ value: 'abc d', caret: 5 });
    expect(insertDictation('abc', 1, 1, '  ')).toEqual({ value: 'abc', caret: 1 });
  });

  it('formats the timer and picks a recordable type', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65.9)).toBe('1:05');
    expect(formatElapsed(-3)).toBe('0:00');
    expect(recorderMime((m) => m.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(recorderMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
    expect(recorderMime(() => false)).toBeUndefined();
  });

  it('explains why the button is disabled', () => {
    const ok = { secure: true, media: true, recorder: true };
    expect(dictationBlocker(undefined, ok)).toContain('Verificando');
    expect(dictationBlocker({ available: false, reason: 'motivo' }, ok)).toBe('motivo');
    expect(dictationBlocker({ available: true }, { ...ok, secure: false })).toBe(
      'O microfone exige HTTPS ou localhost',
    );
    expect(dictationBlocker({ available: true }, { ...ok, recorder: false })).toContain('gravar áudio');
    expect(dictationBlocker({ available: true }, ok)).toBeUndefined();
  });
});

describe('transcribe routes', () => {
  const providers: ProviderRegistry = {
    async list() {
      return [];
    },
    async run() {
      return { text: '', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  async function setup(run: CommandRunner = fakeRunner().run) {
    const store = new Store(tempDir());
    const voice = new VoiceService({ run, find: allFound, tmpRoot: tempDir() });
    const { app } = createBackend(store, providers, undefined, undefined, undefined, voice);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    return { base, post, store };
  }
  const audio = (bytes = WEBM, mime = 'audio/webm;codecs=opus') => ({ mime, data: bytes.toString('base64') });

  it('reports status and transcribes an accepted recording', async () => {
    const { base, post } = await setup();
    expect(await (await fetch(`${base}/api/transcribe/status`)).json()).toEqual({
      available: true,
      engine: 'whisper',
      model: 'large-v3',
    });
    const res = await post(audio());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Olá mundo' });
  });

  it('accepts only audio types whose bytes match', async () => {
    const { post } = await setup();
    expect((await post(audio(WEBM, 'video/webm'))).status).toBe(415);
    expect((await post(audio(WEBM, 'text/plain'))).status).toBe(415);
    expect((await post(audio(Buffer.from('#EXTM3U\nhttp://x/a'), 'audio/webm'))).status).toBe(415);
    expect((await post({ mime: 'audio/webm', data: '' })).status).toBe(400);
    expect((await post({ mime: 'audio/webm', data: 'não é base64' })).status).toBe(400);
    expect((await post({ mime: 'audio/webm', data: '====' })).status).toBe(400);
    expect((await post('{bad json')).status).toBe(400);
  });

  it('limits the upload to 8 MB', async () => {
    const { post } = await setup();
    const big = Buffer.concat([WEBM, Buffer.alloc(MAX_VOICE_BYTES)]);
    const res = await post(audio(big));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('8 MB');
    const huge = await post({ mime: 'audio/webm', data: 'A'.repeat(12 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    // Other routes keep the small global limit.
    const other = await fetch(`${(await setup()).base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(200 * 1024) }),
    });
    expect(other.status).toBe(400);
  });

  it('answers 409 while another transcription runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { post } = await setup(fakeRunner({ transcribe: async () => (await gate, TRANSCRIPT) }).run);
    const first = post(audio());
    await new Promise((r) => setTimeout(r, 100));
    const second = await post(audio());
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe(VOICE_BUSY);
    release();
    expect((await first).status).toBe(200);
  });

  it('refuses a remote engine and respects the setting', async () => {
    const remote = await setup(
      fakeRunner({ 'config get': () => JSON.stringify({ ...LOCAL_CONFIG, 'whisper.mode': 'remote' }) }).run,
    );
    const res = await remote.post(audio());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(VOICE_REMOTE_REFUSAL);

    const { post, store } = await setup();
    store.setSettings({ ...store.getSettings()!, voiceDictation: false });
    expect((await post(audio())).status).toBe(403);
  });

  it('stays behind the loopback origin guard', async () => {
    const { post } = await setup();
    expect((await post(audio(), { origin: 'https://evil.example' })).status).toBe(403);
    const plain = await post('x', { 'content-type': 'text/plain' });
    expect(plain.status).toBe(415);
  });
});

// Optional: the real voxtype and ffmpeg of this machine (ADELIC_VOICE_INTEGRATION=1). Skipped
// by default and in CI; it needs a local model and can take a minute with large models.
describe.skipIf(process.env.ADELIC_VOICE_INTEGRATION !== '1')('real voxtype (opt-in)', () => {
  it('transcribes a generated tone through ffmpeg and voxtype', async () => {
    const service = new VoiceService({ tmpRoot: tempDir() });
    const status = await service.status();
    expect(status, status.reason).toMatchObject({ available: true });
    const dir = tempDir();
    const file = join(dir, 'tone.webm');
    await execRunner(
      '/usr/bin/ffmpeg',
      [
        '-nostdin',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:a',
        'libopus',
        file,
      ],
      { timeout: 30_000 },
    );
    const { readFile } = await import('node:fs/promises');
    const result = await service.transcribe(await readFile(file), 'audio/webm');
    expect(typeof result.text).toBe('string');
  }, 180_000);
});
