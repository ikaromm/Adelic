import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from '../server/index.js';
import { builtinCommands, expandMessage, listCommands, loadRepoCommands } from '../server/commands.js';
import { migrate, migrations, userVersion } from '../server/migrations.js';
import { Orchestrator } from '../server/orchestrator.js';
import { Store } from '../server/store.js';
import {
  COMMAND_TEMPLATE_MAX,
  REPO_COMMANDS_MAX_FILES,
  commandFieldsError,
  expandTemplate,
  parseSlash,
  runModeFor,
  type SavedCommand,
} from '../shared/commands.js';
import type { Project, ProviderRegistry, RunInput, Session } from '../shared/contracts.js';
import { filterCommands, slashKeyAction, slashQuery } from '../src/hooks/useSlashCommands.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))),
  );
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix = 'adelic-commands-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const now = () => new Date().toISOString();
function saved(over: Partial<SavedCommand> & Pick<SavedCommand, 'name' | 'template'>): SavedCommand {
  return {
    id: `id-${over.name}-${over.projectId ?? 'g'}`,
    description: '',
    projectId: null,
    createdAt: now(),
    updatedAt: now(),
    ...over,
  };
}
function project(store: Store, path: string, id = 'p'): Project {
  // Orchestration off: the provider receives the request directly, which keeps prompts simple.
  return store.putProject({
    id,
    name: `Projeto ${id}`,
    path,
    createdAt: now(),
    memoryWorkspace: 'w',
    memoryProject: id,
    orchestration: { enabled: false, maxWorkers: 1, review: false },
  });
}
function repoFile(root: string, name: string, content: string) {
  const dir = join(root, '.adelic', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

describe('slash parsing and template expansion', () => {
  it('recognises /name only at the very start and splits the arguments', () => {
    expect(parseSlash('/revisar')).toEqual({ name: 'revisar', args: '' });
    expect(parseSlash('/explicar  server/store.ts \n linha 2 ')).toEqual({
      name: 'explicar',
      args: 'server/store.ts \n linha 2',
    });
    expect(parseSlash(' /revisar')).toBeUndefined();
    expect(parseSlash('texto /revisar')).toBeUndefined();
    expect(parseSlash('/Revisar')).toBeUndefined();
    expect(parseSlash('/revisar:agora')).toBeUndefined();
    expect(parseSlash('/')).toBeUndefined();
    expect(parseSlash('/home/user/arquivo')).toBeUndefined();
  });

  it('replaces every {{args}}, and appends arguments when the template has none', () => {
    expect(expandTemplate('Revise {{args}}; depois {{ args }}.', 'a.ts')).toBe('Revise a.ts; depois a.ts.');
    expect(expandTemplate('Revise {{args}}.', '')).toBe('Revise .');
    expect(expandTemplate('Rode os testes.', '')).toBe('Rode os testes.');
    expect(expandTemplate('Rode os testes.', 'só o backend')).toBe('Rode os testes.\n\nsó o backend');
    // `$&` and friends in the arguments are inserted literally.
    expect(expandTemplate('X {{args}}', '$& $1')).toBe('X $& $1');
  });

  it('maps a command mode to a run mode', () => {
    expect(runModeFor(undefined)).toBeUndefined();
    expect(runModeFor('fast')).toBe('fast');
    expect(runModeFor('balanced')).toBe('auto');
    expect(runModeFor('deep')).toBe('deep');
  });

  it('validates fields with the API messages', () => {
    const ok = { name: 'revisar-pr', description: 'x', template: 'y' };
    expect(commandFieldsError(ok)).toBe('');
    expect(commandFieldsError({ ...ok, name: 'Revisar' })).toMatch(/Nome inválido/);
    expect(commandFieldsError({ ...ok, name: '-x' })).toMatch(/Nome inválido/);
    expect(commandFieldsError({ ...ok, name: 'a'.repeat(33) })).toMatch(/Nome inválido/);
    expect(commandFieldsError({ ...ok, description: 'd'.repeat(161) })).toMatch(/Descrição/);
    expect(commandFieldsError({ ...ok, template: '  ' })).toMatch(/Modelo/);
    expect(commandFieldsError({ ...ok, template: 't'.repeat(COMMAND_TEMPLATE_MAX + 1) })).toMatch(/Modelo/);
  });
});

describe('composer suggestions', () => {
  const entries = listCommands({ listCommands: () => [] } as unknown as Store).commands;
  it('opens only while the message is /prefix without a space', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/rev')).toBe('rev');
    expect(slashQuery('/revisar ')).toBeUndefined();
    expect(slashQuery('rev')).toBeUndefined();
  });
  it('filters by name prefix first, then by description', () => {
    expect(filterCommands(entries, '').map((c) => c.name)).toEqual(['explicar', 'revisar', 'testes']);
    // Name matches come first; /revisar follows because its description mentions "testes".
    expect(filterCommands(entries, 'te').map((c) => c.name)).toEqual(['testes', 'revisar']);
    expect(filterCommands(entries, 'exp').map((c) => c.name)).toEqual(['explicar']);
    // "seguranca" matches the description of /revisar (accents ignored).
    expect(filterCommands(entries, 'seguranca').map((c) => c.name)).toEqual(['revisar']);
    expect(filterCommands([{ ...entries[0], active: false }], '')).toEqual([]);
  });
  it('takes Enter, Tab, arrows and Escape only while the list is open', () => {
    const key = (k: string, over = {}) => ({
      key: k,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...over,
    });
    expect(slashKeyAction(key('Enter'), true)).toBe('complete');
    expect(slashKeyAction(key('Tab'), true)).toBe('complete');
    expect(slashKeyAction(key('ArrowDown'), true)).toBe('next');
    expect(slashKeyAction(key('ArrowUp'), true)).toBe('previous');
    expect(slashKeyAction(key('Escape'), true)).toBe('close');
    expect(slashKeyAction(key('Enter'), false)).toBeNull();
    expect(slashKeyAction(key('Enter', { shiftKey: true }), true)).toBeNull();
    expect(slashKeyAction(key('Enter', { ctrlKey: true }), true)).toBeNull();
    expect(slashKeyAction(key('Tab', { shiftKey: true }), true)).toBeNull();
    expect(slashKeyAction({ ...key('Enter'), isComposing: true }, true)).toBeNull();
    expect(slashKeyAction(key('a'), true)).toBeNull();
  });
});

describe('repository command files', () => {
  it('reads front-matter, ignores invalid files with a reason and never leaves the project', () => {
    const root = tempDir();
    const outside = tempDir('adelic-outside-');
    writeFileSync(join(outside, 'segredo.md'), 'fora do projeto');
    repoFile(root, 'deploy-check.md', '---\ndescription: "Confere o deploy"\nmode: fast\n---\nConfira {{args}}.\n');
    repoFile(root, 'simples.md', 'Só o corpo, sem cabeçalho.');
    repoFile(root, 'Maiuscula.md', 'x');
    repoFile(root, 'vazio.md', '---\ndescription: nada\n---\n   \n');
    repoFile(root, 'aberto.md', '---\ndescription: sem fim\ncorpo');
    repoFile(root, 'linha.md', '---\nisto não é chave\n---\ncorpo');
    repoFile(root, 'modo.md', '---\nmode: turbo\n---\ncorpo');
    repoFile(root, 'longa.md', `---\ndescription: ${'d'.repeat(161)}\n---\ncorpo`);
    repoFile(root, 'grande.md', 'x'.repeat(COMMAND_TEMPLATE_MAX + 1));
    repoFile(root, 'nao-md.txt', 'ignorado sem aviso');
    mkdirSync(join(root, '.adelic', 'commands', 'pasta.md'));
    writeFileSync(join(root, 'interno.md'), 'alvo interno');
    symlinkSync(join(root, 'interno.md'), join(root, '.adelic', 'commands', 'interno.md'));
    symlinkSync(join(outside, 'segredo.md'), join(root, '.adelic', 'commands', 'fuga.md'));
    symlinkSync(join(root, 'nao-existe.md'), join(root, '.adelic', 'commands', 'quebrado.md'));

    const { commands, issues } = loadRepoCommands(root);
    expect(commands.map((c) => c.name)).toEqual(['deploy-check', 'interno', 'simples']);
    expect(commands[0]).toMatchObject({
      description: 'Confere o deploy',
      mode: 'fast',
      template: 'Confira {{args}}.',
      source: 'repo',
      readOnly: true,
      file: '.adelic/commands/deploy-check.md',
    });
    expect(commands[1].template).toBe('alvo interno');
    expect(JSON.stringify(commands)).not.toContain('fora do projeto');
    const reasons = Object.fromEntries(issues.map((i) => [i.file.split('/').pop(), i.reason]));
    expect(reasons).toMatchObject({
      'Maiuscula.md': expect.stringMatching(/Nome de arquivo inválido/),
      'vazio.md': 'Modelo vazio',
      'aberto.md': expect.stringMatching(/sem fechamento/),
      'linha.md': expect.stringMatching(/Linha inválida/),
      'modo.md': expect.stringMatching(/mode deve ser/),
      'longa.md': expect.stringMatching(/Descrição/),
      'grande.md': expect.stringMatching(/grande demais/),
      'pasta.md': 'Não é um arquivo comum',
      'fuga.md': 'Link simbólico aponta para fora do projeto',
      'quebrado.md': 'Link simbólico quebrado',
    });
    expect(reasons['nao-md.txt']).toBeUndefined();
  });

  it('caps the number of files and refuses a commands folder that is a symlink out of the project', () => {
    const root = tempDir();
    for (let i = 0; i < REPO_COMMANDS_MAX_FILES + 2; i++) repoFile(root, `c${String(i).padStart(2, '0')}.md`, 'x');
    const capped = loadRepoCommands(root);
    expect(capped.commands).toHaveLength(REPO_COMMANDS_MAX_FILES);
    expect(capped.issues).toHaveLength(2);
    expect(capped.issues[0].reason).toMatch(/limite de 50/);

    const escaping = tempDir();
    const outside = tempDir('adelic-outside-');
    writeFileSync(join(outside, 'x.md'), 'fora');
    mkdirSync(join(escaping, '.adelic'));
    symlinkSync(outside, join(escaping, '.adelic', 'commands'));
    expect(loadRepoCommands(escaping)).toEqual({
      commands: [],
      issues: [{ file: '.adelic/commands', reason: 'A pasta aponta para fora do projeto' }],
    });
    expect(loadRepoCommands(join(escaping, 'nope'))).toEqual({ commands: [], issues: [] });
    const notDir = tempDir();
    mkdirSync(join(notDir, '.adelic'));
    writeFileSync(join(notDir, '.adelic', 'commands'), 'arquivo');
    expect(loadRepoCommands(notDir).issues[0].reason).toBe('Não é uma pasta');
  });
});

describe('precedence and expansion', () => {
  it('project > repository file > global > built-in, and unknown names stay plain text', () => {
    const store = new Store(tempDir());
    try {
      const root = tempDir();
      const p = project(store, root);
      // Same name at every level.
      repoFile(root, 'revisar.md', '---\ndescription: repo\n---\nREPO {{args}}');
      store.putCommand(saved({ name: 'revisar', template: 'GLOBAL {{args}}' }));
      store.putCommand(saved({ name: 'revisar', template: 'PROJETO {{args}}', projectId: p.id }));
      // Repository beats global; global beats built-in.
      repoFile(root, 'testes.md', 'REPO testes');
      store.putCommand(saved({ name: 'testes', template: 'GLOBAL testes' }));
      store.putCommand(saved({ name: 'explicar', template: 'GLOBAL explicar {{args}}', mode: 'fast' }));

      expect(expandMessage(store, '/revisar a.ts', p).prompt).toBe('PROJETO a.ts');
      expect(expandMessage(store, '/testes', p).prompt).toBe('REPO testes');
      expect(expandMessage(store, '/explicar b.ts', p)).toEqual({
        prompt: 'GLOBAL explicar b.ts',
        mode: 'fast',
        command: { name: 'explicar', source: 'global' },
      });
      // Without the project: no project or repository commands.
      expect(expandMessage(store, '/revisar a.ts').prompt).toBe('GLOBAL a.ts');
      expect(expandMessage(store, '/nao-existe x', p)).toEqual({ prompt: '/nao-existe x' });
      expect(expandMessage(store, 'oi', p)).toEqual({ prompt: 'oi' });

      const list = listCommands(store, p).commands.filter((c) => c.name === 'revisar');
      expect(list.map((c) => [c.source, c.active])).toEqual([
        ['project', true],
        ['repo', false],
        ['global', false],
        ['builtin', false],
      ]);
      // Built-in alone, when nothing overrides it.
      store.deleteCommand('id-revisar-g');
      expect(expandMessage(store, '/revisar').prompt).toBe(builtinCommands.find((c) => c.name === 'revisar')!.template);
    } finally {
      store.close();
    }
  });
});

describe('migration 5', () => {
  it('upgrades a version-4 database and cascades commands with their project', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    db.exec('PRAGMA foreign_keys=ON;');
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 4),
    );
    expect(userVersion(db)).toBe(4);
    db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(
      'p',
      JSON.stringify({ id: 'p', name: 'P', path: dir, createdAt: now(), memoryWorkspace: 'w', memoryProject: 'p' }),
    );
    const result = migrate(db, dir);
    expect(result).toMatchObject({ from: 4, applied: [5] });
    expect(result.backupPath).toBeTruthy();
    db.close();

    const store = new Store(dir);
    try {
      store.putCommand(saved({ name: 'a', template: 't', projectId: 'p' }));
      store.putCommand(saved({ name: 'b', template: 't' }));
      expect(store.listCommands('p').map((c) => c.name)).toEqual(['a']);
      store.db.prepare('DELETE FROM projects WHERE id=?').run('p');
      expect(store.listCommands('p')).toEqual([]);
      expect(store.listCommands(null).map((c) => c.name)).toEqual(['b']);
      expect(store.exportData().commands).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

/** Provider that records every input and answers right away (or waits, for queue tests). */
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
          capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true, steer: true },
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
    async steer(_runId, content) {
      inputs.push({ prompt: `STEER:${content}` } as RunInput);
    },
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
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe('commands API and expansion in messages', () => {
  async function serve() {
    const store = new Store(tempDir());
    const root = tempDir();
    const p = project(store, root);
    const session: Session = {
      id: 's',
      projectId: p.id,
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now(),
      updatedAt: now(),
    };
    store.putSession(session);
    store.setSettings({ ...store.getSettings()!, autoRetry: false });
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
    const idle = () => until(() => !orchestrator.isActive('s'));
    return {
      store,
      root,
      project: p,
      orchestrator,
      provider,
      call,
      idle,
      cleanup: () => orchestrator.shutdown().then(() => store.close()),
    };
  }

  it('creates, lists, edits and deletes commands with validation', async () => {
    const t = await serve();
    try {
      const create = (body: unknown) => t.call('POST', '/api/commands', body);
      expect((await create({ name: 'Ruim', template: 'x' })).status).toBe(400);
      expect(await (await create({ name: 'ok', template: ' ' })).json()).toEqual({
        error: 'Modelo obrigatório (até 8000 caracteres)',
      });
      expect((await create({ name: 'ok', template: 'x', mode: 'turbo' })).status).toBe(400);
      expect((await create({ name: 'ok', template: 'x', description: 'd'.repeat(161) })).status).toBe(400);
      expect((await create({ name: 'ok', template: 'x', projectId: 'nope' })).status).toBe(404);

      const global = await create({ name: 'resumo', description: ' Resume ', template: 'Resuma {{args}}' });
      expect(global.status).toBe(201);
      const g = (await global.json()) as SavedCommand;
      expect(g).toMatchObject({ name: 'resumo', description: 'Resume', projectId: null });
      expect((await create({ name: 'resumo', template: 'x' })).status).toBe(409);
      // Same name in a project is fine (it overrides the global one there).
      const local = await create({ name: 'resumo', template: 'Local {{args}}', projectId: t.project.id, mode: 'deep' });
      expect(local.status).toBe(201);
      const l = (await local.json()) as SavedCommand;

      const listed = await (await t.call('GET', `/api/commands?projectId=${t.project.id}`)).json();
      expect(
        listed.commands
          .filter((c: { name: string }) => c.name === 'resumo')
          .map((c: { source: string; active: boolean }) => [c.source, c.active]),
      ).toEqual([
        ['project', true],
        ['global', false],
      ]);
      const globalOnly = await (await t.call('GET', '/api/commands')).json();
      expect(globalOnly.commands.map((c: { name: string }) => c.name)).toEqual([
        'explicar',
        'resumo',
        'revisar',
        'testes',
      ]);
      expect((await t.call('GET', '/api/commands?projectId=nope')).status).toBe(404);

      const edited = await t.call('PATCH', `/api/commands/${l.id}`, { mode: null, template: 'Novo {{args}}' });
      expect(await edited.json()).toMatchObject({ id: l.id, template: 'Novo {{args}}' });
      expect(t.store.getCommand(l.id)?.mode).toBeUndefined();
      expect((await t.call('PATCH', `/api/commands/${l.id}`, { mode: 'fast' })).status).toBe(200);
      expect(t.store.getCommand(l.id)?.mode).toBe('fast');
      expect((await t.call('PATCH', `/api/commands/${l.id}`, { name: 'X' })).status).toBe(400);
      expect((await t.call('PATCH', '/api/commands/missing', { name: 'x' })).status).toBe(404);
      await create({ name: 'outro', template: 'x' });
      expect((await t.call('PATCH', `/api/commands/${g.id}`, { name: 'outro' })).status).toBe(409);

      // The origin guard requires a JSON body on DELETE.
      expect((await t.call('DELETE', `/api/commands/${g.id}`)).status).toBe(415);
      expect((await t.call('DELETE', `/api/commands/${g.id}`, {})).status).toBe(204);
      expect((await t.call('DELETE', `/api/commands/${g.id}`, {})).status).toBe(404);
      expect((await t.call('DELETE', '/api/commands/builtin:revisar', {})).status).toBe(404);
    } finally {
      await t.cleanup();
    }
  });

  it('stores the typed message, sends the expanded template and applies the mode to that run only', async () => {
    const t = await serve();
    try {
      t.store.putCommand(saved({ name: 'fundo', template: 'Analise a fundo: {{args}}', mode: 'deep', projectId: 'p' }));
      const sent = await t.call('POST', '/api/sessions/s/messages', { content: '/fundo server/store.ts' });
      expect(sent.status).toBe(202);
      await t.idle();
      expect(t.provider.inputs[0].prompt).toContain('Analise a fundo: server/store.ts');
      expect(t.provider.inputs[0].prompt).not.toContain('/fundo');
      expect(t.provider.inputs[0].plan.level).toBe('deep');
      const user = t.store.listMessages('s').find((m) => m.role === 'user')!;
      expect(user.content).toBe('/fundo server/store.ts');
      expect(t.store.getSession('s')!.mode).toBe('fast');
      expect(
        t.store.listEvents('s').some((e) => e.text.startsWith('Comando /fundo (do projeto) expandido; modo Completo')),
      ).toBe(true);

      // Unknown command: plain text, conversation mode.
      await t.call('POST', '/api/sessions/s/messages', { content: '/desconhecido x' });
      await t.idle();
      expect(t.provider.inputs[1].prompt).toContain('/desconhecido x');
      expect(t.provider.inputs[1].plan.level).toBe('fast');

      // Repository file, read at send time.
      repoFile(t.root, 'repo-cmd.md', '---\ndescription: d\n---\nDo repositório: {{args}}');
      await t.call('POST', '/api/sessions/s/messages', { content: '/repo-cmd ok' });
      await t.idle();
      expect(t.provider.inputs[2].prompt).toContain('Do repositório: ok');
    } finally {
      await t.cleanup();
    }
  });

  it('expands queued, send-now and steered messages on the server', async () => {
    const t = await serve();
    try {
      t.store.putCommand(saved({ name: 'eco', template: 'ECO[{{args}}]' }));
      t.provider.hold(true);
      await t.call('POST', '/api/sessions/s/messages', { content: 'primeira' });
      await until(() => t.provider.inputs.length === 1);

      const queued = await t.call('POST', '/api/sessions/s/queue', { content: '/eco da fila' });
      expect(queued.status).toBe(201);
      const { item } = await queued.json();
      expect(item.content).toBe('/eco da fila');
      await t.call('POST', `/api/sessions/s/queue/${item.id}/steer`, {});
      expect(t.provider.inputs.at(-1)!.prompt).toBe('STEER:ECO[da fila]');

      await t.call('POST', '/api/sessions/s/queue', { content: '/eco depois' });
      t.provider.release();
      await until(() => t.provider.inputs.length === 3);
      expect(t.provider.inputs[2].prompt).toContain('ECO[depois]');

      const now = await t.call('POST', '/api/sessions/s/send-now', { content: '/eco agora' });
      expect(now.status).toBe(202);
      await until(() => t.provider.inputs.length === 4);
      expect(t.provider.inputs[3].prompt).toContain('ECO[agora]');
      t.provider.hold(false);
      t.provider.release();
      await t.idle();
      const users = t.store
        .listMessages('s')
        .filter((m) => m.role === 'user')
        .map((m) => m.content);
      expect(users).toEqual(['primeira', '/eco depois', '/eco agora']);
    } finally {
      await t.cleanup();
    }
  });

  it('expands only global and built-in commands in a detached conversation', async () => {
    const store = new Store(tempDir());
    try {
      const provider = recordingProvider();
      const orchestrator = new Orchestrator(store, provider.providers, undefined, undefined, undefined, { retries: 0 });
      const session: Session = {
        id: 'd',
        projectId: null,
        title: 'Nova conversa',
        providerId: 'codex',
        mode: 'fast',
        createdAt: now(),
        updatedAt: now(),
      };
      store.putSession(session);
      store.putProject({
        id: 'p',
        name: 'P',
        path: tempDir(),
        createdAt: now(),
        memoryWorkspace: 'w',
        memoryProject: 'p',
      });
      store.putCommand(saved({ name: 'so-projeto', template: 'PROJETO', projectId: 'p' }));
      await orchestrator.start(session, '/explicar o roteador');
      await until(() => !orchestrator.isActive('d'));
      expect(provider.inputs[0].prompt).toContain('Explique o código, arquivo ou área indicados abaixo');
      expect(provider.inputs[0].prompt).toContain('o roteador');
      // The title comes from what the user typed.
      expect(store.getSession('d')!.title).toBe('/explicar o roteador');
      await orchestrator.start(store.getSession('d')!, '/so-projeto');
      await until(() => !orchestrator.isActive('d'));
      expect(provider.inputs.at(-1)!.prompt).toContain('/so-projeto');
      await orchestrator.shutdown();
    } finally {
      store.close();
    }
  });
});
