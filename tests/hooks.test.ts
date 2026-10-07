import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECK_OUTPUT_MAX,
  FIX_OUTPUT_MAX,
  blockedBy,
  checkHeadline,
  commandCandidates,
  globMatch,
  normalizeCommand,
  type AfterEditCheck,
  type CheckResult,
} from '../shared/hooks.js';
import { HookTestSchema, ProjectHooksSchema, parseBody } from '../shared/schemas.js';
import { HookChecks, checkEnvironment, fixLabel, fixPrompt, runCheck } from '../server/hooks.js';
import type { RunEvent } from '../shared/contracts.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'adelic-hooks-')));
  dirs.push(dir);
  return dir;
};
const check = (command: string, extra: Partial<AfterEditCheck> = {}): AfterEditCheck => ({
  name: 'teste',
  command,
  timeoutSec: 10,
  enabled: true,
  ...extra,
});
const never = new AbortController().signal;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('blocked command patterns', () => {
  it('matches the whole text with * as the only wildcard', () => {
    expect(globMatch('git push*', 'git push origin main')).toBe(true);
    expect(globMatch('git push*', 'git pushx')).toBe(true);
    expect(globMatch('git push', 'git push origin')).toBe(false);
    expect(globMatch('rm -rf *', 'rm -rf /')).toBe(true);
    expect(globMatch('rm -rf *', 'rm -r dist')).toBe(false);
    expect(globMatch('*sudo*', 'echo && sudo reboot')).toBe(true);
    expect(globMatch('', '')).toBe(true);
    expect(globMatch('**', 'qualquer')).toBe(true);
  });
  it('treats regex syntax as literal text and stays fast on hostile patterns', () => {
    expect(globMatch('rm .*', 'rm -rf x')).toBe(false);
    expect(globMatch('rm .*', 'rm .*')).toBe(true);
    expect(globMatch('a+b', 'aab')).toBe(false);
    expect(globMatch('(x|y)?', 'x')).toBe(false);
    expect(globMatch('[ab]', 'a')).toBe(false);
    const started = Date.now();
    expect(globMatch(`${'*a'.repeat(50)}b`, 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('normalises whitespace in commands and patterns', () => {
    expect(normalizeCommand('  git\t push \n origin  ')).toBe('git push origin');
    expect(blockedBy(['git   push*'], 'git\tpush   --force')).toBe('git   push*');
    expect(blockedBy(['git push*'], 'git status')).toBeUndefined();
    expect(blockedBy([], 'git push')).toBeUndefined();
    expect(blockedBy(['*'], undefined)).toBeUndefined();
    expect(blockedBy(['*'], '   ')).toBeUndefined();
  });
  it('also checks shell wrappers and each part of a compound command', () => {
    expect(commandCandidates("/bin/bash -lc 'npm test && git push origin'")).toEqual(
      expect.arrayContaining([
        "/bin/bash -lc 'npm test && git push origin'",
        'npm test && git push origin',
        'git push origin',
      ]),
    );
    expect(blockedBy(['git push*'], 'bash -lc "git status; git push"')).toBe('git push*');
    expect(blockedBy(['rm -rf *'], 'ls | rm -rf build')).toBe('rm -rf *');
    expect(blockedBy(['rm -rf *'], '(cd x && rm -rf y)')).toBe('rm -rf *');
    expect(blockedBy(['curl *'], "sh -c 'curl '\\''x'\\'''")).toBe('curl *');
  });
});

describe('hooks request schemas', () => {
  it('fills defaults, trims and normalises', () => {
    expect(
      parseBody(
        ProjectHooksSchema,
        { afterEdit: [{ name: ' testes ', command: ' npm test ' }], blockedCommands: ['git   push*'] },
        'x',
      ),
    ).toEqual({
      ok: true,
      data: {
        afterEdit: [{ name: 'testes', command: 'npm test', timeoutSec: 120, enabled: true }],
        blockedCommands: ['git push*'],
        autoFix: false,
      },
    });
    expect(parseBody(ProjectHooksSchema, {}, 'x')).toEqual({
      ok: true,
      data: { afterEdit: [], blockedCommands: [], autoFix: false },
    });
  });
  it('enforces the limits', () => {
    const ok = (body: unknown) => parseBody(ProjectHooksSchema, body, 'x').ok;
    const item = { name: 'n', command: 'true' };
    expect(ok({ afterEdit: Array(5).fill(item) })).toBe(true);
    expect(ok({ afterEdit: Array(6).fill(item) })).toBe(false);
    expect(ok({ afterEdit: [{ ...item, command: 'x'.repeat(500) }] })).toBe(true);
    expect(ok({ afterEdit: [{ ...item, command: 'x'.repeat(501) }] })).toBe(false);
    expect(ok({ afterEdit: [{ ...item, command: '   ' }] })).toBe(false);
    expect(ok({ afterEdit: [{ ...item, timeoutSec: 4 }] })).toBe(false);
    expect(ok({ afterEdit: [{ ...item, timeoutSec: 5 }] })).toBe(true);
    expect(ok({ afterEdit: [{ ...item, timeoutSec: 600 }] })).toBe(true);
    expect(ok({ afterEdit: [{ ...item, timeoutSec: 601 }] })).toBe(false);
    expect(ok({ afterEdit: [{ ...item, timeoutSec: 10.5 }] })).toBe(false);
    expect(ok({ afterEdit: [{ ...item, extra: 1 }] })).toBe(false);
    expect(ok({ blockedCommands: Array.from({ length: 30 }, (_, i) => `c${i}`) })).toBe(true);
    expect(ok({ blockedCommands: Array.from({ length: 31 }, (_, i) => `c${i}`) })).toBe(false);
    expect(ok({ blockedCommands: ['a', 'a'] })).toBe(false);
    expect(ok({ blockedCommands: [''] })).toBe(false);
    expect(ok({ autoFix: 'sim' })).toBe(false);
    expect(ok({ other: true })).toBe(false);
    expect(parseBody(HookTestSchema, { index: 0 }, 'x')).toEqual({ ok: true, data: { index: 0 } });
    expect(parseBody(HookTestSchema, { index: 5 }, 'x').ok).toBe(false);
  });
});

describe('check helpers', () => {
  it('describes each outcome', () => {
    const base: CheckResult = { name: 'testes', status: 'passed', durationMs: 12_300 };
    expect(checkHeadline(base)).toBe('Verificação: testes passou (12 s)');
    expect(checkHeadline({ ...base, status: 'failed', exitCode: 1 })).toBe('Verificação: testes falhou (código 1)');
    expect(checkHeadline({ ...base, status: 'timeout' })).toBe('Verificação: testes excedeu o tempo limite (12 s)');
    expect(checkHeadline({ name: 'x', status: 'running' })).toBe('Verificação: x em andamento');
    expect(checkHeadline({ name: 'x', status: 'cancelled', detail: 'nova execução' })).toBe(
      'Verificação: x cancelada: nova execução',
    );
    expect(checkHeadline({ name: 'x', status: 'error', detail: 'sem bwrap' })).toBe(
      'Verificação: x não pôde rodar: sem bwrap',
    );
  });
  it('bounds the failure output sent to the fix run and marks it as data', () => {
    const failures: CheckResult[] = [
      { name: 'a', status: 'failed', exitCode: 1, output: `${'x'.repeat(20_000)}FIM-A` },
      { name: 'b', status: 'timeout', output: 'saída b' },
    ];
    const prompt = fixPrompt(failures);
    expect(prompt).toContain('FIM-A');
    expect(prompt).toContain('saída b');
    expect(prompt).not.toContain('x'.repeat(FIX_OUTPUT_MAX / 2 + 1));
    expect(prompt.length).toBeLessThan(FIX_OUTPUT_MAX + 1500);
    expect(prompt).toContain('dados não confiáveis');
    expect(fixLabel(failures)).toBe('Corrigir automaticamente: as verificações “a”, “b” falharam');
  });
  it('passes only neutral variables to checks', () => {
    const env = checkEnvironment({
      PATH: '/usr/bin',
      HOME: '/h',
      ADELIC_MEMORY_TOKEN: 's',
      GITHUB_TOKEN: 't',
      LC_ALL: 'C',
    });
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/h', LC_ALL: 'C', TMPDIR: '/tmp', CI: '1' });
    expect(env).not.toHaveProperty('ADELIC_MEMORY_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

describe('HookChecks', () => {
  it('runs checks in order, records each one and starts the fix once after failures', async () => {
    const events = new Map<string, RunEvent>();
    const order: string[] = [];
    const fixes: CheckResult[][] = [];
    const hooks = new HookChecks({
      saveEvent: (event) => events.set(event.id, event),
      startFix: async (_s, _r, failures) => void fixes.push(failures),
      runner: async (item) => {
        order.push(item.name);
        return { name: item.name, status: item.command === 'false' ? 'failed' : 'passed', exitCode: 0, durationMs: 1 };
      },
    });
    const run = { id: 'r', sessionId: 's' };
    const list = [check('true', { name: 'um' }), check('false', { name: 'dois' }), check('true', { name: 'três' })];
    await hooks.start('p', '/tmp', 'workspace-write', run, list, true);
    expect(order).toEqual(['um', 'dois', 'três']);
    expect([...events.values()].map((e) => e.check?.status)).toEqual(['passed', 'failed', 'passed']);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.map((f) => f.name)).toEqual(['dois']);
    await hooks.start('p', '/tmp', 'workspace-write', run, list, false);
    expect(fixes).toHaveLength(1);
    expect(hooks.running('p')).toBe(false);
  });
  it('notes a fix that could not start, and stops at cancellation without fixing', async () => {
    const events: RunEvent[] = [];
    let release!: () => void;
    const hooks = new HookChecks({
      saveEvent: (event) => events.push(event),
      startFix: async () => {
        throw new Error('conversa ocupada');
      },
      runner: async (item, _cwd, options) => {
        if (item.name === 'lento')
          await new Promise<void>((resolve) => {
            release = resolve;
            options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
        return {
          name: item.name,
          status: options.signal.aborted ? 'cancelled' : 'failed',
          exitCode: 1,
          detail: String(options.signal.reason ?? ''),
        };
      },
    });
    const run = { id: 'r', sessionId: 's' };
    await hooks.start('p', '/tmp', 'workspace-write', run, [check('false')], true);
    expect(events.at(-1)?.text).toBe('Correção automática não iniciada: conversa ocupada');

    events.length = 0;
    const batch = hooks.start('p', '/tmp', 'workspace-write', run, [check('x', { name: 'lento' }), check('y')], true);
    expect(hooks.running('p')).toBe(true);
    // A second batch for the same project does not start while one runs.
    await hooks.start('p', '/tmp', 'workspace-write', run, [check('z', { name: 'outro' })], true);
    await hooks.cancel('p', 'nova execução neste projeto');
    await batch;
    expect(release).toBeTypeOf('function');
    const results = events.filter((e) => e.type === 'check' && e.check?.status !== 'running');
    expect(results.map((e) => e.text)).toEqual(['Verificação: lento cancelada: nova execução neste projeto']);
    expect(events.some((e) => e.type === 'status')).toBe(false);
  });
});

describe.skipIf(!existsSync('/usr/bin/bwrap'))('checks inside the real bubblewrap sandbox', () => {
  it('reports success and the exit code of a failure', async () => {
    const dir = tempDir();
    const passed = await runCheck(check('true'), dir, { sandbox: 'workspace-write', signal: never });
    expect(passed).toMatchObject({ status: 'passed', exitCode: 0 });
    const failed = await runCheck(check('echo falhou >&2; exit 3'), dir, { sandbox: 'workspace-write', signal: never });
    expect(failed).toMatchObject({ status: 'failed', exitCode: 3, output: 'falhou\n' });
    expect(checkHeadline(failed)).toBe('Verificação: teste falhou (código 3)');
  });
  it('writes only inside the project, with a private /tmp and no network', async () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'alvo.txt'), 'original');
    const result = await runCheck(
      check(
        `echo cache > build.txt; echo x > ${outside}/alvo.txt 2>/dev/null && echo ESCREVEU_FORA; echo t > /tmp/t && echo TMP_OK; tail -n +3 /proc/net/dev | grep -v ' lo:' | wc -l`,
      ),
      dir,
      { sandbox: 'workspace-write', signal: never },
    );
    expect(result.status, result.output).toBe('passed');
    expect(readFileSync(join(dir, 'build.txt'), 'utf8')).toBe('cache\n');
    expect(readFileSync(join(outside, 'alvo.txt'), 'utf8')).toBe('original');
    expect(result.output).not.toContain('ESCREVEU_FORA');
    expect(result.output).toContain('TMP_OK');
    // Only the loopback interface exists in the check's network namespace.
    expect(result.output?.trim().split('\n').at(-1)).toBe('0');
    const readOnly = await runCheck(check('touch x'), dir, { sandbox: 'read-only', signal: never });
    expect(readOnly.status).toBe('failed');
  });
  it('kills the whole process group on timeout and on cancel', async () => {
    const dir = tempDir();
    // `sleep` in the background with its pid written to the project (visible outside).
    const sleeper = '(sleep 300 & echo $! > /dev/null; wait) & echo started; wait';
    const before = Date.now();
    const timedOut = await runCheck(check(sleeper, { timeoutSec: 1 }), dir, {
      sandbox: 'workspace-write',
      signal: never,
    });
    expect(timedOut.status).toBe('timeout');
    expect(Date.now() - before).toBeLessThan(6000);
    expect(timedOut.output).toContain('started');

    const controller = new AbortController();
    const marker = `adelic-hook-${process.pid}-${Date.now()}`;
    // `exec -a` is a bash extension (Debian/Ubuntu's /bin/sh is dash): the marker is an argument
    // of a child `sh -c` instead, which `pgrep -f` matches on any POSIX shell.
    const pending = runCheck(check(`sh -c 'sleep 300; :' ${marker}`, { timeoutSec: 60 }), dir, {
      sandbox: 'workspace-write',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 400));
    const pids = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').map(Number);
    expect(pids.length).toBeGreaterThan(0);
    controller.abort('cancelada pelo teste');
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ status: 'cancelled', detail: 'cancelada pelo teste' });
    expect(pids.filter(alive)).toEqual([]);
  });
  it('keeps only the last 64 KB of output and reports progress', async () => {
    const dir = tempDir();
    const progress: string[] = [];
    const result = await runCheck(check(`head -c 200000 /dev/zero | tr '\\0' a; sleep 0.3; echo FIM`), dir, {
      sandbox: 'workspace-write',
      signal: never,
      progressMs: 50,
      onProgress: (output) => progress.push(output),
    });
    expect(result.status).toBe('passed');
    expect(result.truncated).toBe(true);
    expect(result.output!.length).toBe(CHECK_OUTPUT_MAX);
    expect(result.output!.endsWith('aFIM\n')).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.length <= CHECK_OUTPUT_MAX)).toBe(true);
  });
  it('reports a sandbox that cannot be built instead of running unconfined', async () => {
    const result = await runCheck(check('true'), join(tempDir(), 'não existe'), {
      sandbox: 'workspace-write',
      signal: never,
    });
    expect(result.status).toBe('error');
    const wrapped = await runCheck(check('true'), tempDir(), {
      sandbox: 'workspace-write',
      signal: never,
      wrap: async () => {
        throw new Error('Política de filesystem indisponível: bubblewrap não está instalado.');
      },
    });
    expect(wrapped).toMatchObject({ status: 'error', detail: expect.stringContaining('bubblewrap') });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await runCheck(check('true'), tempDir(), { sandbox: 'workspace-write', signal: aborted.signal }),
    ).toMatchObject({ status: 'cancelled' });
  });
});
