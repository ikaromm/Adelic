import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderInfo, ProviderRegistry, RunInput, Session } from '../shared/contracts.js';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { migrate, migrations, userVersion } from '../server/migrations.js';
import { checkAttachment, MAX_IMAGE_BYTES, sniffImage } from '../shared/attachments.js';
import { decodeUpload, inlineTextAttachment } from '../server/attachments.js';
import { SendMessageSchema, parseBody } from '../shared/schemas.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-attachments-'));
  dirs.push(dir);
  return dir;
};

const provider = (id: ProviderInfo['id'], images: boolean): ProviderInfo => ({
  id,
  name: id,
  installed: true,
  available: true,
  status: 'ready',
  detail: 'test',
  models: [{ id: 'm1', name: 'm1', isDefault: true }],
  defaultModel: 'm1',
  capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true, images },
});

async function setup() {
  const dir = tempDir();
  const store = new Store(dir);
  const inputs: RunInput[] = [];
  const providers: ProviderRegistry = {
    async list() {
      return [provider('codex', true), provider('claude', false)];
    },
    async run(input, emit) {
      inputs.push(input);
      emit({ type: 'delta', text: 'ok' });
      return { text: 'ok', stopReason: 'completed' };
    },
    async approve() {},
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const now = new Date().toISOString();
  const session = (id: string, extra: Partial<Session> = {}) =>
    store.putSession({
      id,
      projectId: null,
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    });
  const upload = (sessionId: string, name: string, bytes: Buffer, mime = '') =>
    post(`/api/sessions/${sessionId}/attachments`, { name, mime, data: bytes.toString('base64') });
  const settle = async (sessionId: string) => {
    for (let i = 0; i < 200; i++) {
      if (!orchestrator.isActive(sessionId) && !store.getSession(sessionId)?.activeRunId) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run did not finish');
  };
  return { dir, store, base, inputs, session, post, upload, settle };
}

describe('attachment rules', () => {
  it('accepts the listed image types and text files and rejects the rest with Portuguese messages', () => {
    expect(checkAttachment('a.png', 'image/png', 10)).toMatchObject({ ok: true, kind: 'image', mime: 'image/png' });
    expect(checkAttachment('foto.JPG', '', 10)).toMatchObject({ ok: true, kind: 'image', mime: 'image/jpeg' });
    expect(checkAttachment('src/app.tsx', '', 10)).toMatchObject({ ok: true, kind: 'text' });
    expect(checkAttachment('Dockerfile', '', 10)).toMatchObject({ ok: true, kind: 'text' });
    expect(checkAttachment('a.png', 'image/png', MAX_IMAGE_BYTES + 1)).toMatchObject({ ok: false });
    expect(checkAttachment('a.txt', 'text/plain', 512 * 1024 + 1)).toEqual({
      ok: false,
      message: '“a.txt” passa de 512 KB, o limite para arquivos de texto.',
    });
    expect(checkAttachment('a.svg', 'image/svg+xml', 10)).toMatchObject({
      ok: false,
      message: /PNG, JPEG, WebP ou GIF/,
    });
    expect(checkAttachment('a.pdf', 'application/pdf', 10)).toMatchObject({
      ok: false,
      message: /não é um tipo aceito/,
    });
  });

  it('checks the real content: image signatures and UTF-8 text', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(decodeUpload('x.png', 'image/png', Buffer.from('not an image').toString('base64'))).toMatchObject({
      ok: false,
      message: /não é uma imagem/,
    });
    // A JPEG renamed to .png is stored with its real type.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    expect(decodeUpload('x.png', 'image/png', jpeg.toString('base64'))).toMatchObject({ ok: true, mime: 'image/jpeg' });
    expect(decodeUpload('a.txt', '', Buffer.from([0xc3, 0x28]).toString('base64'))).toMatchObject({
      ok: false,
      message: /UTF-8/,
    });
    expect(decodeUpload('a.txt', '', Buffer.from('a\u0000b').toString('base64'))).toMatchObject({ ok: false });
  });

  it('inlines text files in a fence the content cannot close', () => {
    const block = inlineTextAttachment('n.md', 'antes\n```\ndepois');
    expect(block.startsWith('[Arquivo anexado: n.md]\n````\n')).toBe(true);
    expect(block.endsWith('\n````')).toBe(true);
  });

  it('validates attachmentIds: at most five, unique, well formed', () => {
    const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const ok = parseBody(SendMessageSchema, { content: 'x', attachmentIds: [id(1), id(2)] }, 'fallback');
    expect(ok).toMatchObject({ ok: true, data: { attachmentIds: [id(1), id(2)] } });
    for (const attachmentIds of [[1, 2, 3, 4, 5, 6].map(id), [id(1), id(1)], ['../x'], 'abc'])
      expect(parseBody(SendMessageSchema, { content: 'x', attachmentIds }, 'fallback')).toEqual({
        ok: false,
        message: 'attachmentIds inválido (até 5 anexos, sem repetição)',
      });
  });
});

describe('migration 3: attachments table', () => {
  it('adds the table to a version 2 database, with cascade from sessions', () => {
    const dir = tempDir();
    const db = new DatabaseSync(join(dir, 'adelic.sqlite'));
    db.exec('PRAGMA foreign_keys=ON;');
    migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 2),
    );
    expect(userVersion(db)).toBe(2);
    db.exec(`INSERT INTO sessions(id,project_id,data) VALUES('s',NULL,'{}');`);
    const result = migrate(
      db,
      dir,
      migrations.filter((m) => m.version <= 3),
    );
    expect(result).toMatchObject({ from: 2, to: 3, applied: [3] });
    expect(result.backupPath).toBeTruthy();
    db.exec(`INSERT INTO attachments(id,session_id,data) VALUES('a','s','{}');`);
    expect(() => db.exec(`INSERT INTO attachments(id,session_id,data) VALUES('b','missing','{}');`)).toThrow();
    db.exec(`DELETE FROM sessions WHERE id='s';`);
    expect(db.prepare('SELECT COUNT(*) n FROM attachments').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('attachment routes', () => {
  it('stores uploads privately, serves only known ids and removes the files with the conversation', async () => {
    const t = await setup();
    t.session('s1');
    const response = await t.upload('s1', 'tela de teste.png', PNG, 'image/png');
    expect(response.status).toBe(201);
    const meta = (await response.json()) as { id: string; name: string; mime: string; size: number };
    expect(meta).toEqual({ id: expect.any(String), name: 'tela de teste.png', mime: 'image/png', size: PNG.length });
    const folder = join(t.dir, 'attachments', 's1');
    const [file] = readdirSync(folder);
    expect(file).toBe(`${meta.id}-tela_de_teste.png`);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, file!)).mode & 0o777).toBe(0o600);

    const served = await fetch(`${t.base}/api/attachments/${meta.id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
    expect((await fetch(`${t.base}/api/attachments/..%2F..%2Fadelic.sqlite`)).status).toBe(404);
    expect((await fetch(`${t.base}/api/attachments/00000000-0000-4000-8000-000000000000`)).status).toBe(404);

    const deleted = await fetch(`${t.base}/api/sessions/s1`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', origin: t.base },
      body: '{}',
    });
    expect(deleted.status).toBe(204);
    expect(existsSync(folder)).toBe(false);
    expect(t.store.getAttachment(meta.id)).toBeUndefined();
    expect((await fetch(`${t.base}/api/attachments/${meta.id}`)).status).toBe(404);
  });

  it('rejects invalid uploads, oversized bodies and unknown conversations', async () => {
    const t = await setup();
    t.session('s1');
    const exe = await t.upload('s1', 'a.exe', Buffer.from('MZ'));
    expect(exe.status).toBe(400);
    expect(((await exe.json()) as { error: string }).error).toMatch(/não é um tipo aceito/);
    const big = await t.upload('s1', 'a.txt', Buffer.alloc(512 * 1024 + 1, 'a'));
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toMatch(/512 KB/);
    const huge = await t.post('/api/sessions/s1/attachments', { name: 'a.png', data: 'A'.repeat(16 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect((await t.upload('nope', 'a.txt', Buffer.from('x'))).status).toBe(404);
    // The larger limit applies only to the upload route.
    expect((await t.post('/api/sessions/s1/messages', { content: 'x'.repeat(200 * 1024) })).status).toBe(400);
  });

  it('passes images as files and inlines text files; refuses ids from another conversation', async () => {
    const t = await setup();
    t.session('s1');
    t.session('s2');
    const image = (await (await t.upload('s1', 'a.png', PNG)).json()) as { id: string };
    const text = (await (await t.upload('s1', 'notas.md', Buffer.from('linha do anexo'))).json()) as { id: string };
    const foreign = (await (await t.upload('s2', 'b.txt', Buffer.from('outro'))).json()) as { id: string };

    const refused = await t.post('/api/sessions/s1/messages', { content: 'oi', attachmentIds: [foreign.id] });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/não encontrado nesta conversa/);
    expect(t.store.listMessages('s1')).toEqual([]);

    const sent = await t.post('/api/sessions/s1/messages', { content: 'veja', attachmentIds: [image.id, text.id] });
    expect(sent.status).toBe(202);
    await t.settle('s1');
    const user = t.store.listMessages('s1').find((m) => m.role === 'user')!;
    expect(user.attachments).toEqual([
      { id: image.id, name: 'a.png', mime: 'image/png', size: PNG.length },
      { id: text.id, name: 'notas.md', mime: 'text/plain', size: 14 },
    ]);
    // Orchestration is on by default: the fast path runs one worker with the user request.
    expect(t.inputs).toHaveLength(1);
    expect(t.inputs[0]!.attachments).toEqual([
      { path: t.store.attachmentPath(t.store.getAttachment(image.id)!), name: 'a.png', mime: 'image/png' },
    ]);
    expect(t.inputs[0]!.prompt).toContain('[Arquivo anexado: notas.md]\n```\nlinha do anexo\n```');
  });

  it('coordinated runs give the attachments to the planner and workers, only the names to review and synthesis', async () => {
    const t = await setup();
    t.session('s1', { mode: 'deep' });
    const image = (await (await t.upload('s1', 'diagrama.png', PNG)).json()) as { id: string };
    const text = (await (await t.upload('s1', 'spec.md', Buffer.from('requisito X'))).json()) as { id: string };
    const sent = await t.post('/api/sessions/s1/messages', {
      content: 'compare as opções e recomende a melhor',
      attachmentIds: [image.id, text.id],
    });
    expect(sent.status).toBe(202);
    await t.settle('s1');
    const roles = t.store.listSessionTasks('s1').reverse();
    expect(roles.map((task) => task.role)).toEqual(['planner', 'worker', 'reviewer', 'synthesis']);
    const [planner, worker, reviewer, synthesis] = t.inputs;
    for (const input of [planner!, worker!]) {
      expect(input.attachments?.map((a) => a.name)).toEqual(['diagrama.png']);
      expect(input.prompt).toContain('[Arquivo anexado: spec.md]');
    }
    for (const input of [reviewer!, synthesis!]) {
      expect(input.attachments).toBeUndefined();
      expect(input.prompt).not.toContain('requisito X');
      expect(input.prompt).toContain(
        'Imagens anexadas pelo usuário (vistas pelo planejador e pelos executores): diagrama.png',
      );
    }
  });

  it('fails before starting when the provider does not accept images', async () => {
    const t = await setup();
    t.session('s1', { providerId: 'claude' });
    const image = (await (await t.upload('s1', 'a.png', PNG)).json()) as { id: string };
    const response = await t.post('/api/sessions/s1/messages', { content: 'oi', attachmentIds: [image.id] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /^Este agente não aceita imagens nesta versão/,
    );
    expect(t.inputs).toHaveLength(0);
    expect(t.store.listMessages('s1')).toEqual([]);
    // Text files still work with that provider.
    const text = (await (await t.upload('s1', 'a.txt', Buffer.from('ok'))).json()) as { id: string };
    expect((await t.post('/api/sessions/s1/messages', { content: 'oi', attachmentIds: [text.id] })).status).toBe(202);
    await t.settle('s1');
    expect(t.inputs[0]!.attachments).toBeUndefined();
  });
});
