// Minimal in-memory imitation of the ai-memory HTTP surface used by Adelic (MCP tools,
// /api/v1 catalog and /admin/write-page), for E2E tests of the Memory library. The real
// server is covered by tests/integration-ai-memory.test.ts.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

type Note = { title: string; body: string; frontmatter: Record<string, unknown> };
const notes = new Map<string, Note>();
const key = (w: string, p: string, path: string) => `${w}\0${p}\0${path}`;
const seed = (w: string, p: string, path: string, body: string, fm: Record<string, unknown> = {}) =>
  notes.set(key(w, p, path), {
    title: body.match(/^# (.+)$/m)?.[1] ?? path,
    body,
    frontmatter: { tier: 'semantic', type: 'Note', ...fm },
  });
seed('pessoal', 'ambiente-ikaromm', 'configuracoes/rede.md', '# Rede local\n\nRoteador em 192.168.0.1.\n');
seed('pessoal', 'ambiente-ikaromm', 'configuracoes/backup.md', '# Backup\n\nDiário às 3h.\n', { pinned: true });
seed('projetos', 'adelic', 'decisoes/tema.md', '# Tema escuro\n\nDracula mais escuro.\n', {
  kind: 'fact',
  type: 'Fact',
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const read = (req: IncomingMessage) =>
  new Promise<string>((done) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => done(data));
  });
const write = (w: string, p: string, path: string, body: string, fm: Record<string, unknown>) =>
  notes.set(key(w, p, path), {
    title: body.match(/^# (.+)$/m)?.[1] ?? path,
    body,
    frontmatter: { type: 'Note', ...fm },
  });

/** Test hook: changes a note as another client would. */
export function externalEdit(w: string, p: string, path: string, body: string) {
  const note = notes.get(key(w, p, path));
  if (note) notes.set(key(w, p, path), { ...note, body });
}

export function startFakeMemory(port: number) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').map(decodeURIComponent);
    if (url.pathname === '/admin/status')
      return json(res, 200, { version: 'fake', counts: { pages_latest: notes.size } });
    if (url.pathname === '/e2e/external-edit' && req.method === 'POST') {
      const b = JSON.parse(await read(req));
      externalEdit(b.workspace, b.project, b.path, b.body);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/v1/projects') {
      const counts = new Map<string, number>();
      for (const k of notes.keys()) {
        const [w, p] = k.split('\0');
        counts.set(`${w}\0${p}`, (counts.get(`${w}\0${p}`) ?? 0) + 1);
      }
      return json(
        res,
        200,
        [...counts].map(([k, n]) => ({
          workspace_name: k.split('\0')[0],
          project_name: k.split('\0')[1],
          page_count: n,
        })),
      );
    }
    if (parts[1] === 'api' && parts[3] === 'workspaces' && parts[5] === 'projects' && parts[7] === 'pages') {
      const [w, p] = [parts[4], parts[6]];
      const path = parts.slice(8).join('/');
      const inScope = [...notes].filter(([k]) => k.startsWith(`${w}\0${p}\0`));
      if (!inScope.length) return json(res, 404, { error: `project '${p}' not found` });
      if (path)
        return notes.has(key(w, p, path)) ? json(res, 200, { path }) : json(res, 404, { error: 'page not found' });
      return json(
        res,
        200,
        inScope.map(([k, n]) => ({ path: k.split('\0')[2], title: n.title })),
      );
    }
    if (url.pathname === '/admin/write-page' && req.method === 'POST') {
      const b = JSON.parse(await read(req));
      const fm: Record<string, unknown> = { tier: b.tier };
      if (b.kind) fm.kind = b.kind;
      if (b.title) fm.title = b.title;
      if (b.tags?.length) fm.tags = b.tags;
      if (b.pinned) fm.pinned = true;
      if (b.kind === 'fact') fm.type = 'Fact';
      write(b.workspace, b.project, b.path, b.body, fm);
      return json(res, 200, { page_id: 'x', path: b.path });
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const rpc = JSON.parse(await read(req));
      const reply = (result: unknown, error?: unknown) =>
        json(res, 200, { jsonrpc: '2.0', id: rpc.id, ...(error ? { error } : { result }) });
      if (rpc.method === 'initialize') return reply({});
      if (rpc.method === 'tools/list')
        return reply({
          tools: [
            {
              name: 'memory_query',
              inputSchema: { properties: { scopes: {}, query: {}, workspace: {}, project: {} } },
            },
            { name: 'memory_read_page', inputSchema: { properties: { workspace: {}, project: {}, path: {} } } },
            {
              name: 'memory_write_page',
              inputSchema: {
                properties: {
                  workspace: { type: 'string' },
                  project: { type: 'string' },
                  path: { type: 'string' },
                  body: { type: 'string' },
                  tier: { type: 'string' },
                  tags: { type: 'array' },
                  pinned: { type: 'boolean' },
                  expires_at: { type: 'string' },
                  title: { type: 'string' },
                },
              },
            },
          ],
        });
      const { name, arguments: a } = rpc.params;
      const text = (value: unknown) => reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
      if (name === 'memory_read_page') {
        const note = notes.get(key(a.workspace, a.project, a.path));
        if (!note)
          return reply(undefined, {
            code: -32603,
            message: `page ${a.path} not found in resolved scope ${a.workspace}/${a.project}`,
          });
        return text({ path: a.path, title: note.title, body: note.body, frontmatter: note.frontmatter });
      }
      if (name === 'memory_write_page') {
        const fm: Record<string, unknown> = { tier: a.tier ?? 'semantic' };
        if (a.pinned) fm.pinned = true;
        if (a.tags?.length) fm.tags = a.tags;
        write(a.workspace, a.project, a.path, a.body, fm);
        return text({ path: a.path });
      }
      if (name === 'memory_query') {
        const scope = a.scopes?.[0] ?? { workspace: a.workspace, project: a.project };
        const q = String(a.query).toLowerCase();
        const hits = [...notes]
          .filter(
            ([k, n]) => k.startsWith(`${scope.workspace}\0${scope.project}\0`) && n.body.toLowerCase().includes(q),
          )
          .map(([k, n]) => ({ path: k.split('\0')[2], title: n.title, snippet: n.body.slice(0, 80) }));
        return text({ hits });
      }
    }
    json(res, 404, { error: 'not found' });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
