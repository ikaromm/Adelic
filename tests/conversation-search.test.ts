import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../server/store.js';
import { createBackend } from '../server/index.js';
import type { Message, ProviderRegistry, Session } from '../shared/contracts.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adelic-search-'));
  const store = new Store(dir);
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = (id: string, title: string, updatedAt: string): Session => {
    const s: Session = {
      id,
      projectId: null,
      title,
      providerId: 'codex',
      mode: 'auto',
      createdAt: updatedAt,
      updatedAt,
    };
    store.putSession(s);
    return s;
  };
  let n = 0;
  const say = (sessionId: string, role: Message['role'], content: string) =>
    store.addMessage({ id: `m${++n}`, sessionId, role, content, createdAt: `2026-10-0${n}T00:00:00Z` });
  return { store, session, say };
}

describe('conversation search', () => {
  it('finds messages by prefix, ignoring accents and case, newest conversation first', () => {
    const { store, session, say } = setup();
    session('a', 'Rede de casa', '2026-10-01');
    session('b', 'Backup', '2026-10-05');
    say('a', 'user', 'Como configurar o roteador?');
    say('a', 'assistant', 'Abra a configuração em 192.168.0.1.');
    say('b', 'user', 'Configuração do rsync para o NAS');
    const hits = store.searchConversations('CONFIGURACAO');
    expect(hits.map((h) => h.sessionId)).toEqual(['b', 'a']);
    expect(hits[1].matches.map((m) => m.messageId)).toEqual(['m2']);
    // A shorter prefix reaches both inflections.
    expect(store.searchConversations('configur').find((h) => h.sessionId === 'a')?.matches).toHaveLength(2);
    expect(hits[0].matches[0].snippet).toContain('[[Configuração]]');
    expect(store.searchConversations('rotea').map((h) => h.sessionId)).toEqual(['a']);
  });
  it('matches titles, needs every term, and neutralises FTS syntax', () => {
    const { store, session, say } = setup();
    session('a', 'Planejamento de férias', '2026-10-01');
    say('a', 'user', 'praia em janeiro');
    expect(store.searchConversations('ferias').map((h) => h.sessionId)).toEqual(['a']);
    expect(store.searchConversations('praia janeiro')).toHaveLength(1);
    expect(store.searchConversations('praia montanha')).toHaveLength(0);
    for (const q of ['"', 'praia OR', '*', 'NEAR(praia', 'a:b', '()'])
      expect(() => store.searchConversations(q)).not.toThrow();
    expect(store.searchConversations('   ')).toEqual([]);
  });
  it('keeps the index in sync with edits and deletions', () => {
    const { store, session, say } = setup();
    session('a', 'T', '2026-10-01');
    say('a', 'assistant', 'parcial');
    const msg = store.listMessages('a')[0];
    store.updateMessage({ ...msg, content: 'resposta final completa' });
    expect(store.searchConversations('parcial')).toHaveLength(0);
    expect(store.searchConversations('final')).toHaveLength(1);
    store.deleteSession('a');
    expect(store.searchConversations('final')).toHaveLength(0);
  });
});

describe('search and export routes', () => {
  it('searches over HTTP and exports Markdown and JSON with a safe filename', async () => {
    const { store, session, say } = setup();
    session('s1', 'Análise: custos/2026', '2026-10-01');
    say('s1', 'user', 'Quanto custa?');
    say('s1', 'assistant', '**R$ 10**');
    const providers = {
      list: async () => [],
      run: async () => ({ text: '', stopReason: 'completed' }),
      approve: async () => {},
      shutdown: async () => {},
    } as unknown as ProviderRegistry;
    const server: Server = createServer(createBackend(store, providers).app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.unshift(() => {
      server.closeAllConnections();
      server.close();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await (await fetch(`${base}/api/search?q=custa`)).json()).hits[0].sessionId).toBe('s1');
    expect((await fetch(`${base}/api/search?q=`)).status).toBe(400);
    const md = await fetch(`${base}/api/sessions/s1/export`);
    expect(md.headers.get('content-disposition')).toBe('attachment; filename="adelic-analise-custos-2026.md"');
    const text = await md.text();
    expect(text).toMatch(/^# Análise: custos\/2026/);
    expect(text).toContain('## Você · ');
    expect(text).toContain('## Agente · ');
    expect(text).toContain('**R$ 10**');
    const json = await (await fetch(`${base}/api/sessions/s1/export?format=json`)).json();
    expect(json.messages).toHaveLength(2);
    expect((await fetch(`${base}/api/sessions/nope/export`)).status).toBe(404);
  });
});
