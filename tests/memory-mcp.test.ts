import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fake ai-memory service reproducing the observable contract of 2.1.x–2.5.x:
// MCP tools, read-only /api/v1 catalog and /admin/write-page. Writers rebuild the
// frontmatter from their arguments and stamp `type`/`generated` like the server does.
type Note = { body: string; frontmatter: Record<string, unknown> };
let notes: Map<string, Note>, calls: { route: string; args?: any }[], token: string | undefined, behavior: (route: string, args: any) => Response | undefined;
let writeSchema: Record<string, unknown>;
const scope = { workspace: 'w', project: 'p' };
const key = (w: string, p: string, path: string) => `${w}/${p}/${path}`;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const rpc = (id: number, result?: unknown, error?: unknown) => json({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
const typeFor = (path: string, fm: Record<string, unknown>) => fm.kind === 'fact' ? 'Fact' : path.startsWith('decisions/') ? 'Decision' : 'Note';
function store(w: string, p: string, path: string, body: string, fm: Record<string, unknown>) {
  const frontmatter = { ...fm, type: typeFor(path, fm), generated: { by: 'process:ai-memory/2.1.0', at: `t${calls.length}` } };
  if (typeof fm.expires_at === 'string') (frontmatter as any).stale_after = fm.expires_at;
  notes.set(key(w, p, path), { body, frontmatter });
}
function seed(path: string, body: string, fm: Record<string, unknown>) { notes.set(key('w', 'p', path), { body, frontmatter: fm }); }

beforeEach(() => {
  vi.resetModules(); notes = new Map(); calls = []; token = undefined; behavior = () => undefined;
  delete process.env.ADELIC_MEMORY_URL; delete process.env.ADELIC_MEMORY_TOKEN; delete process.env.ADELIC_MEMORY_TOKEN_FILE; delete process.env.AI_MEMORY_AUTH_TOKEN;
  writeSchema = { workspace: { type: ['string', 'null'] }, project: { type: ['string', 'null'] }, path: { type: 'string' }, body: { type: 'string' }, title: { type: ['string', 'null'] }, pinned: { type: 'boolean' }, tier: { type: ['string', 'null'] }, tags: { type: 'array' }, expires_at: { type: ['string', 'null'] } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url); const route = u.pathname;
    const headers = new Headers(init.headers);
    if (token && headers.get('authorization') !== `Bearer ${token}`) return json({ error: 'unauthorized' }, 401);
    const args = init.body ? JSON.parse(String(init.body)) : undefined;
    const special = behavior(route, args); if (special) return special;
    if (route === '/mcp') {
      if (args.method === 'initialize') return rpc(args.id, {});
      if (args.method === 'tools/list') return rpc(args.id, { tools: [{ name: 'memory_query', inputSchema: { properties: { scopes: {}, query: {}, workspace: {}, project: {} } } }, { name: 'memory_read_page', inputSchema: { properties: { workspace: {}, project: {}, path: {} } } }, { name: 'memory_write_page', inputSchema: { properties: writeSchema } }] });
      const { name, arguments: a } = args.params; calls.push({ route: name, args: a });
      if (name === 'memory_read_page') {
        const note = notes.get(key(a.workspace, a.project, a.path));
        if (!note) return rpc(args.id, undefined, { code: -32603, message: `page ${a.path} not found in resolved scope ${a.workspace}/${a.project}` });
        return rpc(args.id, { content: [{ type: 'text', text: JSON.stringify({ path: a.path, title: a.path, ...note }) }] });
      }
      if (name === 'memory_write_page') {
        const fm: Record<string, unknown> = { tier: a.tier ?? 'semantic' };
        if (a.title) fm.title = a.title; if (a.tags?.length) fm.tags = a.tags; if (a.pinned) fm.pinned = true; if (a.expires_at) fm.expires_at = a.expires_at;
        store(a.workspace, a.project, a.path, a.body, fm); return rpc(args.id, { content: [{ type: 'text', text: '{}' }] });
      }
      return rpc(args.id, { content: [{ type: 'text', text: JSON.stringify({ hits: [{ path: 'a.md', title: 'A', snippet: 'x' }] }) }] });
    }
    if (route === '/admin/write-page') {
      calls.push({ route, args });
      const fm: Record<string, unknown> = { tier: args.tier };
      if (args.title) fm.title = args.title; if (args.kind) fm.kind = args.kind; if (args.tags.length) fm.tags = args.tags; if (args.pinned) fm.pinned = true;
      store(args.workspace, args.project, args.path, args.body, fm); return json({ page_id: 'id', path: args.path });
    }
    if (route === '/admin/status') return json({ counts: { pages_latest: notes.size } });
    if (route === '/api/v1/projects') {
      const counts = new Map<string, number>(); for (const k of notes.keys()) { const [w, p] = k.split('/'); counts.set(`${w}/${p}`, (counts.get(`${w}/${p}`) ?? 0) + 1); }
      if (!counts.size) counts.set('w/p', 0);
      return json([...counts].map(([k, n]) => ({ workspace_name: k.split('/')[0], project_name: k.split('/')[1], page_count: n, last_updated: null })));
    }
    const m = route.match(/^\/api\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/pages(?:\/(.+))?$/);
    if (m) {
      const [w, p] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      if (w !== 'w' || p !== 'p') return json({ error: `project '${p}' not found` }, 404);
      if (m[3]) { const path = m[3].split('/').map(decodeURIComponent).join('/'); return notes.has(key(w, p, path)) ? json({ path }) : json({ error: 'page not found' }, 404); }
      return json([...notes.keys()].filter((k) => k.startsWith('w/p/')).map((k) => ({ path: k.slice(4), title: k.slice(4).toUpperCase() })).reverse());
    }
    return new Response('', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.ADELIC_MEMORY_URL; delete process.env.ADELIC_MEMORY_TOKEN; });
const load = () => import('../server/memory.js');
const service = () => import('../server/memory-service.js');
const writes = () => calls.filter((c) => c.route === 'memory_write_page' || c.route === '/admin/write-page');

describe('ai-memory service catalog', () => {
  it('lists scopes, counts and paginated notes from the service, without local files', async () => {
    seed('b.md', 'B', { tier: 'semantic' }); seed('a.md', 'A', { tier: 'semantic' }); notes.set(key('x', 'y', 'c.md'), { body: 'C', frontmatter: {} });
    const s = await service();
    expect(await s.memoryCatalog()).toEqual({ scopes: [{ workspace: 'w', project: 'p', pageCount: 2 }, { workspace: 'x', project: 'y', pageCount: 1 }], totalPages: 3 });
    expect(await s.memoryList(scope, 0, 1)).toEqual({ pages: [{ path: 'a.md', title: 'A.MD', snippet: '' }], total: 2, offset: 0, limit: 1 });
    expect((await s.memoryList(scope, 1, 1)).pages[0].path).toBe('b.md');
  });
  it('fails clearly instead of returning an empty catalog', async () => {
    const s = await service();
    behavior = (route) => route === '/api/v1/projects' ? new Response('', { status: 404 }) : undefined;
    await expect(s.memoryCatalog()).rejects.toThrow(/--enable-web/);
    behavior = (route) => route === '/api/v1/projects' ? json([]) : route === '/admin/status' ? json({ counts: { pages_latest: 11 } }) : undefined;
    await expect(s.memoryCatalog()).rejects.toThrow(/11 notas atuais/);
    behavior = () => { throw new TypeError('fetch failed'); };
    await expect(s.memoryCatalog()).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/indisponível/) });
    behavior = () => undefined; token = 'secret';
    await expect(s.memoryCatalog()).rejects.toThrow(/ADELIC_MEMORY_TOKEN/);
    await expect(s.memoryList({ workspace: 'w', project: 'nope' })).rejects.toThrow(/ADELIC_MEMORY_TOKEN/);
  });
  it('reports a missing scope and invalid paging', async () => {
    const s = await service();
    await expect(s.memoryList({ workspace: 'w', project: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(s.memoryList(scope, 0, 101)).rejects.toMatchObject({ status: 400 });
  });
  it('sends the configured bearer on every route and accepts only loopback URLs', async () => {
    token = 'secret'; process.env.ADELIC_MEMORY_TOKEN = 'secret'; process.env.ADELIC_MEMORY_URL = 'http://localhost:49999/';
    seed('a.md', 'A', { tier: 'semantic' });
    const m = await load(); const s = await service();
    expect((await s.memoryCatalog()).totalPages).toBe(1);
    expect((await m.sharedMemoryRead(scope, 'a.md')).body).toBe('A');
    expect((fetch as any).mock.calls.every(([url]: [string]) => url.startsWith('http://localhost:49999/'))).toBe(true);
    expect(process.env.ADELIC_MEMORY_TOKEN).toBeUndefined();
    process.env.ADELIC_MEMORY_URL = 'http://192.168.0.5:49374';
    await expect(s.memoryCatalog()).rejects.toThrow(/loopback/);
    process.env.ADELIC_MEMORY_URL = 'http://user:pw@127.0.0.1:49374';
    await expect(s.memoryCatalog()).rejects.toThrow(/credenciais/);
  });

  it('reads the bearer from ADELIC_MEMORY_TOKEN_FILE and reports an unreadable file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adelic-token-')); const file = join(dir, 'token');
    try {
      writeFileSync(file, 'from-file\n', { mode: 0o600 }); token = 'from-file'; process.env.ADELIC_MEMORY_TOKEN_FILE = file;
      expect((await (await service()).memoryCatalog()).scopes).toHaveLength(1);
      vi.resetModules(); process.env.ADELIC_MEMORY_TOKEN_FILE = join(dir, 'missing');
      await expect((await service()).memoryCatalog()).rejects.toThrow(/ADELIC_MEMORY_TOKEN_FILE/);
    } finally { delete process.env.ADELIC_MEMORY_TOKEN_FILE; rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('ai-memory writes through the service', () => {
  it('creates new notes through MCP and confirms the saved body', async () => {
    const m = await load();
    const saved = await m.sharedMemoryWrite(scope, 'new.md', 'hello', null);
    expect(saved.body).toBe('hello');
    expect(writes()).toEqual([{ route: 'memory_write_page', args: { workspace: 'w', project: 'p', path: 'new.md', body: 'hello' } }]);
  });
  it('edits an existing note preserving kind, tags, pinned, tier and title', async () => {
    seed('decisions/x.md', 'old', { kind: 'fact', tags: ['a', 'b'], pinned: true, tier: 'procedural', title: 'Custom', type: 'Fact', generated: { by: 'process:ai-memory/2.1.0', at: 'before' } });
    const m = await load(); const before = await m.sharedMemoryRead(scope, 'decisions/x.md');
    const saved = await m.sharedMemoryWrite(scope, 'decisions/x.md', 'new', before.version);
    expect(saved.body).toBe('new');
    expect(saved.frontmatter).toEqual({ kind: 'fact', tags: ['a', 'b'], pinned: true, tier: 'procedural', title: 'Custom', type: 'Fact', generated: expect.objectContaining({ by: 'process:ai-memory/2.1.0' }) });
    expect(writes().map((c) => c.route)).toEqual(['/admin/write-page']);
  });
  it('uses the MCP writer for a note with expires_at and keeps the TTL', async () => {
    seed('ttl.md', 'old', { tier: 'episodic', expires_at: '2026-12-01T00:00:00Z', stale_after: '2026-12-01T00:00:00Z', type: 'Note' });
    const m = await load(); const before = await m.sharedMemoryRead(scope, 'ttl.md');
    const saved = await m.sharedMemoryWrite(scope, 'ttl.md', 'new', before.version);
    expect(saved.frontmatter).toMatchObject({ tier: 'episodic', expires_at: '2026-12-01T00:00:00Z', stale_after: '2026-12-01T00:00:00Z' });
    expect(writes()).toEqual([{ route: 'memory_write_page', args: { workspace: 'w', project: 'p', path: 'ttl.md', body: 'new', tier: 'episodic', tags: [], pinned: false, expires_at: '2026-12-01T00:00:00Z' } }]);
  });
  it.each([
    ['custom field', { tier: 'semantic', source: 'imported' }, /source/],
    ['custom type', { tier: 'semantic', type: 'Runbook' }, /type personalizado/],
    ['kind with TTL', { tier: 'semantic', kind: 'fact', expires_at: '2026-12-01' }, /kind e expires_at/],
    ['empty tags', { tier: 'semantic', tags: [] }, /tags/],
  ])('blocks %s before writing and keeps the note', async (_label, fm, reason) => {
    seed('keep.md', 'base', fm as Record<string, unknown>);
    const m = await load(); const before = await m.sharedMemoryRead(scope, 'keep.md');
    await expect(m.sharedMemoryWrite(scope, 'keep.md', 'changed', before.version)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(reason) });
    expect(writes()).toHaveLength(0); expect(notes.get(key('w', 'p', 'keep.md'))!.body).toBe('base');
  });
  it('rejects stale versions, metadata-only changes and creation over an existing path', async () => {
    seed('race.md', 'base', { tier: 'semantic', tags: ['a'] });
    const m = await load(); const version = (await m.sharedMemoryRead(scope, 'race.md')).version;
    notes.get(key('w', 'p', 'race.md'))!.frontmatter.tags = ['b'];
    await expect(m.sharedMemoryWrite(scope, 'race.md', 'mine', version)).rejects.toMatchObject({ status: 409 });
    await expect(m.sharedMemoryWrite(scope, 'race.md', 'mine', null)).rejects.toMatchObject({ status: 409 });
    expect(writes()).toHaveLength(0); expect(notes.get(key('w', 'p', 'race.md'))!.body).toBe('base');
  });
  it('detects a change that lands while the edit is being prepared', async () => {
    seed('late.md', 'base', { tier: 'semantic' });
    const m = await load(); const version = (await m.sharedMemoryRead(scope, 'late.md')).version;
    let reads = 0;
    behavior = (route, args) => { if (route === '/mcp' && args?.params?.name === 'memory_read_page' && ++reads === 2) notes.set(key('w', 'p', 'late.md'), { body: 'external', frontmatter: { tier: 'semantic' } }); return undefined; };
    await expect(m.sharedMemoryWrite(scope, 'late.md', 'mine', version)).rejects.toMatchObject({ status: 409 });
    expect(writes()).toHaveLength(0); expect(notes.get(key('w', 'p', 'late.md'))!.body).toBe('external');
  });
  it('serializes concurrent saves with the same version: one success, one conflict', async () => {
    seed('two.md', 'base', { tier: 'semantic' });
    const m = await load(); const version = (await m.sharedMemoryRead(scope, 'two.md')).version;
    const results = await Promise.allSettled([m.sharedMemoryWrite(scope, 'two.md', 'one', version), m.sharedMemoryWrite(scope, 'two.md', 'two', version)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status).toBe(409);
    expect(writes()).toHaveLength(1);
  });
  it('does not create when the read fails for reasons other than not-found', async () => {
    behavior = (route, args) => route === '/mcp' && args?.params?.name === 'memory_read_page' ? rpc(args.id, undefined, { code: -32000, message: 'permission denied' }) : undefined;
    const m = await load();
    await expect(m.sharedMemoryWrite(scope, 'absent.md', 'x', null)).rejects.toThrow(/permission denied/);
    expect(writes()).toHaveLength(0);
  });
  it('reports when the service changes the saved body or metadata', async () => {
    seed('scrub.md', 'base', { tier: 'semantic' });
    const m = await load(); const version = (await m.sharedMemoryRead(scope, 'scrub.md')).version;
    behavior = (route, args) => { if (route === '/admin/write-page') { store('w', 'p', 'scrub.md', '[REDACTED]', { tier: 'semantic' }); return json({ path: args.path }); } return undefined; };
    await expect(m.sharedMemoryWrite(scope, 'scrub.md', 'token=abc', version)).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/não confirmou/) });
    seed('meta.md', 'base', { tier: 'semantic', pinned: true });
    const v2 = (await m.sharedMemoryRead(scope, 'meta.md')).version;
    behavior = (route, args) => { if (route === '/admin/write-page') { store('w', 'p', 'meta.md', args.body, { tier: 'semantic' }); return json({ path: args.path }); } return undefined; };
    await expect(m.sharedMemoryWrite(scope, 'meta.md', 'new', v2)).rejects.toThrow(/metadados lidos depois diferem/);
  });
  it('rejects old write schemas and _global before any write', async () => {
    delete writeSchema.workspace;
    const m = await load();
    await expect(m.sharedMemoryWrite(scope, 'new.md', 'x', null)).rejects.toThrow(/workspace.*string/);
    await expect(m.sharedMemoryWrite({ workspace: 'w', project: '_global' }, 'x.md', 'x', null)).rejects.toMatchObject({ status: 403 });
    await expect(m.memoryWrite({ memoryWorkspace: 'w', memoryProject: '_global' } as any, 'x.md', 'x')).rejects.toMatchObject({ status: 403 });
    expect(writes()).toHaveLength(0);
  });
  it('legacy project wrapper creates by MCP and edits through the service writer', async () => {
    seed('legacy.md', 'existing', { tier: 'working', kind: 'fact', pinned: true, type: 'Fact' });
    const m = await load(); const p: any = { memoryWorkspace: 'w', memoryProject: 'p' };
    expect((await m.memoryWrite(p, 'fresh.md', 'first')).body).toBe('first');
    const edit = await m.memoryWrite(p, 'legacy.md', 'second');
    expect(edit.frontmatter).toMatchObject({ tier: 'working', kind: 'fact', pinned: true, type: 'Fact' });
    expect(writes().map((c) => c.route)).toEqual(['memory_write_page', '/admin/write-page']);
  });
});
