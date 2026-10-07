import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../server/index.js';
import { Store } from '../server/store.js';
import { emitApproval } from '../server/providers/common.js';
import type { runCheck } from '../server/hooks.js';
import type { ProviderRegistry, Run, RunEvent, RunInput, Session } from '../shared/contracts.js';
import type { CheckResult, ProjectHooks } from '../shared/hooks.js';
import { makeGitRepo } from './git-fixtures.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const makeRepo = () => {
  const dir = makeGitRepo();
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const until = async (condition: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/**
 * Backend with a scripted provider. Markers in the prompt: `[nada]` writes nothing, `[falhar]`
 * throws, `[aprovar] <cmd>` asks for approval of <cmd> and answers the decision, `[esperar]`
 * waits for release(). Without a marker it writes README.md (an agent with workspace-write).
 */
function setup(
  projectPath: string,
  opts: { sandbox?: 'read-only' | 'workspace-write'; runner?: typeof runCheck } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'adelic-hooks-data-'));
  const store = new Store(dataDir);
  store.setSettings({ ...store.getSettings()!, sandbox: opts.sandbox ?? 'workspace-write' });
  const now = new Date().toISOString();
  store.putProject({
    id: 'p',
    name: 'P',
    path: projectPath,
    createdAt: now,
    memoryWorkspace: 'w',
    memoryProject: 'p',
    orchestration: { enabled: false, maxWorkers: 1, review: false },
  });
  const inputs: RunInput[] = [];
  const gates: (() => void)[] = [];
  const decisions = new Map<string, (d: 'approve' | 'deny') => void>();
  const answered: { id: string; decision: string }[] = [];
  let writes = 0;
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
      // A provider that denied a blocked command itself (Codex does, before auto-approval).
      if (input.prompt.includes('[negado-provedor]')) {
        emitApproval(input, emit, `${input.runId}:p1`, 'Comando bloqueado', 'git push', 'command', 'denied', {
          command: 'git push',
          blocked: 'git push*',
        });
        return { text: 'ok', stopReason: 'completed' };
      }
      if (input.prompt.includes('[esperar]')) await new Promise<void>((r) => gates.push(r));
      if (input.prompt.includes('[falhar]')) throw new Error('falha do agente');
      const ask = /\[aprovar\] (.+)/.exec(input.prompt)?.[1];
      if (ask) {
        const id = `${input.runId}:a1`;
        const decision = new Promise<'approve' | 'deny'>((r) => {
          decisions.set(id, r);
          signal.addEventListener('abort', () => r('deny'), { once: true });
        });
        emitApproval(input, emit, id, 'Executar comando', ask, 'command', 'pending', { command: ask });
        const answer = await decision;
        emit({ type: 'delta', text: answer });
        return { text: answer, stopReason: 'completed' };
      }
      if (input.sandbox === 'workspace-write' && !input.prompt.includes('[nada]'))
        writeFileSync(join(input.cwd, 'README.md'), `alterado ${++writes}\n`);
      emit({ type: 'delta', text: 'feito' });
      return { text: 'feito', stopReason: 'completed' };
    },
    async approve(id, decision) {
      answered.push({ id, decision });
      const resolve = decisions.get(id);
      decisions.delete(id);
      resolve?.(decision);
    },
    async shutdown() {},
  };
  const { app, orchestrator } = createBackend(store, providers, undefined, undefined, undefined, opts.runner);
  const server: Server = createServer(app);
  server.listen(0, '127.0.0.1');
  cleanup.push(async () => {
    await orchestrator.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const base = new Promise<string>((r) => {
    const done = () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    if (server.listening) done();
    else server.once('listening', done);
  });
  const api = async (path: string, init?: { method?: string; body?: unknown }) => {
    const response = await fetch(`${await base}${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const session = (projectId: string | null = 'p') => {
    const s: Session = {
      id: `s-${Math.random().toString(36).slice(2)}`,
      projectId,
      title: 'T',
      providerId: 'codex',
      mode: 'fast',
      createdAt: now,
      updatedAt: now,
    };
    store.putSession(s);
    return s;
  };
  const finished = async (runId: string) => {
    let run: Run | undefined;
    await until(() => (run = store.getRun(runId))?.status !== 'running' && run !== undefined);
    return run!;
  };
  const checks = (sessionId: string, runId?: string) =>
    store
      .listEvents(sessionId)
      .filter((e): e is RunEvent & { check: CheckResult } => e.type === 'check' && Boolean(e.check))
      .filter((e) => !runId || e.runId === runId);
  const settled = (sessionId: string, count: number) =>
    until(() => checks(sessionId).filter((e) => e.check.status !== 'running').length >= count);
  const setHooks = (hooks: Partial<ProjectHooks>) =>
    api('/api/projects/p/hooks', { method: 'PUT', body: hooks }).then((r) => {
      expect(r.status).toBe(200);
      return r.body;
    });
  const decide = (sessionId: string, approvalId: string, decision: 'approve' | 'deny') =>
    api(`/api/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', body: { decision, sessionId } });
  return {
    store,
    orchestrator,
    api,
    session,
    finished,
    checks,
    settled,
    setHooks,
    inputs,
    decisions,
    answered,
    decide,
    waiting: () => until(() => gates.length > 0),
    release: () => gates.splice(0).forEach((g) => g()),
  };
}

const hasBwrap = existsSync('/usr/bin/bwrap');

describe('project hooks API', () => {
  it('stores the configuration in the database and validates it', async () => {
    const { api, store, setHooks } = setup(makeRepo());
    expect(await api('/api/projects/p/hooks')).toEqual({
      status: 200,
      body: { afterEdit: [], blockedCommands: [], autoFix: false },
    });
    expect(
      await setHooks({ afterEdit: [{ name: 'testes', command: 'npm test' } as never], blockedCommands: ['git push*'] }),
    ).toEqual({
      afterEdit: [{ name: 'testes', command: 'npm test', timeoutSec: 120, enabled: true }],
      blockedCommands: ['git push*'],
      autoFix: false,
    });
    expect(store.getHooks('p').blockedCommands).toEqual(['git push*']);
    expect(store.getProject('p')).not.toHaveProperty('hooks');
    const bad = await api('/api/projects/p/hooks', {
      method: 'PUT',
      body: { afterEdit: [{ name: 'x', command: 'x'.repeat(501) }] },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('afterEdit inválido');
    expect((await api('/api/projects/nao/hooks')).status).toBe(404);
    expect((await api('/api/projects/nao/hooks', { method: 'PUT', body: {} })).status).toBe(404);
    // Deleting the project removes its hooks with it.
    store.db.prepare('DELETE FROM projects WHERE id=?').run('p');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM project_hooks').get()).toEqual({ n: 0 });
  });

  it.skipIf(!hasBwrap)('runs one check on demand in the sandbox, and refuses while a run writes there', async () => {
    const repo = makeRepo();
    const { api, setHooks, orchestrator, session, waiting, release, finished } = setup(repo);
    await setHooks({
      afterEdit: [
        { name: 'ok', command: 'echo pronto; touch saida.txt', timeoutSec: 10, enabled: true },
        { name: 'ruim', command: 'exit 2', timeoutSec: 10, enabled: false },
      ],
    });
    const ok = await api('/api/projects/p/hooks/test', { method: 'POST', body: { index: 0 } });
    expect(ok).toMatchObject({ status: 200, body: { name: 'ok', status: 'passed', exitCode: 0, output: 'pronto\n' } });
    expect(existsSync(join(repo, 'saida.txt'))).toBe(true);
    // A disabled check can still be tested by hand.
    expect(await api('/api/projects/p/hooks/test', { method: 'POST', body: { index: 1 } })).toMatchObject({
      status: 200,
      body: { status: 'failed', exitCode: 2 },
    });
    expect((await api('/api/projects/p/hooks/test', { method: 'POST', body: { index: 4 } })).status).toBe(404);
    expect((await api('/api/projects/p/hooks/test', { method: 'POST', body: { index: -1 } })).status).toBe(400);
    expect((await api('/api/projects/nao/hooks/test', { method: 'POST', body: { index: 0 } })).status).toBe(404);

    const { runId } = await orchestrator.start(session(), '[esperar]');
    await waiting();
    const busy = await api('/api/projects/p/hooks/test', { method: 'POST', body: { index: 0 } });
    expect(busy.status).toBe(409);
    release();
    await finished(runId);
  });
});

describe.skipIf(!hasBwrap)('after-edit checks', () => {
  it('runs enabled checks in order after a completed run that changed files', async () => {
    const repo = makeRepo();
    const { orchestrator, session, finished, checks, settled, setHooks, store } = setup(repo);
    await setHooks({
      afterEdit: [
        { name: 'primeira', command: 'echo 1 >> ordem.log', timeoutSec: 10, enabled: true },
        { name: 'desligada', command: 'echo x >> ordem.log', timeoutSec: 10, enabled: false },
        { name: 'segunda', command: 'echo 2 >> ordem.log; echo falhou >&2; exit 1', timeoutSec: 10, enabled: true },
      ],
    });
    const s = session();
    const { runId } = await orchestrator.start(s, 'altere');
    const run = await finished(runId);
    expect(run.checkpoint?.files?.length).toBeGreaterThan(0);
    await settled(s.id, 2);
    expect(readFileSync(join(repo, 'ordem.log'), 'utf8')).toBe('1\n2\n');
    const final = checks(s.id, runId).map((e) => e.text);
    expect(final).toContain('Verificação: primeira passou (0 s)');
    expect(final).toContain('Verificação: segunda falhou (código 1)');
    const second = checks(s.id, runId).find((e) => e.check.name === 'segunda')!;
    expect(second.check.output).toContain('falhou');
    // Auto-fix is off by default: no follow-up run.
    expect(store.listRuns(s.id)).toHaveLength(1);
  });

  it('skips runs that changed nothing, failed or could not write', async () => {
    const repo = makeRepo();
    const ctx = setup(repo);
    await ctx.setHooks({
      afterEdit: [{ name: 'c', command: 'echo rodou >> marca.log', timeoutSec: 10, enabled: true }],
    });
    const s = ctx.session();
    for (const prompt of ['[nada]', '[falhar]']) {
      const { runId } = await ctx.orchestrator.start(s, prompt);
      await ctx.finished(runId);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.checks(s.id)).toEqual([]);
    expect(existsSync(join(repo, 'marca.log'))).toBe(false);

    const other = makeRepo();
    const readOnly = setup(other, { sandbox: 'read-only' });
    await readOnly.setHooks({ afterEdit: [{ name: 'c', command: 'true', timeoutSec: 10, enabled: true }] });
    const rs = readOnly.session();
    const { runId } = await readOnly.orchestrator.start(rs, 'altere');
    expect((await readOnly.finished(runId)).checkpoint).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(readOnly.checks(rs.id)).toEqual([]);
  });

  it('kills a check that exceeds its time limit', async () => {
    const repo = makeRepo();
    const { orchestrator, session, finished, checks, settled, setHooks } = setup(repo);
    await setHooks({ afterEdit: [{ name: 'lenta', command: 'echo inicio; sleep 60', timeoutSec: 5, enabled: true }] });
    const s = session();
    const started = Date.now();
    await finished((await orchestrator.start(s, 'altere')).runId);
    await settled(s.id, 1);
    expect(Date.now() - started).toBeLessThan(9000);
    expect(checks(s.id)[0]!.check).toMatchObject({ status: 'timeout', output: 'inicio\n' });
  }, 15_000);

  it('cancels running checks when a new run starts in the project', async () => {
    const repo = makeRepo();
    const { orchestrator, session, finished, checks, settled, setHooks, store } = setup(repo);
    await setHooks({ afterEdit: [{ name: 'longa', command: 'sleep 60', timeoutSec: 120, enabled: true }] });
    const s = session();
    const first = await orchestrator.start(s, 'altere');
    await finished(first.runId);
    await until(() => checks(s.id).some((e) => e.check.status === 'running'));
    const second = await orchestrator.start(store.getSession(s.id)!, '[nada]');
    await finished(second.runId);
    await settled(s.id, 1);
    expect(checks(s.id, first.runId)[0]!.text).toBe('Verificação: longa cancelada: nova execução neste projeto');
  });
});

describe('automatic fix', () => {
  it('starts one follow-up run with the bounded failure output, never a second one', async () => {
    const repo = makeRepo();
    let calls = 0;
    const runner: typeof runCheck = async (check) => {
      calls++;
      return {
        name: check.name,
        status: 'failed',
        exitCode: 1,
        durationMs: 5,
        output: `${'x'.repeat(30_000)}ERRO-FINAL`,
      };
    };
    const { orchestrator, session, finished, store, setHooks, inputs } = setup(repo, { runner });
    await setHooks({
      afterEdit: [{ name: 'testes', command: 'npm test', timeoutSec: 60, enabled: true }],
      autoFix: true,
    });
    const s = session();
    const { runId } = await orchestrator.start(s, 'altere');
    await finished(runId);
    await until(() => store.listRuns(s.id).length === 2);
    const fix = store.listRuns(s.id).find((r) => r.id !== runId)!;
    expect(fix.hookFix).toEqual({ sourceRunId: runId });
    await finished(fix.id);
    // The fix run changed files and its checks failed again: still no third run.
    await until(() => calls === 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(store.listRuns(s.id)).toHaveLength(2);
    const fixInput = inputs.find((i) => i.runId === fix.id)!;
    expect(fixInput.prompt).toContain('ERRO-FINAL');
    expect(fixInput.prompt).toContain('dados não confiáveis');
    expect(fixInput.prompt).not.toContain('x'.repeat(8193));
    const label = store.listMessages(s.id).find((m) => m.runId === fix.id && m.role === 'user')!;
    expect(label.content).toBe('Corrigir automaticamente: a verificação “testes” falhou');
  });
});

describe('blocked commands', () => {
  it('denies a matching approval at once, even in auto-approve mode, and never approves', async () => {
    const repo = makeRepo();
    const { orchestrator, session, finished, store, setHooks, answered, inputs, decide } = setup(repo);
    store.setSettings({ ...store.getSettings()!, approvalMode: 'auto-safe' });
    await setHooks({ blockedCommands: ['git push*', 'rm -rf *'] });
    const s = session();
    const { runId } = await orchestrator.start(s, '[aprovar] git   push origin main');
    const run = await finished(runId);
    expect(run.status).toBe('completed');
    expect(inputs[0]!.blockedCommands).toEqual(['git push*', 'rm -rf *']);
    expect(answered).toEqual([{ id: `${runId}:a1`, decision: 'deny' }]);
    expect(store.listApprovals(s.id)).toMatchObject([{ status: 'denied', blocked: 'git push*' }]);
    expect(store.listEvents(s.id).map((e) => e.text)).toContain(
      'Comando bloqueado pelas regras do projeto: git push origin main',
    );
    expect(store.listMessages(s.id).find((m) => m.runId === runId && m.role === 'assistant')?.content).toBe('deny');

    // An allowed command still waits for the user.
    const other = await orchestrator.start(store.getSession(s.id)!, '[aprovar] echo ok');
    await until(() => store.listApprovals(s.id).some((a) => a.status === 'pending'));
    // Rules saved while it waits apply too: approving is refused, and the request is denied.
    await setHooks({ blockedCommands: ['echo *'] });
    const pending = store.listApprovals(s.id).find((a) => a.status === 'pending')!;
    expect((await decide(s.id, pending.id, 'approve')).status).toBe(409);
    await finished(other.runId);
    expect(store.getApproval(pending.id)).toMatchObject({ status: 'denied', blocked: 'echo *' });
    expect(answered.at(-1)).toEqual({ id: pending.id, decision: 'deny' });
  });

  it('records a denial made by the provider without answering it again', async () => {
    const repo = makeRepo();
    const { orchestrator, session, finished, store, setHooks, answered } = setup(repo);
    await setHooks({ blockedCommands: ['git push*'] });
    const s = session();
    await finished((await orchestrator.start(s, '[negado-provedor]')).runId);
    expect(answered).toEqual([]);
    expect(store.listApprovals(s.id)).toMatchObject([{ status: 'denied', blocked: 'git push*' }]);
    expect(store.listEvents(s.id).find((e) => e.type === 'approval')).toMatchObject({
      text: 'Comando bloqueado pelas regras do projeto: git push',
      status: 'blocked',
      error: 'Padrão: git push*',
    });
  });

  it('applies no project rules to detached conversations', async () => {
    const repo = makeRepo();
    const { orchestrator, session, finished, store, setHooks, answered, inputs } = setup(repo);
    await setHooks({ blockedCommands: ['*'] });
    const detached = session(null);
    const { runId } = await orchestrator.start(detached, '[aprovar] git push');
    await until(() => store.listApprovals(detached.id).some((a) => a.status === 'pending'));
    expect(answered).toEqual([]);
    expect(inputs[0]!.blockedCommands).toBeUndefined();
    await orchestrator.cancel(detached.id);
    await finished(runId);
  });
});
