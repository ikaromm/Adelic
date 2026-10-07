// E2E server: the real backend, web build and SQLite (in a temporary folder), with a
// scripted provider instead of real CLIs. Started by Playwright (see playwright.config.ts).
//
// The fake provider reacts to a marker in the current message:
//   [aprovar] → asks for approval, then answers with the decision
//   [bloquear] → like [aprovar], for `git push origin main` (blocked by a project rule in hooks.spec.ts)
//   [lento]   → streams slowly until cancelled
//   [escrever] → with sandbox workspace-write, edits README.md and creates novo.txt in input.cwd
//   [medio]   → streams for about two seconds, then completes (message queue flows)
//   [normal] or no marker → streams a short Markdown answer with a code block
//   [anexos]  → lists the images it received and the text files inlined in the prompt
// Plan mode: a planning prompt answers a fixed spec with two tasks (a planning prompt with
// [falhar-tarefa] adds a third task whose run fails); task runs answer "Tarefa concluída".
//   [eco]     → answers "Eco: <current request>" so tests can see what the agent received
//               (saved commands: the expanded template, not the typed `/name`); after a
//               compaction it adds "| Resumo recebido: <summary>"
//   [mencoes] → answers the "[Arquivo mencionado: …]" labels found in the prompt
//   [sobrecarga] → the default model (e2e-model) fails as overloaded before any output; any
//               other model (e2e-reserva) answers with the model it ran on (model fallback)
//   [historico] → answers with the history it received (provider handoff flows)
// Provider handoff: a second scripted provider, "Kiro (E2E)", and a fixed summary for the
// handoff prompt (a conversation containing [resumo-falha] makes that call fail).
//   [pesado]  → reports 500k input tokens, so the automatic compaction threshold trips
// Compaction: a compaction prompt answers a fixed summary (the prompt with [falhar-resumo]
// in the transcript fails, so the automatic fallback can be seen).
// Voice dictation: a fake voxtype/ffmpeg runner (never the real binaries) transcribes any
// recording as "texto ditado"; GET /e2e/voice?mode=local|remote|missing switches its setup.
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProviderInfo, ProviderRegistry } from '../../shared/contracts.js';
import { createBackend } from '../../server/index.js';
import { webAssets } from '../../server/http/web.js';
import { Store } from '../../server/store.js';
import { emitApproval } from '../../server/providers/common.js';
import { PLAN_PROMPT_MARKER, TASK_PROMPT_MARKER } from '../../server/plan-markdown.js';
import { HANDOFF_PROMPT_MARKER } from '../../server/provider-handoff.js';
import { COMPACTION_PROMPT_MARKER } from '../../server/compaction.js';
import { VoiceService, type CommandRunner } from '../../server/voice.js';
import { TerminalService } from '../../server/terminal.js';
import { startFakeMemory } from './fake-memory.js';
import { createFakeUpdater } from './fake-updater.js';

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
  models: [
    { id: 'e2e-model', name: 'E2E Model', isDefault: true, efforts: ['low', 'medium'] },
    { id: 'e2e-reserva', name: 'E2E Reserva', efforts: ['low', 'medium'] },
  ],
  defaultModel: 'e2e-model',
  capabilities: { fast: true, tools: true, approvals: true, cancel: true, reasoning: true, images: true },
};
const kiro: ProviderInfo = {
  ...codex,
  id: 'kiro',
  name: 'Kiro (E2E)',
  detail: 'Segundo provedor simulado para testes E2E',
  models: [{ id: 'kiro-e2e', name: 'Kiro E2E Model', isDefault: true }],
  defaultModel: 'kiro-e2e',
  capabilities: { ...codex.capabilities, reasoning: false },
};
export const E2E_HANDOFF_SUMMARY =
  '**Objetivo**\nExportar o relatório.\n\n**Próximo passo**\nLigar o botão Exportar (resumo E2E).';
const pending = new Map<string, (decision: 'approve' | 'deny') => void>();
const flaky = new Map<string, number>();
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), fail(new Error('cancelled'))), { once: true });
  });

