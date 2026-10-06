// E2E server: the real backend, web build and SQLite (in a temporary folder), with a
// scripted provider instead of real CLIs. Started by Playwright (see playwright.config.ts).
//
// The fake provider reacts to a marker in the current message:
//   [aprovar] → asks for approval, then answers with the decision
//   [lento]   → streams slowly until cancelled
//   [normal] or no marker → streams a short Markdown answer with a code block
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import express from 'express';
import type { ProviderInfo, ProviderRegistry } from '../../shared/contracts.js';
import { createBackend } from '../../server/index.js';
import { Store } from '../../server/store.js';
import { emitApproval } from '../../server/providers/common.js';
import { startFakeMemory } from './fake-memory.js';

const port = Number(process.env.E2E_PORT || 4399);
// Optional simulated ai-memory (E2E_MEMORY_PORT); otherwise ADELIC_MEMORY_URL points nowhere.
if (process.env.E2E_MEMORY_PORT) startFakeMemory(Number(process.env.E2E_MEMORY_PORT));
const dataDir = mkdtempSync(join(tmpdir(), 'adelic-e2e-'));
const store = new Store(dataDir);

const codex: ProviderInfo = {
  id: 'codex',
  name: 'Codex (E2E)',
  installed: true,
  available: true,
  status: 'ready',
  detail: 'Provedor simulado para testes E2E',
  models: [{ id: 'e2e-model', name: 'E2E Model', isDefault: true, efforts: ['low', 'medium'] }],
  defaultModel: 'e2e-model',
  capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true },
};
const pending = new Map<string, (decision: 'approve' | 'deny') => void>();
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), fail(new Error('cancelled'))), { once: true });
  });

const providers: ProviderRegistry = {
  async list() {
    return [codex];
  },
  async run(input, emit, signal) {
    // The prompt also carries earlier messages after the current one ("Pedido atual: …"
    // then "Mensagens recentes"), so read the marker from the current request only.
    const current = (input.prompt.split('Pedido atual:').at(-1) ?? input.prompt).split('\n\nMensagens recentes')[0];
    const marker = ['[aprovar]', '[lento]', '[normal]'].find((m) => current.toLowerCase().includes(m)) ?? '';
    try {
      if (marker === '[aprovar]') {
        const id = `e2e-approval-${input.runId}`;
        const decision = new Promise<'approve' | 'deny'>((done) => pending.set(id, done));
        emitApproval(input, emit, id, 'Executar comando de teste', 'echo e2e', 'command');
        const answer = await Promise.race([decision, sleep(60_000, signal).then(() => 'deny' as const)]);
        const text = answer === 'approve' ? 'Comando aprovado e executado.' : 'Comando negado; nada foi executado.';
        emit({ type: 'delta', text });
        return { text, stopReason: 'completed' };
      }
      if (marker === '[lento]') {
        let text = '';
        for (let i = 0; i < 600; i++) {
          await sleep(100, signal);
          text += '.';
          emit({ type: 'delta', text: '.' });
        }
        return { text, stopReason: 'completed' };
      }
      const chunks = ['Resposta **E2E** pronta.\n\n', '```ts\n', 'const soma = 2 + 2;\n', '```\n'];
      for (const chunk of chunks) {
        await sleep(30, signal);
        emit({ type: 'delta', text: chunk });
      }
      return { text: chunks.join(''), stopReason: 'completed' };
    } catch (error) {
      if (signal.aborted) return { text: '', stopReason: 'cancelled' };
      throw error;
    }
  },
  async approve(id, decision) {
    const resolveDecision = pending.get(id);
    if (!resolveDecision) throw new Error('Aprovação não está mais pendente.');
    pending.delete(id);
    resolveDecision(decision);
  },
  async shutdown() {},
};

const { app } = createBackend(store, providers);
const web = resolve(import.meta.dirname, '../../dist');
// Fake GitHub "latest release" for the opt-in update check (ADELIC_RELEASES_URL points here).
app.get('/e2e/releases/latest', (_req, res) =>
  res.json({ tag_name: 'v99.0.0', html_url: 'https://github.com/ikaromm/Adelic/releases/tag/v99.0.0' }),
);
app.use(express.static(web));
app.use((_req, res) => res.sendFile(join(web, 'index.html')));
createServer(app).listen(port, '127.0.0.1', () =>
  console.log(`E2E server on http://127.0.0.1:${port} (data ${dataDir})`),
);
