import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import {
  FILE_LIST_LIMITS,
  clearFileCache,
  listProjectFiles,
  resolveMentions,
  searchProjectFiles,
  walkFiles,
} from '../server/mentions.js';
import { Store } from '../server/store.js';
import {
  activeMention,
  findMentions,
  formatMention,
  mentionSegments,
  parseMentions,
  rankFiles,
} from '../shared/mentions.js';
import { ProjectFilesQuerySchema, parseBody } from '../shared/schemas.js';
import type { Project, ProviderRegistry, RunInput, Session } from '../shared/contracts.js';
import { insertMention } from '../src/hooks/useFileMentions.js';
import { gitIn } from './git-fixtures.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  clearFileCache();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))),
  );
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix = 'adelic-mentions-') => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
function write(root: string, path: string, content: string | Buffer = 'x\n') {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}
const now = () => new Date().toISOString();

describe('mention parsing', () => {
  it('finds @path and @"quoted path" at the start or after whitespace, deduped in order', () => {
    expect(parseMentions('@src/App.tsx e @"docs/a b.md"\n@src/App.tsx')).toEqual(['src/App.tsx', 'docs/a b.md']);
    expect(findMentions('veja @a.ts')).toEqual([{ start: 5, end: 10, path: 'a.ts' }]);
    // Closing quote included in the token.
    expect(findMentions('@"a b.txt" fim')[0]).toEqual({ start: 0, end: 10, path: 'a b.txt' });
  });

  it('ignores e-mails, a bare @, code spans and fenced code', () => {
    expect(parseMentions('fale com dev@example.com ou x@y')).toEqual([]);
    expect(parseMentions('só @ sozinho e @"" vazio')).toEqual([]);
    expect(parseMentions('use `@nao.ts` aqui e @sim.ts')).toEqual(['sim.ts']);
    expect(parseMentions('```\n@dentro.ts\n```\n@fora.ts')).toEqual(['fora.ts']);
    expect(parseMentions('```\n@nunca-fechado.ts')).toEqual([]);
  });

  it('drops sentence punctuation after an unquoted path, and overlong paths', () => {
    expect(parseMentions('leia @a.ts, depois @b.md. E (@c.json)')).toEqual(['a.ts', 'b.md']);
    expect(parseMentions('(@c.json)')).toEqual([]);
    expect(parseMentions(`@${'a'.repeat(1025)}`)).toEqual([]);
  });

  it('splits a message into text and mention segments without changing it', () => {
    const content = 'veja @src/a.ts e @"b c.md".';
    const segments = mentionSegments(content);
    expect(segments.map((s) => s.text).join('')).toBe(content);
    expect(segments.filter((s) => s.mention).map((s) => [s.text, s.mention])).toEqual([
      ['@src/a.ts', 'src/a.ts'],
      ['@"b c.md"', 'b c.md'],
    ]);
    expect(mentionSegments('sem menções')).toEqual([{ text: 'sem menções' }]);
  });

  it('detects the mention being typed before the caret', () => {
    expect(activeMention('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMention('olá @src/ap', 11)).toEqual({ start: 4, query: 'src/ap' });
    expect(activeMention('olá @"a b', 9)).toEqual({ start: 4, query: 'a b' });
    expect(activeMention('dev@ex', 6)).toBeUndefined();
    expect(activeMention('@a.ts ', 6)).toBeUndefined();
    expect(activeMention('@src/app depois', 4)).toEqual({ start: 0, query: 'src' });
  });

  it('formats and inserts the chosen path, quoting spaces', () => {
    expect(formatMention('src/App.tsx')).toBe('@src/App.tsx');
    expect(formatMention('a b.txt')).toBe('@"a b.txt"');
    expect(insertMention('olá @src/ap', 4, 11, 'src/App.tsx')).toEqual({ value: 'olá @src/App.tsx ', caret: 17 });
    // Caret in the middle of the token: the rest of it is replaced, the next word kept.
    expect(insertMention('@sr/x depois', 0, 3, 'a b.txt')).toEqual({ value: '@"a b.txt" depois', caret: 11 });
  });
});

describe('file ranking', () => {
  const files = [
    'src/App.tsx',
    'server/app.ts',
    'docs/apps/readme.md',
    'src/components/Chat.tsx',
    'tests/xapp.test.ts',
  ];
  it('basename prefix > basename substring > path substring > subsequence, stable', () => {
    // Same tier and length (src/App.tsx, server/app.ts): listing order.
    expect(rankFiles(files, 'app')).toEqual([
      'src/App.tsx',
      'server/app.ts',
      'tests/xapp.test.ts',
      'docs/apps/readme.md',
    ]);
    expect(rankFiles(files, 'src/app')).toEqual(['src/App.tsx']);
    expect(rankFiles(files, 'scc')).toEqual(['src/components/Chat.tsx']);
    expect(rankFiles(files, 'zzz')).toEqual([]);
    expect(rankFiles(['b/x.ts', 'a.ts', 'c/d/e.ts'], '')).toEqual(['a.ts', 'b/x.ts', 'c/d/e.ts']);
    // Equal tier and length: listing order.
    expect(rankFiles(['b/ab.ts', 'a/ab.ts'], 'ab')).toEqual(['b/ab.ts', 'a/ab.ts']);
  });
});

describe('project file listing', () => {
  it('walks a plain folder, skipping heavy and hidden folders and never following symlinks', async () => {
    const root = tempDir();
    const outside = tempDir();
    write(outside, 'secret.txt');
    write(root, 'README.md');
    write(root, 'src/a.ts');
    write(root, 'node_modules/pkg/index.js');
    write(root, 'dist/out.js');
    write(root, 'build/out.js');
    write(root, '.git/config');
    write(root, '.cache/x');
    write(root, '.env');
    symlinkSync(outside, join(root, 'link-dir'));
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const listing = await listProjectFiles(root);
    expect(listing).toEqual({ files: ['.env', 'README.md', 'src/a.ts'], truncated: false, source: 'walk' });
  });

  it('caps the walk by entries and depth', async () => {
    const root = tempDir();
    for (let i = 0; i < 5; i++) write(root, `f${i}.txt`);
    write(root, 'a/b/c/deep.txt');
    // Sorted walk: a, a/b, a/b/c, then the 4th entry passes the cap.
    expect(await walkFiles(root, { ...FILE_LIST_LIMITS, entries: 3 })).toEqual({ files: [], truncated: true });
    expect(await walkFiles(root, { ...FILE_LIST_LIMITS, entries: 6 })).toEqual({
      files: ['a/b/c/deep.txt', 'f0.txt', 'f1.txt'],
      truncated: true,
    });
    const shallow = await walkFiles(root, { ...FILE_LIST_LIMITS, depth: 2 });
    expect(shallow.truncated).toBe(true);
    expect(shallow.files).not.toContain('a/b/c/deep.txt');
    expect((await walkFiles(root)).files).toContain('a/b/c/deep.txt');
  });

  it('uses git ls-files in a repository: tracked and untracked, without ignored files', async () => {
    const root = tempDir();
    gitIn(root, 'init', '-q', '-b', 'main');
    write(root, '.gitignore', 'ignored.log\nnode_modules/\n');
    write(root, 'tracked.ts');
    write(root, 'pasta com espaço/é.md');
    gitIn(root, 'add', '-A');
    write(root, 'untracked.ts');
    write(root, 'ignored.log');
    write(root, 'node_modules/x.js');
    const listing = await listProjectFiles(root);
    expect(listing.source).toBe('git');
    expect(listing.files.sort()).toEqual(['.gitignore', 'pasta com espaço/é.md', 'tracked.ts', 'untracked.ts']);
    // A project below the repository top lists its subtree, relative to it.
    clearFileCache();
    expect((await listProjectFiles(join(root, 'pasta com espaço'))).files).toEqual(['é.md']);
  });

  it('caches a listing per project for about ten seconds', async () => {
    const root = tempDir();
    write(root, 'a.txt');
    let t = 1_000;
    const opts = { now: () => t };
    expect((await listProjectFiles(root, opts)).files).toEqual(['a.txt']);
    write(root, 'b.txt');
    t += 5_000;
    expect((await listProjectFiles(root, opts)).files).toEqual(['a.txt']);
    t += 6_000;
    expect((await listProjectFiles(root, opts)).files).toEqual(['a.txt', 'b.txt']);
  });

  it('searches with the ranking and reports more matches than the limit as truncated', async () => {
    const root = tempDir();
    for (const name of ['app.ts', 'App.tsx', 'other.md']) write(root, name);
    expect(await searchProjectFiles(root, 'app', 1)).toEqual({ files: ['app.ts'], truncated: true });
    expect(await searchProjectFiles(root, ' other ', 50)).toEqual({ files: ['other.md'], truncated: false });
  });
});

describe('mention resolution', () => {
  it('inlines mentioned UTF-8 files in a fence and reports what was ignored', async () => {
    const root = tempDir();
    write(root, 'src/a.ts', 'const a = "```";\n');
    write(root, 'a b.md', '# título\n');
    const result = await resolveMentions(root, ['src/a.ts', 'a b.md', 'src/a.ts', 'falta.ts']);
    expect(result.included).toEqual(['src/a.ts', 'a b.md']);
    expect(result.text).toBe(
      '\n\n[Arquivo mencionado: src/a.ts]\n````\nconst a = "```";\n\n````\n\n[Arquivo mencionado: a b.md]\n```\n# título\n\n```',
    );
    expect(result.ignored).toEqual([{ path: 'falta.ts', reason: 'arquivo não encontrado' }]);
    expect(await resolveMentions(root, [])).toEqual({ text: '', included: [], ignored: [] });
  });

  it('refuses traversal, absolute paths and symlinks that leave the project', async () => {
    const parent = tempDir();
    const root = join(parent, 'projeto');
    write(root, 'ok.txt', 'ok');
    write(parent, 'fora.txt', 'segredo');
    symlinkSync(join(parent, 'fora.txt'), join(root, 'link-fora.txt'));
    symlinkSync(parent, join(root, 'dir-fora'));
    symlinkSync(join(root, 'ok.txt'), join(root, 'link-dentro.txt'));
    const result = await resolveMentions(root, [
      '../fora.txt',
      'sub/../../fora.txt',
      join(parent, 'fora.txt'),
      '~/fora.txt',
      'C:/fora.txt',
      'a\\b.txt',
      'link-fora.txt',
      'dir-fora/fora.txt',
      'link-dentro.txt',
    ]);
    expect(result.included).toEqual(['link-dentro.txt']);
    expect(result.text).not.toContain('segredo');
    expect(result.ignored.map((i) => i.reason)).toEqual(Array(8).fill('fora do projeto'));
  });

  it('skips folders, binary and non-UTF-8 files, and enforces the size caps', async () => {
    const root = tempDir();
    write(root, 'pasta/x.txt');
    write(root, 'bin.dat', Buffer.from([0x41, 0x00, 0x42]));
    write(root, 'latin1.txt', Buffer.from([0x63, 0xe9]));
    write(root, 'grande.txt', 'a'.repeat(512 * 1024 + 1));
    for (const n of [1, 2, 3]) write(root, `m${n}.txt`, 'b'.repeat(400 * 1024));
    const result = await resolveMentions(root, [
      'pasta',
      'bin.dat',
      'latin1.txt',
      'grande.txt',
      'm1.txt',
      'm2.txt',
      'm3.txt',
    ]);
    expect(result.included).toEqual(['m1.txt', 'm2.txt']);
    expect(Object.fromEntries(result.ignored.map((i) => [i.path, i.reason]))).toEqual({
      pasta: 'não é um arquivo',
      'bin.dat': 'arquivo binário',
      'latin1.txt': 'não é texto UTF-8',
      'grande.txt': 'maior que 512 KB',
      'm3.txt': 'limite total de 1 MB por mensagem',
    });
  });

  it('inlines at most five files per message and fails softly without the project folder', async () => {
    const root = tempDir();
    const names = [1, 2, 3, 4, 5, 6].map((n) => `f${n}.txt`);
    for (const name of names) write(root, name, name);
    const result = await resolveMentions(root, names);
    expect(result.included).toEqual(names.slice(0, 5));
    expect(result.ignored).toEqual([{ path: 'f6.txt', reason: 'limite de 5 arquivos por mensagem' }]);
    expect((await resolveMentions(join(root, 'nao-existe'), ['a.txt'])).ignored).toEqual([
      { path: 'a.txt', reason: 'pasta do projeto indisponível' },
    ]);
  });
});

/** Provider that records every input; can hold runs open for the queue tests. */
function recordingProvider() {
  const inputs: RunInput[] = [];
  const gates: (() => void)[] = [];
  let hold = false;
  const providers: ProviderRegistry = {
    async list() {
      return [
        {
          id: 'codex',
          name: 'Stub',
          installed: true,
          available: true,
          status: 'ready',
          detail: '',
          models: [{ id: 'm', name: 'm', isDefault: true }],
          defaultModel: 'm',
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
        },
      ];
    },
    async run(input, emit, signal) {
      inputs.push(input);
      if (hold)
        await new Promise<void>((resolve) => {
          gates.push(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      emit({ type: 'delta', text: 'ok' });
      return { text: 'ok', stopReason: signal.aborted ? 'cancelled' : 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  return {
    providers,
    inputs,
    hold(value: boolean) {
      hold = value;
    },
    release() {
      for (const g of gates.splice(0)) g();
    },
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe('files route and mentions in messages', () => {
  async function serve(orchestration = false) {
    const store = new Store(tempDir());
    const root = tempDir();
    write(root, 'src/App.tsx', 'export const App = 1;\n');
    write(root, 'notas da equipe.md', 'nota\n');
    const project: Project = store.putProject({
      id: 'p',
      name: 'P',
      path: root,
      createdAt: now(),
      memoryWorkspace: 'w',
      memoryProject: 'p',
      orchestration: { enabled: orchestration, maxWorkers: 1, review: false },
      graphify: { enabled: false },
    });
    const session: Session = {
      id: 's',
      projectId: project.id,
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now(),
      updatedAt: now(),
    };
    store.putSession(session);
    store.setSettings({ ...store.getSettings()!, autoRetry: false, memoryEnabled: false });
    const provider = recordingProvider();
    const { app, orchestrator } = createBackend(store, provider.providers);
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', origin: base },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return {
      store,
      root,
      orchestrator,
      provider,
      call,
      idle: () => until(() => !orchestrator.isActive('s')),
      cleanup: () => orchestrator.shutdown().then(() => store.close()),
    };
  }

  it('validates the files query and lists ranked relative paths', async () => {
    const t = await serve();
    try {
      expect((await t.call('GET', '/api/projects/nope/files')).status).toBe(404);
      expect(await (await t.call('GET', '/api/projects/p/files?limit=0')).json()).toEqual({
        error: 'limit deve ser um inteiro de 1 a 200',
      });
      expect((await t.call('GET', '/api/projects/p/files?limit=abc')).status).toBe(400);
      expect((await t.call('GET', `/api/projects/p/files?query=${'a'.repeat(1025)}`)).status).toBe(400);
      expect((await t.call('GET', '/api/projects/p/files?query=a&query=b')).status).toBe(400);
      expect(await (await t.call('GET', '/api/projects/p/files?query=src%2Fapp')).json()).toEqual({
        files: ['src/App.tsx'],
        truncated: false,
      });
      expect(await (await t.call('GET', '/api/projects/p/files?limit=1')).json()).toEqual({
        files: ['notas da equipe.md'],
        truncated: true,
      });
      rmSync(t.root, { recursive: true, force: true });
      clearFileCache();
      expect((await t.call('GET', '/api/projects/p/files')).status).toBe(409);
    } finally {
      await t.cleanup();
    }
  });

  it('defaults the query schema to an empty query and 50 results', () => {
    expect(parseBody(ProjectFilesQuerySchema, {}, 'x')).toEqual({ ok: true, data: { query: '', limit: 50 } });
    expect(parseBody(ProjectFilesQuerySchema, { limit: '200' }, 'x')).toMatchObject({ ok: true, data: { limit: 200 } });
    expect(parseBody(ProjectFilesQuerySchema, { limit: '201' }, 'x')).toMatchObject({ ok: false });
  });

  it('inlines mentioned files in the prompt only and records ignored mentions', async () => {
    const t = await serve();
    try {
      const content = 'explique @src/App.tsx e @"notas da equipe.md", não @../fora.txt nem @falta.ts';
      expect((await t.call('POST', '/api/sessions/s/messages', { content })).status).toBe(202);
      await t.idle();
      const prompt = t.provider.inputs[0].prompt;
      expect(prompt).toContain('[Arquivo mencionado: src/App.tsx]\n```\nexport const App = 1;\n\n```');
      expect(prompt).toContain('[Arquivo mencionado: notas da equipe.md]');
      expect(prompt).not.toContain('[Arquivo mencionado: falta.ts]');
      const user = t.store.listMessages('s').find((m) => m.role === 'user')!;
      expect(user.content).toBe(content);
      const events = t.store.listEvents('s').map((e) => e.text);
      expect(events).toContain('Arquivos mencionados incluídos: src/App.tsx, notas da equipe.md');
      expect(events).toContain('Menção ignorada: ../fora.txt (fora do projeto)');
      expect(events).toContain('Menção ignorada: falta.ts (arquivo não encontrado)');
    } finally {
      await t.cleanup();
    }
  });

  it('applies to queued, send-now and saved-command messages, and coordinated runs', async () => {
    const t = await serve(true);
    try {
      t.provider.hold(true);
      await t.call('POST', '/api/sessions/s/messages', { content: 'primeira' });
      await until(() => t.provider.inputs.length === 1);
      const queued = await t.call('POST', '/api/sessions/s/queue', { content: 'da fila @src/App.tsx' });
      expect(queued.status).toBe(201);
      t.provider.release();
      await until(() => t.provider.inputs.length === 2);
      expect(t.provider.inputs[1].prompt).toContain('[Arquivo mencionado: src/App.tsx]');

      await t.call('POST', '/api/sessions/s/send-now', { content: 'agora @"notas da equipe.md"' });
      await until(() => t.provider.inputs.length === 3);
      expect(t.provider.inputs[2].prompt).toContain('[Arquivo mencionado: notas da equipe.md]');
      t.provider.hold(false);
      t.provider.release();
      await t.idle();

      await t.call('POST', '/api/sessions/s/messages', { content: '/explicar @src/App.tsx' });
      await t.idle();
      const last = t.provider.inputs.at(-1)!.prompt;
      expect(last).toContain('Explique o código');
      expect(last).toContain('[Arquivo mencionado: src/App.tsx]');
    } finally {
      await t.cleanup();
    }
  });

  it('gives the mentioned files to a planning run', async () => {
    const t = await serve();
    try {
      await t.call('POST', '/api/sessions/s/messages', { content: '/plano refatore @src/App.tsx' });
      await t.idle();
      const input = t.provider.inputs[0];
      expect(input.sandbox).toBe('read-only');
      expect(input.prompt).toContain('[Arquivo mencionado: src/App.tsx]');
    } finally {
      await t.cleanup();
    }
  });
});