const providers: ProviderRegistry = {
  async list() {
    return [codex, kiro];
  },
  async run(input, emit, signal) {
    if (input.prompt.startsWith(HANDOFF_PROMPT_MARKER)) {
      await sleep(150, signal).catch(() => undefined);
      if (input.prompt.includes('[resumo-falha]')) throw new Error('Kiro stream failed: The operation timed out.');
      emit({ type: 'delta', text: E2E_HANDOFF_SUMMARY });
      return { text: E2E_HANDOFF_SUMMARY, stopReason: 'completed' };
    }
    if (input.prompt.startsWith(COMPACTION_PROMPT_MARKER)) {
      await sleep(300, signal).catch(() => undefined);
      if (signal.aborted) return { text: '', stopReason: 'cancelled' };
      if (input.prompt.includes('[falhar-resumo]')) throw new Error('Resumo indisponível no teste');
      const previous = input.prompt.includes('Resumo anterior') ? ' (inclui o resumo anterior)' : '';
      const summary = `## Objetivo\nResumo-E2E da conversa${previous}.\n\n## Próximos passos\nContinuar.`;
      emit({ type: 'delta', text: summary });
      emit({ type: 'usage', inputTokens: 120, outputTokens: 30 });
      return { text: summary, stopReason: 'completed' };
    }
    if (input.prompt.startsWith(PLAN_PROMPT_MARKER)) {
      // Records what the planning run received, so the E2E can check it was read-only.
      const extra = input.prompt.includes('[falhar-tarefa]') ? '\n- [ ] Tarefa que falha' : '';
      const spec = `# Exportar relatório\n\n## Requisitos\n1. O relatório sai em CSV.\n2. Sandbox do planejamento: ${input.sandbox}.\n\n## Design\nGerar o CSV em \`src/report.ts\`.\n\n## Tarefas\n- [ ] Criar o gerador de CSV\n- [ ] Ligar o botão Exportar${extra}\n`;
      await sleep(150, signal).catch(() => undefined);
      emit({ type: 'delta', text: spec });
      return { text: spec, stopReason: signal.aborted ? 'cancelled' : 'completed' };
    }
    if (input.prompt.startsWith(TASK_PROMPT_MARKER)) {
      const current = /Tarefa atual: (.*)/.exec(input.prompt)?.[1] ?? '';
      try {
        await sleep(400, signal);
      } catch {
        return { text: '', stopReason: 'cancelled' };
      }
      if (current.includes('falha')) throw new Error('A tarefa de teste falhou');
      emit({ type: 'delta', text: 'Tarefa concluída' });
      return { text: 'Tarefa concluída', stopReason: 'completed' };
    }
    // The prompt also carries earlier messages after the current one ("Pedido atual: …"
    // then "Mensagens recentes"), so read the marker from the current request only.
    // Coordinated runs: a planner asks for a JSON task list.
    if (input.prompt.includes('Produza somente JSON válido') && input.prompt.includes('"tasks"')) {
      const plan = JSON.stringify({
        tasks: [{ id: 't1', title: 'Verificar arquivos', instructions: 'ler', scope: ['src'], dependsOn: [] }],
      });
      emit({ type: 'delta', text: plan });
      return { text: plan, stopReason: 'completed' };
    }
    const current = (input.prompt.split('Pedido atual:').at(-1) ?? input.prompt).split('\n\nMensagens recentes')[0];
    const marker =
      [
        '[aprovar]',
        '[bloquear]',
        '[lento]',
        '[medio]',
        '[normal]',
        '[instavel]',
        '[quebra]',
        '[anexos]',
        '[escrever]',
        '[eco]',
        '[mencoes]',
        '[sobrecarga]',
        '[historico]',
      ].find((m) => current.toLowerCase().includes(m)) ?? '';
    try {
      // Fails once with a timeout before any output, then answers: retried automatically.
      if (marker === '[instavel]') {
        const n = (flaky.get(input.sessionId) ?? 0) + 1;
        flaky.set(input.sessionId, n);
        if (n === 1) throw new Error('Kiro stream failed: The operation timed out.');
        emit({ type: 'delta', text: 'Recuperado depois de uma nova tentativa.' });
        return { text: 'Recuperado depois de uma nova tentativa.', stopReason: 'completed' };
      }
      // Overloaded on the default model only: retried, then the fallback or "Tentar com outro modelo".
      if (marker === '[sobrecarga]') {
        const model = input.model ?? codex.defaultModel;
        if (model === codex.defaultModel)
          throw new Error('Selected model is at capacity. Please try a different model.');
        const text = `Respondido por ${model}.`;
        emit({ type: 'delta', text });
        return { text, stopReason: 'completed' };
      }
      // Fails after showing text: not repeated automatically, the UI offers "Tentar de novo".
      if (marker === '[quebra]') {
        emit({ type: 'delta', text: 'Começando a resposta…' });
        throw new Error('stream failed');
      }
      if (marker === '[anexos]') {
        const images = (input.attachments ?? []).map((a) => a.name);
        const files = [...input.prompt.matchAll(/\[Arquivo anexado: ([^\]]+)\]/g)].map((m) => m[1]);
        const text = `Imagens recebidas: ${images.join(', ') || 'nenhuma'}. Arquivos recebidos: ${[...new Set(files)].join(', ') || 'nenhum'}.`;
        emit({ type: 'delta', text });
        return { text, stopReason: 'completed' };
      }
      if (marker === '[mencoes]') {
        const files = [...input.prompt.matchAll(/\[Arquivo mencionado: ([^\]]+)\]/g)].map((m) => m[1]);
        const text = `Arquivos mencionados: ${[...new Set(files)].join(', ') || 'nenhum'}.`;
        emit({ type: 'delta', text });
        return { text, stopReason: 'completed' };
      }
      // Reports a large input like a long Codex turn, so the automatic threshold trips.
      if (current.toLowerCase().includes('[pesado]')) {
        emit({ type: 'delta', text: 'Resposta pesada.' });
        emit({ type: 'usage', inputTokens: 500_000, outputTokens: 5 });
        return { text: 'Resposta pesada.', stopReason: 'completed' };
      }
      if (marker === '[eco]') {
        // Detached conversations run the coordinated fast path: the request follows "Pedido atual:".
        const summary = input.summary ? ` | Resumo recebido: ${input.summary.replace(/\s+/g, ' ').trim()}` : '';
        const text = `Eco: ${current.replace(/\s+/g, ' ').trim()}${summary}`;
        emit({ type: 'delta', text });
        return { text, stopReason: 'completed' };
      }
      if (marker === '[historico]') {
        const text = `Agente ${input.providerId} recebeu: ${input.history.map((m) => m.content.replace(/\s+/g, ' ').trim()).join(' | ')}`;
        emit({ type: 'delta', text });
        return { text, stopReason: 'completed' };
      }
      // Acts like an agent allowed to write in the project (checkpoints flow).
      if (marker === '[escrever]') {
        if (input.sandbox !== 'workspace-write') throw new Error('[escrever] requer workspace-write');
        const n = current.match(/\[escrever\]\s*(\d+)/)?.[1] ?? '1';
        writeFileSync(join(input.cwd, 'README.md'), `# Projeto\n\nlinha alterada pelo agente ${n}\n`);
        writeFileSync(join(input.cwd, `novo ${n}.txt`), 'criado pelo agente\n');
        emit({ type: 'tool', name: 'fileChange', description: 'Editou README.md', status: 'completed' });
        emit({ type: 'delta', text: 'Arquivos alterados.' });
        return { text: 'Arquivos alterados.', stopReason: 'completed' };
      }
      if (marker === '[aprovar]' || marker === '[bloquear]') {
        const id = `e2e-approval-${input.runId}`;
        const decision = new Promise<'approve' | 'deny'>((done) => pending.set(id, done));
        const command = marker === '[bloquear]' ? 'git   push origin main' : 'echo e2e';
        emitApproval(input, emit, id, 'Executar comando de teste', command, 'command', 'pending', { command });
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
      if (marker === '[medio]') {
        for (let i = 0; i < 20; i++) {
          await sleep(100, signal);
          emit({ type: 'delta', text: '-' });
        }
        emit({ type: 'delta', text: ' Resposta média concluída.' });
        return { text: '-'.repeat(20) + ' Resposta média concluída.', stopReason: 'completed' };
      }
      const chunks = ['Resposta **E2E** pronta.\n\n', '```ts\n', 'const soma = 2 + 2;\n', '```\n'];
      for (const chunk of chunks) {
        await sleep(30, signal);
        emit({ type: 'delta', text: chunk });
      }
      // Like Codex: token counts without a cost.
      emit({ type: 'usage', inputTokens: 4606, outputTokens: 5 });
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

let voiceMode: 'local' | 'remote' | 'missing' = 'local';
const fakeVoxtype: CommandRunner = async (file, args, { signal }) => {
  if (file.endsWith('ffmpeg')) return { stdout: '' };
  if (args.includes('transcribe')) {
    await sleep(400, signal ?? new AbortController().signal);
    return { stdout: 'Processing 16000 samples (1.00s)...\n\ntexto ditado\n' };
  }
  if (args[0] === 'config')
    return { stdout: JSON.stringify({ engine: 'whisper', 'whisper.mode': voiceMode, 'whisper.model': 'base' }) };
  if (args[0] === 'info' && args[1] === 'engines')
    return { stdout: JSON.stringify([{ name: 'whisper', compiled: true }]) };
  if (args[0] === 'info' && args[1] === 'models')
    return { stdout: JSON.stringify({ engines: { whisper: { models: [{ name: 'base', installed: true }] } } }) };
  return { stdout: '-q, --quiet\n--engine <ENGINE>\n--whisper-mode <MODE>' };
};
const voice = new VoiceService({
  run: fakeVoxtype,
  find: async (name) => (voiceMode === 'missing' && name === 'voxtype' ? undefined : `/e2e/${name}`),
  statusTtlMs: 0,
});

// Terminal (docs/specs/terminal-preview.md): the real bubblewrap sandbox when it can create
// namespaces here; otherwise (some CI containers) commands run unsandboxed in the project folder,
// so the UI flows are still covered. Isolation itself is tested in tests/terminal.test.ts.
const bwrapWorks =
  existsSync('/usr/bin/bwrap') &&
  spawnSync(
    '/usr/bin/bwrap',
    ['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--unshare-pid', '--', '/bin/true'],
    {
      timeout: 10_000,
      stdio: 'ignore',
    },
  ).status === 0;
const terminal = new TerminalService(bwrapWorks ? {} : { wrap: async (command, args) => ({ command, args }) });
// "Atualizar Adelic": a scripted checkout two commits behind; the restart only flips the commit.
const updater = createFakeUpdater();
// Short retry delays so the retry flows finish quickly.
const { app } = createBackend(
  store,
  providers,
  undefined,
  undefined,
  { baseDelayMs: 150, maxDelayMs: 400 },
  voice,
  terminal,
  undefined,
  undefined,
  updater.service,
);
app.post('/e2e/update/reset', (_req, res) => res.json(updater.reset()));
app.get('/e2e/voice', (req, res) => {
  const mode = String(req.query.mode);
  if (mode === 'local' || mode === 'remote' || mode === 'missing') voiceMode = mode;
  res.json({ mode: voiceMode });
});
const web = resolve(import.meta.dirname, '../../dist');
// Fake GitHub "latest release" for the opt-in update check (ADELIC_RELEASES_URL points here).
app.get('/e2e/releases/latest', (_req, res) =>
  res.json({ tag_name: 'v99.0.0', html_url: 'https://github.com/ikaromm/Adelic/releases/tag/v99.0.0' }),
);
// Installable-app update flow (pwa.spec.ts): each POST makes /sw.js differ by one comment,
// which the browser sees as a new worker version.
let swBump = 0;
app.post('/e2e/sw-bump', (_req, res) => res.json({ bump: ++swBump }));
app.get('/sw.js', (_req, res, next) => {
  if (!swBump) return next();
  res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(`${readFileSync(join(web, 'sw.js'), 'utf8')}\n// e2e ${swBump}\n`);
});
app.use(webAssets(web));
createServer(app).listen(port, '127.0.0.1', () =>
  console.log(`E2E server on http://127.0.0.1:${port} (data ${dataDir})`),
);
