import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HookChecks, runCheck } from '../server/hooks';
import { RunEvidenceStore, type RunEvidenceRecord } from '../server/run-evidence';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('persisted run evidence consumers', () => {
  it('reloads evidence outside the project tree and pages full check logs only on demand', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'adelic-evidence-'));
    roots.push(dataDir);
    const runId = '2fa9bd61-5bd7-4cfe-a395-1b9f4f1ad82d';
    const eventId = '2f99bd61-5bd7-4cfe-a395-1b9f4f1ad82d';
    const record: RunEvidenceRecord = {
      runId,
      sessionId: 'session-1',
      capturedAt: new Date().toISOString(),
      source: { state: 'changed', runId },
      environment: [{ eventId, environment: { state: 'observed', digest: 'sha256:abc' } }],
      artifacts: { status: 'available', files: [{ path: 'integrated.ts', status: 'modified' }] },
      checks: [
        {
          eventId,
          name: 'test',
          status: 'failed',
          exitCode: 1,
          command: 'npm test',
          output: 'failure log secret-marker',
          operationalLog: { status: 'available', bytes: 10 },
          source: { state: 'changed' },
          environment: { state: 'observed', digest: 'sha256:abc' },
        },
      ],
      outcome: { status: 'completed' },
      review: 'bounded reviewer excerpt',
      fullReview: 'bounded reviewer excerpt ... FINAL-ONLY-MARKER',
    };
    const first = new RunEvidenceStore(dataDir);
    const logWriter = await first.beginCheckLog(runId, eventId);
    logWriter.write(Buffer.from('0123456789'));
    expect(await logWriter.finish()).toEqual({ status: 'available', bytes: 10 });
    const file = await first.put(record);
    expect(file).toContain(join('run-evidence', runId + '.json'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const reloaded = new RunEvidenceStore(dataDir);
    expect(await reloaded.get(runId)).toEqual(record);

    const server = reloaded.mcpServer(runId);
    const call = (id: number, arguments_: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'get_run_evidence', arguments: arguments_ },
      });
    const replies = spawnSync(server.command, server.args, {
      encoding: 'utf8',
      input:
        [
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
          call(3, {}),
          call(4, { checkEventId: eventId, offset: 0, limit: 7 }),
          call(5, { checkEventId: eventId, offset: 7, limit: 7 }),
          call(6, { review: true, offset: 0, limit: 24 }),
          call(7, { review: true, offset: 24, limit: 40 }),
        ].join('\n') + '\n',
      env: { ...process.env, ...server.env },
    });
    expect(replies.status).toBe(0);
    const messages = replies.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(messages[1].result.tools.map((tool: { name: string }) => tool.name)).toContain('get_run_evidence');
    const index = messages[2].result.content[0].text;
    expect(index).toContain(eventId);
    expect(index).toContain('integrated.ts');
    expect(index).not.toContain('failure log secret-marker');
    expect(index).toContain('bounded reviewer excerpt');
    expect(index).not.toContain('FINAL-ONLY-MARKER');
    const firstPage = JSON.parse(messages[3].result.content[0].text);
    expect(firstPage).toMatchObject({ output: '0123456', nextOffset: 7, completeLogAvailable: true });
    const secondPage = JSON.parse(messages[4].result.content[0].text);
    expect(secondPage).toMatchObject({ output: '789', nextOffset: null });
    expect(JSON.parse(messages[5].result.content[0].text)).toMatchObject({
      review: 'bounded reviewer excerpt',
      nextOffset: 24,
    });
    expect(JSON.parse(messages[6].result.content[0].text).review).toContain('FINAL-ONLY-MARKER');
    expect(await readFile(file, 'utf8')).toContain('failure log secret-marker');
  });

  it('persists real check stdout privately while keeping event output bounded', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'adelic-evidence-check-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'adelic-evidence-project-'));
    roots.push(dataDir, projectDir);
    const evidence = new RunEvidenceStore(dataDir);
    const events: import('../shared/contracts').RunEvent[] = [];
    const hooks = new HookChecks({
      runner: runCheck,
      beginCheckLog: (runId, eventId) => evidence.beginCheckLog(runId, eventId),
      saveEvent: (event) => events.push(event),
      startFix: async () => undefined,
    });
    const runId = randomUUID();
    await hooks.start(
      'project',
      projectDir,
      'workspace-write',
      { id: runId, sessionId: 'session-1' },
      [{ name: 'fixture', command: 'printf complete-operational-log', timeoutSec: 10, enabled: true }],
      false,
    );
    const checkEvent = events.find((event) => event.type === 'check' && event.check?.status === 'passed')!;
    expect(checkEvent.check?.output).toContain('complete-operational-log');
    expect(checkEvent.check?.operationalLog).toMatchObject({ status: 'available' });
    expect(await evidence.getCheckLog(runId, checkEvent.id)).toBe('complete-operational-log');
  });

  it('refuses check-log writes through a symlinked run-evidence ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adelic-evidence-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'adelic-evidence-outside-'));
    roots.push(root, outside);
    await symlink(outside, join(root, 'run-evidence'));
    const runId = '2fa9bd61-5bd7-4cfe-a395-1b9f4f1ad82d';
    const eventId = '2f99bd61-5bd7-4cfe-a395-1b9f4f1ad82d';
    const evidence = new RunEvidenceStore(root);

    await expect(evidence.beginCheckLog(runId, eventId)).rejects.toThrow('evidence directory is not private storage');
    expect(await readdir(outside)).toEqual([]);
    await expect(evidence.getCheckLog(runId, eventId)).rejects.toThrow('evidence directory is not private storage');
    await expect(evidence.get(runId)).rejects.toThrow('evidence directory is not private storage');
    await expect(
      evidence.put({
        runId,
        sessionId: 'session',
        capturedAt: new Date().toISOString(),
        source: null,
        environment: [],
        artifacts: { status: 'unknown' },
        checks: [],
        outcome: { status: 'unknown' },
      }),
    ).rejects.toThrow('evidence directory is not private storage');
    expect(await readdir(outside)).toEqual([]);
  });

  it('keeps check logs isolated between valid evidence compartments', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'adelic-evidence-compartment-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'adelic-evidence-compartment-b-'));
    roots.push(firstRoot, secondRoot);
    const runId = randomUUID();
    const eventId = randomUUID();
    const first = new RunEvidenceStore(firstRoot);
    const second = new RunEvidenceStore(secondRoot);

    const writerA = await first.beginCheckLog(runId, eventId);
    writerA.write(Buffer.from('compartment A'));
    expect(await writerA.finish()).toEqual({ status: 'available', bytes: 13 });
    expect(await first.getCheckLog(runId, eventId)).toBe('compartment A');
    expect(await second.getCheckLog(runId, eventId)).toBeUndefined();

    const writerB = await second.beginCheckLog(runId, eventId);
    writerB.write(Buffer.from('compartment B'));
    expect(await writerB.finish()).toEqual({ status: 'available', bytes: 13 });
    expect(await first.getCheckLog(runId, eventId)).toBe('compartment A');
    expect(await second.getCheckLog(runId, eventId)).toBe('compartment B');
  });

  it('serves true empty evidence after put without manually creating a log directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adelic-evidence-empty-'));
    roots.push(root);
    const store = new RunEvidenceStore(root);
    const runId = randomUUID();
    const record: RunEvidenceRecord = {
      runId,
      sessionId: 'session-empty',
      capturedAt: new Date().toISOString(),
      source: { state: 'unchanged' },
      environment: [],
      artifacts: { status: 'available', files: [] },
      checks: [],
      outcome: { status: 'completed' },
    };

    await store.put(record);
    expect(await store.get(runId)).toEqual(record);
    expect(await store.getCheckLog(runId, randomUUID())).toBeUndefined();

    const server = store.mcpServer(runId);
    const replies = spawnSync(server.command, server.args, {
      encoding: 'utf8',
      input:
        [
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'get_run_evidence', arguments: {} },
          }),
        ].join('\n') + String.fromCharCode(10),
      env: { ...process.env, ...server.env },
    });
    expect(replies.status).toBe(0);
    const messages = replies.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(JSON.parse(messages[1].result.content[0].text)).toMatchObject({
      runId,
      sessionId: 'session-empty',
      checks: [],
      artifacts: { status: 'available', files: [] },
      outcome: { status: 'completed' },
    });
  });

  it('serializes refreshes with review writes and preserves review evidence in the terminal snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adelic-evidence-race-'));
    roots.push(root);
    const store = new RunEvidenceStore(root);
    const runId = randomUUID();
    const base = {
      runId,
      sessionId: 'session-race',
      capturedAt: new Date().toISOString(),
      source: { state: 'unchanged' },
      environment: [],
      artifacts: { status: 'available', files: [] },
      checks: [],
    };
    let releaseRefresh!: () => void;
    let refreshEntered!: () => void;
    const holdRefresh = new Promise<void>((resolve) => (releaseRefresh = resolve));
    const refreshStarted = new Promise<void>((resolve) => (refreshEntered = resolve));
    const storage = store as unknown as {
      writeRecord(record: RunEvidenceRecord): Promise<string>;
    };
    const originalWrite = storage.writeRecord.bind(store);
    storage.writeRecord = async (record) => {
      if (record.outcome.status === 'running') {
        refreshEntered();
        await holdRefresh;
      }
      return originalWrite(record);
    };

    const oldRefresh = store.put({ ...base, outcome: { status: 'running' } });
    await refreshStarted;
    const reviewWrite = store.put({
      ...base,
      outcome: { status: 'running' },
      workers: [{ taskId: 'worker-1', status: 'completed' }],
      review: 'bounded review',
      fullReview: 'complete review',
    });
    const terminalRefresh = store.put({ ...base, outcome: { status: 'completed' } });
    releaseRefresh();
    await Promise.all([oldRefresh, reviewWrite, terminalRefresh]);

    expect(await store.get(runId)).toMatchObject({
      outcome: { status: 'completed' },
      workers: [{ taskId: 'worker-1', status: 'completed' }],
      review: 'bounded review',
      fullReview: 'complete review',
    });
  });

  it('returns unknown for an unavailable artifact instead of inventing source evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adelic-evidence-missing-'));
    roots.push(root);
    const store = new RunEvidenceStore(root);
    const runId = '2fa9bd61-5bd7-4cfe-a395-1b9f4f1ad82d';
    await store.put({
      runId,
      sessionId: 'session-unknown',
      capturedAt: new Date().toISOString(),
      source: { state: 'unknown' },
      environment: [],
      artifacts: { status: 'unknown', reason: 'capture failed' },
      checks: [],
      outcome: { status: 'interrupted' },
    });
    expect(await store.get(runId)).toMatchObject({ artifacts: { status: 'unknown' }, source: { state: 'unknown' } });
  });
});
