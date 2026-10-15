#!/usr/bin/env node

/** Frozen, local-only direct-vs-coordinated journey pilot. --run is deliberately gated. */
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nativeTurnUsage, nativeUsageSnapshot } from './benchmark-usage.mjs';

export const MODEL = process.env.ADELIC_JOURNEY_MODEL ?? 'gpt-6-luna';
export const EFFORT = 'high';
export const JOURNEY_LIMIT_MS = 180_000;
export const FINALIZATION_RESERVE_MS = 30_000;
export const MAX_ATTEMPTS = 12;
export const PROFILE_ORDER = ['direct', 'coordinated'];
const ROOT = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = join(ROOT, 'fixtures', 'general-journeys');
export const EVAL_ROOT = resolve(process.env.ADELIC_JOURNEY_ROOT ?? '/tmp/adelic-general-journeys');
const BASE_URL = process.env.ADELIC_JOURNEY_URL ?? 'http://127.0.0.1:4790';
const EXPLICIT_RUN_AUTH = 'I_AUTHORIZE_LOCAL_GENERAL_JOURNEY_RUNS';
const tasks = [
  { id: 'inspection', turns: ['PROMPT.md'], type: 'inspection' },
  { id: 'cohesive-change', turns: ['PROMPT.md'], type: 'cohesive-change' },
  { id: 'bug-regression', turns: ['PROMPT.md'], type: 'bug-regression' },
  { id: 'continuation', turns: ['PROMPT.md', 'FOLLOWUP.md'], type: 'continuation' },
  { id: 'multi-area', turns: ['PROMPT.md'], type: 'multi-area' },
  { id: 'missing-runtime', turns: ['PROMPT.md'], type: 'missing-runtime' },
];
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const iso = () => new Date().toISOString();

export function parseArgs(argv) {
  const options = { mode: 'preflight', journey: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (['--help', '-h'].includes(argv[i])) options.mode = 'help';
    else if (argv[i] === '--dry-run') options.mode = 'dry-run';
    else if (argv[i] === '--preflight') options.mode = 'preflight';
    else if (argv[i] === '--run') options.mode = 'run';
    else if (argv[i] === '--journey') {
      const journey = argv[++i];
      if (!journey) throw new Error('--journey requires a journey ID');
      if (!tasks.some((task) => task.id === journey))
        throw new Error(`Unknown journey ${journey}; choose one of: ${tasks.map((task) => task.id).join(', ')}`);
      if (options.journey) throw new Error('--journey may be specified only once');
      options.journey = journey;
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

export function selectedJourneyTasks(journey = null) {
  if (!journey) return tasks;
  const selected = tasks.find((task) => task.id === journey);
  if (!selected)
    throw new Error(`Unknown journey ${journey}; choose one of: ${tasks.map((task) => task.id).join(', ')}`);
  return [selected];
}

export function maxAttemptsFor(journey = null) {
  return selectedJourneyTasks(journey).length * PROFILE_ORDER.length;
}

export function collectExecutedTaskIds(turns) {
  return new Set(
    turns
      .flatMap((turn) => [
        ...(turn.providerAttemptDetails ?? []).map((attempt) => attempt.taskId),
        ...(turn.providerTaskIds ?? []),
      ])
      .filter((taskId) => typeof taskId === 'string' && taskId.length > 0),
  );
}

export function observedProviderCall(providerAttemptCount, traceProviderAttempts) {
  if (Number.isSafeInteger(providerAttemptCount) && providerAttemptCount >= 0) return providerAttemptCount > 0;
  if (Number.isSafeInteger(traceProviderAttempts) && traceProviderAttempts >= 0) return traceProviderAttempts > 0;
  return null;
}

export function rolesForExecutedTasks(detail, executedTaskIds) {
  return (detail.tasks ?? [])
    .filter((task) => executedTaskIds.has(task.id))
    .map((task) => ({
      taskId: task.id,
      role: task.role ?? 'worker',
      providerId: task.providerId ?? task.provider,
      model: task.model ?? null,
      effort: task.effort ?? null,
    }));
}

export function observedProfileStatus(configured, modelObservations, effortObservations) {
  if (!configured || modelObservations.includes(false) || effortObservations.includes(false)) return 'mismatch';
  if (
    modelObservations.includes(null) ||
    effortObservations.includes(null) ||
    !modelObservations.length ||
    !effortObservations.length
  )
    return 'unknown';
  return 'verified';
}

export function applyProfileVerification(attempt, evidence) {
  const status = observedProfileStatus(
    evidence.configuredVerified,
    [evidence.observedModelVerified],
    [evidence.observedEffortVerified],
  );
  attempt.profileVerification = { ...evidence, status, verified: status === 'verified' };
  if (status !== 'verified') {
    const reason =
      status === 'mismatch'
        ? 'known profile model/effort mismatch'
        : 'actual profile model/effort evidence is incomplete';
    attempt.failure = [attempt.failure, reason].filter(Boolean).join('; ');
  }
  return attempt.profileVerification;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function continuationBudget(startedAt, now = Date.now()) {
  const elapsedMs = Math.max(0, now - startedAt);
  const remainingMs = Math.max(0, JOURNEY_LIMIT_MS - elapsedMs);
  if (remainingMs <= FINALIZATION_RESERVE_MS) return { eligible: false, elapsedMs, remainingMs, workMs: 0 };
  return { eligible: true, elapsedMs, remainingMs, workMs: remainingMs - FINALIZATION_RESERVE_MS };
}

export function isJourneyTimeout(waited) {
  return waited?.timedOut === true || waited?.run?.termination === 'timeout';
}

function exec(file, args, { cwd, timeoutMs = 15_000, input, env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

async function api(path, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let value;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = raw;
  }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}

export function validateLoopbackUrl(value) {
  const url = new URL(value);
  const allowed = ['127.0.0.1', 'localhost', '::1', '[::1]'];
  if (url.protocol !== 'http:' || !allowed.includes(url.hostname))
    throw new Error('Journey runner requires an HTTP loopback URL');
  return url.href.replace(/\/$/, '');
}

function fixtureInfo(task) {
  const fixture = join(FIXTURE_ROOT, task.id);
  const inputs = {};
  for (const name of task.turns) {
    const path = join(fixture, name);
    if (!existsSync(path)) throw new Error(`Missing frozen prompt ${path}`);
    inputs[name] = readFileSync(path, 'utf8').trim();
  }
  const starter = join(fixture, 'starter');
  if (!existsSync(starter)) throw new Error(`Missing fixture starter ${starter}`);
  const files = [];
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const next = join(rel, name);
      if (lstatSync(abs).isDirectory()) walk(abs, next);
      else files.push({ path: next, sha256: sha256(readFileSync(abs)) });
    }
  };
  walk(starter);
  return {
    fixture,
    starter,
    inputs,
    promptSha256: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, sha256(v)])),
    files,
  };
}

function verifyMissingRuntime() {
  const executable = 'journey-missing-compiler';
  const candidates = (process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((dir) => join(dir, executable));
  const presentAt = candidates.find((path) => existsSync(path)) ?? null;
  if (presentAt)
    throw new Error(`The missing-runtime fixture is invalid on this host; ${executable} exists at ${presentAt}`);
  return { executable, status: 'not found on current PATH', probe: 'filesystem PATH lookup; no command executed' };
}

export function frozenManifest() {
  const graderHelpersSha256 = sha256(readFileSync(join(FIXTURE_ROOT, 'grade-helpers.mjs')));
  return tasks.map((task) => ({
    id: task.id,
    turns: task.turns,
    type: task.type,
    graderSha256: sha256(readFileSync(join(FIXTURE_ROOT, task.id, 'grade.mjs'))),
    graderHelpersSha256,
    ...fixtureInfo(task),
  }));
}

async function preflight(maxJourneyAttempts = MAX_ATTEMPTS) {
  const manifest = frozenManifest();
  const loopback = validateLoopbackUrl(BASE_URL);
  const checks = {
    loopbackUrl: loopback,
    fixturesFrozen: manifest.length === 6,
    maxJourneyAttempts,
    missingRuntimeFixture: verifyMissingRuntime(),
  };
  if (process.env.ADELIC_JOURNEY_CHECK_SERVER === '1') {
    const bootstrap = await api('/api/bootstrap');
    const provider = bootstrap.providers?.find((item) => item.id === 'codex');
    const model = provider?.models?.find((item) => item.id === MODEL);
    checks.server = {
      url: loopback,
      providerAvailable: Boolean(provider?.available),
      modelAvailable: Boolean(model),
      effortAdvertised: model?.efforts?.includes(EFFORT) ?? null,
      sandbox: bootstrap.settings?.sandbox ?? null,
      memoryEnabled: bootstrap.settings?.memoryEnabled ?? null,
      approvalMode: bootstrap.settings?.approvalMode ?? null,
      autoRetry: bootstrap.settings?.autoRetry ?? null,
      autoCompact: bootstrap.settings?.autoCompact ?? null,
      automations: bootstrap.settings?.automations ?? null,
      modelFallbackEnabled: bootstrap.settings?.modelFallback?.enabled ?? false,
    };
    if (!provider?.available || !model || model.efforts?.includes(EFFORT) !== true)
      throw new Error(`Loopback Adelic does not advertise ${MODEL}/${EFFORT}`);
    if (
      bootstrap.settings?.sandbox !== 'workspace-write' ||
      bootstrap.settings?.memoryEnabled !== false ||
      bootstrap.settings?.approvalMode !== 'automatic' ||
      bootstrap.settings?.autoRetry !== false ||
      bootstrap.settings?.autoCompact !== false ||
      bootstrap.settings?.automations !== false ||
      bootstrap.settings?.modelFallback?.enabled === true
    )
      throw new Error('Loopback server settings do not match the isolated benchmark configuration');
  }
  return { checks, manifest };
}

function requireRunAuthorization() {
  if (process.env.ADELIC_JOURNEY_ALLOW_LIVE !== EXPLICIT_RUN_AUTH)
    throw new Error(`--run requires ADELIC_JOURNEY_ALLOW_LIVE=${EXPLICIT_RUN_AUTH}`);
  if (process.env.ADELIC_JOURNEY_ISOLATED_SERVER !== '1')
    throw new Error('--run requires ADELIC_JOURNEY_ISOLATED_SERVER=1 for a disposable, isolated Adelic server');
  if (!process.env.ADELIC_JOURNEY_MODEL) throw new Error('--run requires explicit ADELIC_JOURNEY_MODEL');
  validateLoopbackUrl(BASE_URL);
  if (BASE_URL === 'http://127.0.0.1:4790' && process.env.ADELIC_JOURNEY_URL === undefined)
    throw new Error('--run requires explicitly setting ADELIC_JOURNEY_URL to the isolated server');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function initCheckout(task, profile, runId, info) {
  const path = join(EVAL_ROOT, 'workspaces', `${runId}-${task.id}-${profile}`);
  if (existsSync(path)) throw new Error(`Replay/collision blocked; checkout already exists: ${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  cpSync(info.starter, path, { recursive: true, errorOnExist: true });
  if (task.id === 'missing-runtime') chmodSync(join(path, 'check.sh'), 0o700);
  const init = spawnSyncSafe('git', ['init', '-q'], path);
  const config1 = spawnSyncSafe('git', ['config', 'user.name', 'Adelic Journey Fixture'], path);
  const config2 = spawnSyncSafe('git', ['config', 'user.email', 'journey-fixture@localhost'], path);
  const add = spawnSyncSafe('git', ['add', '-A'], path);
  const commit = spawnSyncSafe('git', ['commit', '-q', '-m', `journey fixture ${task.id}`], path);
  for (const result of [init, config1, config2, add, commit])
    if (result.code !== 0) throw new Error(`Git fixture setup failed: ${result.stderr}`);
  return {
    path,
    fixtureCommit: spawnSyncSafe('git', ['rev-parse', 'HEAD'], path).stdout.trim(),
    baseline: new Map(info.files.map((item) => [item.path, item.sha256])),
  };
}

function spawnSyncSafe(file, args, cwd) {
  // Synchronous Git setup is short, local-only, and happens before model submission.
  const result = spawnSync(file, ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  return { ...result, code: result.status ?? null, stderr: result.stderr ?? result.error?.message ?? '' };
}

export function checkoutChanges(checkout) {
  const current = new Map();
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (!rel && name === '.git') continue;
      const abs = join(dir, name);
      const next = join(rel, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, next);
      else if (st.isSymbolicLink()) current.set(next, sha256(`symlink:${readlinkSync(abs)}`));
      else if (st.isFile()) current.set(next, sha256(readFileSync(abs)));
    }
  };
  walk(checkout.path);
  const names = [...new Set([...checkout.baseline.keys(), ...current.keys()])].sort();
  const changes = names.flatMap((path) => {
    const before = checkout.baseline.get(path) ?? null;
    const after = current.get(path) ?? null;
    return before === after
      ? []
      : [
          {
            path,
            beforeSha256: before,
            afterSha256: after,
            status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
          },
        ];
  });
  return { changes, sha256: sha256(JSON.stringify(changes)) };
}

function appendLedger(record) {
  mkdirSync(EVAL_ROOT, { recursive: true, mode: 0o700 });
  const ledger = join(EVAL_ROOT, 'ledger.jsonl');
  appendFileSync(ledger, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'a' });
}

export function assertUnreplayed(ledgerPath, attemptId) {
  if (!existsSync(ledgerPath)) return;
  const seen = readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => {
      try {
        return JSON.parse(line).attemptId === attemptId;
      } catch {
        return false;
      }
    });
  if (seen) throw new Error(`Replay blocked for journey attempt ${attemptId}`);
}

function getUsage(run) {
  const snapshot = nativeUsageSnapshot(run ?? {});
  return nativeTurnUsage(snapshot);
}

function assertTaskFrozen(task, expected) {
  const current = fixtureInfo(task);
  const graderSha256 = sha256(readFileSync(join(FIXTURE_ROOT, task.id, 'grade.mjs')));
  const graderHelpersSha256 = sha256(readFileSync(join(FIXTURE_ROOT, 'grade-helpers.mjs')));
  if (
    JSON.stringify(current.promptSha256) !== JSON.stringify(expected.promptSha256) ||
    JSON.stringify(current.files) !== JSON.stringify(expected.files) ||
    graderSha256 !== expected.graderSha256 ||
    graderHelpersSha256 !== expected.graderHelpersSha256
  ) {
    const error = new Error(`Frozen journey input changed during the pilot: ${task.id}`);
    error.stopSchedule = true;
    throw error;
  }
}

async function waitRun(sessionId, runId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let detail;
  while (Date.now() < until) {
    detail = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const run = detail.runs?.find((item) => item.id === runId);
    if (run && run.status !== 'running') return { detail, run };
    await new Promise((r) => setTimeout(r, 700));
  }
  return { detail, run: detail?.runs?.find((item) => item.id === runId), timedOut: true };
}

async function cancelRun(sessionId, runId) {
  const failures = [];
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' });
  } catch (error) {
    failures.push(`cancel request: ${error.message}`);
  }
  try {
    const terminal = await waitRun(sessionId, runId, 15_000);
    const terminalStateConfirmed = Boolean(terminal.run && terminal.run.status !== 'running');
    if (!terminalStateConfirmed) failures.push('terminal run state was not confirmed after cancellation');
    return { ...terminal, terminalStateConfirmed, failures };
  } catch (error) {
    return { terminalStateConfirmed: false, failures: [...failures, `terminal polling: ${error.message}`] };
  }
}

async function cancelLatestActiveRun(sessionId) {
  try {
    const detail = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const active = [...(detail.runs ?? [])].reverse().find((run) => run.status === 'running');
    return active ? cancelRun(sessionId, active.id) : { terminalStateConfirmed: true, failures: [] };
  } catch (error) {
    return { terminalStateConfirmed: false, failures: [`could not inspect active run: ${error.message}`] };
  }
}

export async function grade(task, workspace) {
  const code = `import(${JSON.stringify(new URL(`./fixtures/general-journeys/${task.id}/grade.mjs`, import.meta.url).href)})`;
  const graderPath = join(FIXTURE_ROOT, task.id, 'grade.mjs');
  if (!existsSync(graderPath)) throw new Error(`Missing external grader: ${graderPath}`);
  const result = await exec(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${workspace}`,
      `--allow-fs-read=${FIXTURE_ROOT}`,
      '--input-type=module',
      '-e',
      `const m = await ${code}; const result = await m.grade(process.argv[1]); process.stdout.write(JSON.stringify(result));`,
      workspace,
    ],
    { cwd: dirname(graderPath), timeoutMs: 20_000 },
  );
  if (result.code !== 0)
    return {
      accepted: false,
      outcome: result.timedOut ? 'timeout' : 'grader_error',
      detail: result.stderr || result.stdout,
    };
  try {
    const value = JSON.parse(result.stdout);
    return { ...value, accepted: value.accepted === true };
  } catch {
    return { accepted: false, outcome: 'grader_error', detail: 'External grader returned invalid JSON' };
  }
}

function compactTrace(trace, rootRunId) {
  const events = trace.events ?? [];
  const context = events
    .filter((event) => event.name === 'provider.context_input')
    .map((event) => {
      let diagnostics = null;
      try {
        diagnostics = JSON.parse(event.attributes?.contextDiagnostics ?? 'null');
      } catch {
        /* keep unknown */
      }
      return {
        runId: event.runId,
        taskId: event.attributes?.taskId ?? null,
        providerId: event.attributes?.providerId ?? null,
        contextBytes: diagnostics?.observedText?.bytes ?? null,
        promptBytes: diagnostics?.categories?.currentRequest?.bytes ?? null,
        historyBytes: diagnostics?.categories?.history?.bytes ?? null,
      };
    });
  const spans = events
    .filter((event) => event.kind === 'span')
    .map((event) => ({
      name: event.name,
      component: event.component,
      status: event.status,
      durationMs: event.durationMs,
      runId: event.runId,
      parentId: event.parentId,
      phase: event.attributes?.phase ?? null,
      taskId: event.attributes?.taskId ?? null,
    }));
  const providerTaskIds = [
    ...new Set(
      events
        .filter((event) => event.name === 'provider.run')
        .map((event) => event.attributes?.taskId)
        .filter((taskId) => typeof taskId === 'string' && taskId.length > 0),
    ),
  ];
  return {
    eventCount: events.length,
    context,
    spans,
    providerAttempts: spans.filter((event) => event.name === 'provider.run').length,
    providerTaskIds,
    effectiveRunIds: [...new Set(events.map((event) => event.runId))],
    rootRunId,
  };
}

async function runAttempt(task, profile, runId, info, fixture, inputCommit, frozen) {
  const attemptId = `${runId}-${task.id}-${profile}`;
  const journeyStartedAt = Date.now();
  const startedAt = iso();
  const taskIndex = tasks.findIndex((item) => item.id === task.id);
  const orderedProfiles = taskIndex % 2 ? [...PROFILE_ORDER].reverse() : PROFILE_ORDER;
  const attempt = {
    runId,
    attemptId,
    journey: task.id,
    profile,
    orderIndex: taskIndex * 2 + orderedProfiles.indexOf(profile),
    startedAt,
    fixturePreparationMs: inputCommit.fixturePreparationMs,
    fixtureCommit: fixture.path ? inputCommit.fixtureCommit : null,
    model: MODEL,
    reasoningEffort: EFFORT,
    runtime: 'Adelic local Codex provider',
    approvalMode: 'automatic',
    sandbox: 'workspace-write',
    tokenBudget: null,
    callBudget: null,
    submittedTurns: 0,
    providerAttempts: null,
    repairAttempts: null,
    outcome: 'setup_error',
    accepted: false,
    terminalStateConfirmed: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    actualCost: null,
    estimatedCost: null,
    costCurrency: null,
    toolCalls: null,
    phaseSpans: null,
    contextBytes: null,
    initialPromptBytes: Buffer.byteLength(info.inputs[task.turns[0]]),
    promptBytesMeaning: 'initial user prompt bytes only; not all input tokens',
    failure: null,
    turns: [],
    diff: null,
    terminalCapture: null,
    profileVerification: null,
  };
  assertUnreplayed(join(EVAL_ROOT, 'ledger.jsonl'), attemptId);
  appendLedger({ event: 'attempt-start', runId, attemptId, task: task.id, profile, at: startedAt });
  try {
    assertTaskFrozen(task, frozen);
    const coordination =
      profile === 'direct'
        ? { enabled: false, maxWorkers: 1, review: false }
        : {
            enabled: true,
            maxWorkers: 2,
            review: true,
            workerProviderId: 'codex',
            workerModel: MODEL,
            reviewerProviderId: 'codex',
            reviewerModel: MODEL,
          };
    const project = await api('/api/projects', {
      method: 'POST',
      body: {
        name: `Journey ${task.id} ${profile} ${attemptId.slice(0, 8)}`,
        path: fixture.path,
        memoryWorkspace: 'journey-eval',
        memoryProject: task.id,
        approvalMode: 'automatic',
        orchestration: coordination,
        graphify: { enabled: false },
      },
    });
    const session = await api('/api/sessions', {
      method: 'POST',
      body: {
        projectId: project.id,
        providerId: 'codex',
        model: MODEL,
        thinking: EFFORT,
        mode: 'deep',
        approvalMode: 'automatic',
      },
    });
    attempt.projectId = project.id;
    attempt.sessionId = session.id;
    attempt.setupWallTimeMs = Date.now() - journeyStartedAt;
    let latestDetail = null;
    let finalRun = null;
    for (let turnIndex = 0; turnIndex < task.turns.length; turnIndex += 1) {
      assertTaskFrozen(task, frozen);
      const budget = continuationBudget(journeyStartedAt);
      if (!budget.eligible) {
        attempt.turns.push({
          turn: turnIndex + 1,
          outcome: 'budget_gate',
          accepted: false,
          failure: 'less than the 30-second finalization reserve remained; continuation was not submitted',
        });
        break;
      }
      const prompt = info.inputs[task.turns[turnIndex]];
      const turnStart = Date.now();
      let accepted;
      try {
        accepted = await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
          method: 'POST',
          body: {
            content: prompt,
            clientMessageId: `journey-${attemptId}-turn-${turnIndex + 1}`,
            budget: { totalMs: budget.remainingMs, finalizationReserveMs: FINALIZATION_RESERVE_MS },
          },
          timeoutMs: 15_000,
        });
      } catch (error) {
        const cleanup = await cancelLatestActiveRun(session.id);
        if (!cleanup.terminalStateConfirmed) {
          const unsafe = new Error(
            `Message submission failed and terminal state could not be confirmed: ${error.message}; ${(cleanup.failures ?? []).join('; ')}`,
          );
          unsafe.stopSchedule = true;
          throw unsafe;
        }
        attempt.turns.push({
          turn: turnIndex + 1,
          outcome: 'submission_error',
          accepted: false,
          terminalStateConfirmed: true,
          wallTimeMs: Date.now() - turnStart,
          failure: error.message,
        });
        attempt.failure = error.message;
        break;
      }
      const runIdRemote = accepted.run?.id ?? accepted.runId;
      if (!runIdRemote) {
        const cleanup = await cancelLatestActiveRun(session.id);
        if (!cleanup.terminalStateConfirmed) {
          const unsafe = new Error(
            `Adelic returned no run id and terminal state could not be confirmed: ${(cleanup.failures ?? []).join('; ')}`,
          );
          unsafe.stopSchedule = true;
          throw unsafe;
        }
        attempt.turns.push({
          turn: turnIndex + 1,
          outcome: 'submission_error',
          accepted: false,
          terminalStateConfirmed: true,
          wallTimeMs: Date.now() - turnStart,
          failure: 'API returned no run id',
        });
        attempt.failure = 'API returned no run id';
        break;
      }
      attempt.submittedTurns += 1;
      let waited;
      let failures = [];
      try {
        waited = await waitRun(session.id, runIdRemote, Math.max(1, budget.workMs));
      } catch (error) {
        const cancelled = await cancelRun(session.id, runIdRemote);
        if (!cancelled.terminalStateConfirmed) {
          const unsafe = new Error(
            `Run polling failed and terminal state could not be confirmed: ${error.message}; ${(cancelled.failures ?? []).join('; ')}`,
            { cause: error },
          );
          unsafe.stopSchedule = true;
          throw unsafe;
        }
        failures.push(`polling error: ${error.message}`);
        waited = cancelled;
      }
      const turnTimedOut = isJourneyTimeout(waited);
      let terminalStateConfirmed = Boolean(waited.run && waited.run.status !== 'running');
      if (turnTimedOut) {
        if (waited.timedOut === true) {
          failures.push('journey work deadline reached; cancellation started within reserved finalization window');
          waited = await cancelRun(session.id, runIdRemote);
          terminalStateConfirmed = waited.terminalStateConfirmed === true;
          failures.push(...(waited.failures ?? []));
        } else failures.push('Adelic run terminated with timeout');
        if (!terminalStateConfirmed) {
          const error = new Error('Timed-out run did not reach a confirmed terminal state after cancellation');
          error.stopSchedule = true;
          throw error;
        }
      }
      latestDetail = waited.detail ?? latestDetail;
      finalRun = waited.run ?? finalRun;
      const run = waited.run;
      if (run?.error) failures.push(run.error);
      if (run?.failure?.reason) failures.push(run.failure.reason);
      const events = (waited.detail?.events ?? []).filter((event) => event.runId === runIdRemote);
      failures.push(...events.filter((event) => event.type === 'error').map((event) => event.error ?? event.text));
      const output = (waited.detail?.messages ?? [])
        .filter((message) => message.runId === runIdRemote && message.role === 'assistant')
        .map((message) => message.content)
        .join('\n');
      const capturePath = join(EVAL_ROOT, 'logs', `${attemptId}-turn-${turnIndex + 1}.assistant.txt`);
      writeFileSync(capturePath, output, { mode: 0o600 });
      const toolEvents = events.filter((event) => event.type === 'tool');
      const observedToolCount = Array.isArray(waited.detail?.events)
        ? new Set(toolEvents.map((event) => event.toolCallId).filter(Boolean)).size +
          toolEvents.filter((event) => !event.toolCallId).length
        : null;
      const usage = getUsage(run ?? {});
      let trace = null;
      try {
        trace = await api(`/api/observability/runs/${encodeURIComponent(runIdRemote)}`);
      } catch {
        /* keep unavailable metrics unknown */
      }
      const diagnostics = trace ? compactTrace(trace, runIdRemote) : null;
      const turn = {
        turn: turnIndex + 1,
        outcome: turnTimedOut ? 'timeout' : (run?.status ?? 'unknown'),
        timedOut: turnTimedOut,
        wallTimeMs: Date.now() - turnStart,
        runId: runIdRemote,
        termination: run?.termination ?? null,
        terminalStateConfirmed,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        reasoningOutputTokens: usage.reasoningOutputTokens,
        toolCalls: observedToolCount,
        phaseSpans: run?.phaseSpans ?? run?.phases ?? diagnostics?.spans ?? null,
        contextBytes:
          run?.contextBytes ??
          (diagnostics?.context.some((item) => item.contextBytes !== null)
            ? diagnostics.context.reduce((sum, item) => sum + (item.contextBytes ?? 0), 0)
            : null),
        contextDiagnostics: diagnostics?.context ?? null,
        effectiveRunIds: diagnostics?.effectiveRunIds ?? [runIdRemote],
        providerAttempts: Array.isArray(run?.providerAttempts)
          ? run.providerAttempts.length
          : (diagnostics?.providerAttempts ?? null),
        providerAttemptDetails: Array.isArray(run?.providerAttempts)
          ? run.providerAttempts.map((item) => ({
              attemptId: item.attemptId,
              taskId: item.taskId ?? null,
              durationMs: item.durationMs ?? null,
              inputTokens: item.inputTokens ?? null,
              outputTokens: item.outputTokens ?? null,
              cachedInputTokens: item.cachedInputTokens ?? null,
              reasoningOutputTokens: item.reasoningOutputTokens ?? null,
            }))
          : null,
        providerTaskIds: diagnostics?.providerTaskIds ?? [],
        actualProviderCallObserved: observedProviderCall(
          Array.isArray(run?.providerAttempts) ? run.providerAttempts.length : null,
          diagnostics?.providerAttempts ?? null,
        ),
        effectiveModel:
          observedProviderCall(
            Array.isArray(run?.providerAttempts) ? run.providerAttempts.length : null,
            diagnostics?.providerAttempts ?? null,
          ) === true
            ? (run?.model ?? null)
            : null,
        effectiveEffort:
          observedProviderCall(
            Array.isArray(run?.providerAttempts) ? run.providerAttempts.length : null,
            diagnostics?.providerAttempts ?? null,
          ) === true
            ? (run?.route?.effort ?? null)
            : null,
        firstObservedToolCallMs: firstToolTimeMs(toolEvents, turnStart),
        firstObservedToolCallMeaning:
          'elapsed time from message submission to earliest timestamped Adelic tool event; null if event timestamps are unavailable',
        phaseSpanMeaning: 'observed span durations may overlap and are not added to wall time',
        failure: failures.length ? failures.join('; ') : null,
        terminalCapture: { path: capturePath, sha256: sha256(output), bytes: Buffer.byteLength(output) },
      };
      attempt.turns.push(turn);
      attempt.terminalCapture = turn.terminalCapture;
      if (turnIndex === task.turns.length - 1 || turnTimedOut || run?.status !== 'completed') break;
    }
    const coordinationDetail =
      profile === 'coordinated' ? await api(`/api/projects/${encodeURIComponent(project.id)}/coordination`) : null;
    const executedTaskIds = collectExecutedTaskIds(attempt.turns);
    const roles = rolesForExecutedTasks(coordinationDetail ?? {}, executedTaskIds);
    const coordinationTaskIds = new Set((coordinationDetail?.tasks ?? []).map((task) => task.id));
    const unmatchedExecutedTaskIds =
      profile === 'coordinated' ? [...executedTaskIds].filter((taskId) => !coordinationTaskIds.has(taskId)) : [];
    const configuredVerified =
      `${session.providerId ?? 'codex'}:${session.model ?? MODEL}` === `codex:${MODEL}` && session.thinking === EFFORT;
    const runtimeCallTurns = attempt.turns.filter((turn) => turn.actualProviderCallObserved === true);
    const modelObservations = [
      ...runtimeCallTurns.map((turn) => (turn.effectiveModel ? turn.effectiveModel === MODEL : null)),
      ...roles.map((role) => (role.model ? role.model === MODEL : null)),
      ...roles.map((role) => (role.providerId ? role.providerId === 'codex' : null)),
      ...attempt.turns.filter((turn) => turn.runId && turn.actualProviderCallObserved === null).map(() => null),
      ...unmatchedExecutedTaskIds.map(() => null),
    ];
    const effortObservations = [
      ...runtimeCallTurns.map((turn) => (turn.effectiveEffort ? turn.effectiveEffort === EFFORT : null)),
      ...roles.map((role) => (role.effort ? role.effort === EFFORT : null)),
      ...attempt.turns.filter((turn) => turn.runId && turn.actualProviderCallObserved === null).map(() => null),
      ...unmatchedExecutedTaskIds.map(() => null),
    ];
    const observedModelVerified = modelObservations.length
      ? modelObservations.includes(false)
        ? false
        : modelObservations.includes(null)
          ? null
          : true
      : null;
    const observedEffortVerified = effortObservations.length
      ? effortObservations.includes(false)
        ? false
        : effortObservations.includes(null)
          ? null
          : true
      : null;
    const profileEvidence = {
      profile,
      configuredVerified,
      configured: {
        sessionModel: `${session.providerId ?? 'codex'}:${session.model ?? MODEL}`,
        sessionThinking: session.thinking ?? null,
        orchestrationEnabled: profile === 'coordinated',
        expectedDelegatedModel: profile === 'coordinated' ? MODEL : null,
        configuredVerified,
      },
      effectivePath: roles.length
        ? 'delegated provider calls observed'
        : 'no delegated provider calls observed; coordinated profile may have taken the direct path',
      executedTaskIds: [...executedTaskIds],
      unmatchedExecutedTaskIds,
      observedDelegatedRoles: roles,
      observedModelVerified,
      observedEffortVerified,
    };
    attempt.toolCalls = sumKnown(attempt.turns, 'toolCalls');
    const providerAttempts = attempt.turns.map((turn) => turn.providerAttempts);
    attempt.providerAttempts = providerAttempts.every(Number.isSafeInteger)
      ? providerAttempts.reduce((sum, value) => sum + value, 0)
      : null;
    attempt.wallTimeMs = Date.now() - journeyStartedAt;
    attempt.outcome = attempt.turns.at(-1)?.outcome ?? 'unknown';
    const submitted = attempt.turns.filter((turn) => turn.runId || turn.terminalStateConfirmed !== undefined);
    attempt.terminalStateConfirmed =
      submitted.length > 0 && submitted.every((turn) => turn.terminalStateConfirmed === true);
    attempt.failure =
      attempt.turns
        .map((turn) => turn.failure)
        .filter(Boolean)
        .join('; ') || null;
    applyProfileVerification(attempt, profileEvidence);
    attempt.inputTokens = sumKnown(attempt.turns, 'inputTokens');
    attempt.outputTokens = sumKnown(attempt.turns, 'outputTokens');
    attempt.cachedInputTokens = sumKnown(attempt.turns, 'cachedInputTokens');
    attempt.reasoningOutputTokens = sumKnown(attempt.turns, 'reasoningOutputTokens');
    const phaseSets = attempt.turns.map((turn) => turn.phaseSpans).filter(Array.isArray);
    attempt.phaseSpans = phaseSets.length ? phaseSets.flat() : null;
    assertTaskFrozen(task, frozen);
    attempt.acceptance = await grade(task, fixture.path);
    attempt.accepted =
      attempt.acceptance.accepted === true &&
      attempt.terminalStateConfirmed === true &&
      attempt.outcome === 'completed' &&
      attempt.profileVerification?.verified === true;
    attempt.diff = checkoutChanges(fixture);
    attempt.finishedAt = iso();
    attempt.cacheLoad = {
      cachePolicy: 'not controlled; cold/warm provider and OS caches recorded as unknown',
      systemLoadAverage: loadavg(),
    };
    appendLedger({
      event: 'attempt-terminal',
      runId,
      attemptId,
      at: attempt.finishedAt,
      outcome: attempt.outcome,
      accepted: attempt.accepted,
      diffSha256: attempt.diff.sha256,
    });
    return attempt;
  } catch (error) {
    attempt.wallTimeMs = Date.now() - journeyStartedAt;
    attempt.failure = error.message;
    attempt.finishedAt = iso();
    attempt.diff = checkoutChanges(fixture);
    attempt.outcome = attempt.submittedTurns ? 'runner_error_after_submission' : 'setup_error';
    if (error.stopSchedule) {
      appendLedger({
        event: 'attempt-terminal',
        runId,
        attemptId,
        at: attempt.finishedAt,
        outcome: attempt.outcome,
        accepted: false,
        terminalStateConfirmed: false,
        failure: error.message,
      });
      error.stopSchedule = true;
      throw error;
    }
    appendLedger({
      event: 'attempt-terminal',
      runId,
      attemptId,
      at: attempt.finishedAt,
      outcome: attempt.outcome,
      accepted: false,
      diffSha256: attempt.diff.sha256,
      failure: error.message,
    });
    return attempt;
  }
}

function sumKnown(rows, key) {
  const values = rows.map((row) => row[key]);
  return values.length > 0 && values.every((value) => Number.isSafeInteger(value) && value >= 0)
    ? values.reduce((a, b) => a + b, 0)
    : null;
}

function firstToolTimeMs(events, turnStartedAt) {
  const times = events.map((event) => Date.parse(event.createdAt ?? event.at ?? '')).filter(Number.isFinite);
  return times.length ? Math.max(0, Math.min(...times) - turnStartedAt) : null;
}

export function summarize(results) {
  const byTask = {};
  for (const result of results) {
    (byTask[result.journey] ??= {})[result.profile] = result;
  }
  const pairs = Object.entries(byTask).map(([journey, profiles]) => ({
    journey,
    directAccepted: profiles.direct?.accepted ?? false,
    coordinatedAccepted: profiles.coordinated?.accepted ?? false,
    directMs: profiles.direct?.wallTimeMs ?? null,
    coordinatedMs: profiles.coordinated?.wallTimeMs ?? null,
  }));
  const profileStats = Object.fromEntries(
    PROFILE_ORDER.map((profile) => {
      const rows = results.filter((item) => item.profile === profile);
      const times = rows.map((item) => item.wallTimeMs).filter((value) => Number.isFinite(value));
      return [
        profile,
        {
          attempts: rows.length,
          externallyAccepted: rows.filter((item) => item.accepted).length,
          acceptanceRate: rows.length ? rows.filter((item) => item.accepted).length / rows.length : null,
          medianWallTimeMs: median(times),
          wallTimeRangeMs: times.length ? [Math.min(...times), Math.max(...times)] : null,
          repairAttemptsObserved: rows.reduce(
            (sum, item) => sum + (Number.isSafeInteger(item.repairAttempts) ? item.repairAttempts : 0),
            0,
          ),
          attemptsWithUnknownRepairCount: rows.filter(
            (item) => item.repairAttempts === null || item.repairAttempts === undefined,
          ).length,
          timeouts: rows.filter((item) => item.outcome === 'timeout').length,
          errors: rows.filter((item) => item.failure || item.outcome.endsWith('_error')).length,
        },
      ];
    }),
  );
  return { pairs, profileStats };
}

export async function executeAttemptSchedule(journeys, executeAttempt) {
  const results = [];
  for (const [index, journey] of journeys.entries()) {
    const scheduleIndex = Number.isInteger(journey?.scheduleIndex) ? journey.scheduleIndex : index;
    const order = scheduleIndex % 2 ? [...PROFILE_ORDER].reverse() : PROFILE_ORDER;
    for (const profile of order) {
      try {
        results.push(await executeAttempt(journey, profile, index));
      } catch (error) {
        if (error.stopSchedule) throw error;
        results.push({
          journey: journey.id ?? journey,
          profile,
          outcome: 'runner_error',
          accepted: false,
          failure: error.message,
        });
      }
    }
  }
  return results;
}

function renderReport(run, results) {
  const summary = summarize(results);
  const lines = [
    '# General Adelic journey pilot',
    '',
    'Experimental evidence only. This compares the same explicitly selected model, effort, runtime, approvals, source fixtures, and budget with orchestration disabled (direct) or enabled (coordinated).',
    '',
    `Run: ${run.id} · source commit: ${run.sourceCommit} · model: ${run.model}/${run.effort} · started: ${run.startedAt}`,
    '',
    '## Profile outcomes',
    '',
    '| Profile | Attempts | External acceptance | Median wall time | Range | Repair attempts | Timeouts | Errors |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...PROFILE_ORDER.map((profile) => {
      const x = summary.profileStats[profile];
      return `| ${profile} | ${x.attempts} | ${x.externallyAccepted}/${x.attempts} | ${fmtMs(x.medianWallTimeMs)} | ${fmtRange(x.wallTimeRangeMs)} | ${x.repairAttemptsObserved} observed, ${x.attemptsWithUnknownRepairCount} unknown | ${x.timeouts} | ${x.errors} |`;
    }),
    '',
    `No P95 is calculated for this sample size (maximum ${run.maxJourneyAttempts} attempts). Actual cost is unknown unless the runtime reports it; estimated cost is present only for explicit caller-supplied rates. Phase spans may overlap and are not summed as wall time. Prompt bytes are not token counts.`,
    '',
    '## Paired journeys',
    '',
    '| Journey | Direct accepted | Coordinated accepted | Direct time | Coordinated time |',
    '|---|---|---|---:|---:|',
    ...summary.pairs.map(
      (x) =>
        `| ${x.journey} | ${x.directAccepted ? 'yes' : 'no'} | ${x.coordinatedAccepted ? 'yes' : 'no'} | ${fmtMs(x.directMs)} | ${fmtMs(x.coordinatedMs)} |`,
    ),
    '',
    '## Provenance and limits',
    '',
    `- Frozen inputs, fixture commits, profile order, cache/load observations, and per-attempt diff hashes are in results.json. Source commit is the Adelic checkout HEAD recorded when the run began (${run.sourceCommit}).`,
    '- Graders run from the harness source outside the writable checkout. Agent claims do not affect acceptance. A failed, timed out, setup-error, or unverified-profile attempt remains in the denominator.',
    '- Provider-internal token/call hard caps are not claimed when the provider does not expose them. Cost can remain unknown. Native usage helpers preserve unavailable counters as null.',
    '- Residual confounds include provider and OS cache state, provider-side load, scheduling/queue variation, one run per profile per fixture, same-model role defaults, and timing variation. This pilot cannot establish a production policy.',
    '',
  ];
  return lines.join('\n');
}

function fmtMs(value) {
  return Number.isFinite(value) ? `${(value / 1000).toFixed(1)}s` : 'unknown';
}
function fmtRange(value) {
  return value ? `${fmtMs(value[0])}–${fmtMs(value[1])}` : 'unknown';
}

async function runPilot(manifest, selectedTasks) {
  requireRunAuthorization();
  const maxJourneyAttempts = Math.min(MAX_ATTEMPTS, manifest.length * PROFILE_ORDER.length);
  await preflight(maxJourneyAttempts);
  const bootstrap = await api('/api/bootstrap');
  const provider = bootstrap.providers?.find((item) => item.id === 'codex');
  const model = provider?.models?.find((item) => item.id === MODEL);
  if (!provider?.available || !model || model.efforts?.includes(EFFORT) !== true)
    throw new Error(`Adelic provider/model ${MODEL}/${EFFORT} unavailable`);
  if (
    bootstrap.settings?.sandbox !== 'workspace-write' ||
    bootstrap.settings?.memoryEnabled !== false ||
    bootstrap.settings?.approvalMode !== 'automatic' ||
    bootstrap.settings?.autoRetry !== false ||
    bootstrap.settings?.autoCompact !== false ||
    bootstrap.settings?.automations !== false ||
    bootstrap.settings?.modelFallback?.enabled === true
  )
    throw new Error(
      'Isolated server must already use workspace-write, automatic approvals, and disabled memory/retry/compaction/automations/fallback',
    );
  const server = {
    settingsVerified: true,
    modelAvailable: true,
    effortAdvertised: true,
    sandbox: bootstrap.settings.sandbox,
    memoryEnabled: bootstrap.settings.memoryEnabled,
    approvalMode: bootstrap.settings.approvalMode,
    autoRetry: bootstrap.settings.autoRetry,
    autoCompact: bootstrap.settings.autoCompact,
    automations: bootstrap.settings.automations,
    modelFallbackEnabled: bootstrap.settings.modelFallback?.enabled ?? false,
  };
  mkdirSync(join(EVAL_ROOT, 'workspaces'), { recursive: true, mode: 0o700 });
  mkdirSync(join(EVAL_ROOT, 'logs'), { recursive: true, mode: 0o700 });
  const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() })).stdout.trim();
  const id = randomUUID();
  const scopedInputs = [
    'scripts/benchmark-journeys.mjs',
    'tests/benchmark-journeys.test.mjs',
    'docs/benchmark-journeys.md',
  ];
  const sourceFreeze = scopedInputs.map((path) => ({
    path,
    sha256: existsSync(path) ? sha256(readFileSync(path)) : null,
  }));
  const gitDiff = (await exec('git', ['diff', '--binary', 'HEAD'], { cwd: process.cwd() })).stdout;
  const run = {
    id,
    startedAt: iso(),
    sourceCommit,
    sourceDiffSha256: sha256(JSON.stringify({ gitDiff, sourceFreeze })),
    sourceFreeze,
    model: MODEL,
    effort: EFFORT,
    runtime: 'Adelic local Codex provider',
    approvals: 'automatic in disposable local server',
    sandbox: 'workspace-write',
    maxJourneyAttempts,
    journeyDeadlineMs: JOURNEY_LIMIT_MS,
    finalizationReserveMs: FINALIZATION_RESERVE_MS,
    profileOrder: manifest.map((item) => {
      const originalIndex = tasks.findIndex((task) => task.id === item.id);
      return {
        journey: item.id,
        order: originalIndex % 2 ? [...PROFILE_ORDER].reverse() : PROFILE_ORDER,
      };
    }),
    sourceInputManifest: manifest.map(
      ({ id: task, turns, promptSha256, graderSha256, graderHelpersSha256, files }) => ({
        task,
        turns,
        promptSha256,
        graderSha256,
        graderHelpersSha256,
        fixtureFiles: files,
      }),
    ),
    server,
    cacheAndLoadPolicy: 'cache state is not controlled; per-attempt load average recorded',
    costRates: readCostRates(),
    serverIsolation:
      'operator attestation required; runner verifies loopback URL, model/effort, and server settings, not the host data directory or process provenance',
    artifactRoot: EVAL_ROOT,
  };
  writeJson(join(EVAL_ROOT, `${id}-run.json`), run);
  appendLedger({
    event: 'run-start',
    runId: id,
    at: run.startedAt,
    sourceCommit,
    manifestSha256: sha256(JSON.stringify(run.sourceInputManifest)),
  });
  const scheduleTasks = selectedTasks.map((task) => ({
    ...task,
    scheduleIndex: tasks.findIndex((entry) => entry.id === task.id),
  }));
  const results = await executeAttemptSchedule(scheduleTasks, async (task, profile) => {
    const info = fixtureInfo(task);
    const preparationStartedAt = Date.now();
    let fixture;
    try {
      fixture = initCheckout(task, profile, id, info);
      const fixturePreparationMs = Date.now() - preparationStartedAt;
      const frozen = manifest.find((entry) => entry.id === task.id);
      assertTaskFrozen(task, frozen);
      const result = await runAttempt(task, profile, id, info, fixture, { ...fixture, fixturePreparationMs }, frozen);
      applyEstimatedCost(result, run.costRates);
      return result;
    } catch (error) {
      if (error.stopSchedule) throw error;
      const result = {
        runId: id,
        journey: task.id,
        profile,
        outcome: 'setup_error',
        accepted: false,
        failure: error.message,
        submittedTurns: 0,
        providerAttempts: null,
        wallTimeMs: null,
        diff: fixture ? checkoutChanges(fixture) : null,
      };
      appendLedger({
        event: 'attempt-setup-error',
        runId: id,
        task: task.id,
        profile,
        at: iso(),
        failure: error.message,
      });
      return result;
    }
  });
  for (const result of results) {
    if (result.attemptId) writeJson(join(EVAL_ROOT, `${result.attemptId}.json`), result);
    process.stdout.write(
      `${JSON.stringify({ journey: result.journey, profile: result.profile, outcome: result.outcome, accepted: result.accepted, wallTimeMs: result.wallTimeMs ?? null })}\n`,
    );
  }
  run.finishedAt = iso();
  run.summary = summarize(results);
  writeJson(join(EVAL_ROOT, `${id}-results.json`), { run, results });
  const reportPath = join(EVAL_ROOT, `${id}-report.md`);
  writeFileSync(reportPath, `${renderReport(run, results)}\n`, { mode: 0o600 });
  appendLedger({ event: 'run-terminal', runId: id, at: run.finishedAt, attempts: results.length, reportPath });
  process.stdout.write(`Report: ${reportPath}\n`);
}

export function readCostRates(env = process.env) {
  const input = env.ADELIC_JOURNEY_INPUT_USD_PER_MILLION;
  const output = env.ADELIC_JOURNEY_OUTPUT_USD_PER_MILLION;
  if (input === undefined && output === undefined) return null;
  if (
    !input ||
    !output ||
    !Number.isFinite(Number(input)) ||
    !Number.isFinite(Number(output)) ||
    Number(input) < 0 ||
    Number(output) < 0
  )
    throw new Error('Set both explicit, non-negative USD per million token rates to estimate cost');
  return {
    currency: 'USD',
    inputUsdPerMillion: Number(input),
    outputUsdPerMillion: Number(output),
    source: 'explicit ADELIC_JOURNEY_* environment rates',
  };
}

export function estimateCost(inputTokens, outputTokens, rates) {
  if (
    !rates ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  )
    return null;
  return (inputTokens * rates.inputUsdPerMillion + outputTokens * rates.outputUsdPerMillion) / 1_000_000;
}

function applyEstimatedCost(result, rates) {
  result.actualCost = null;
  result.estimatedCost = estimateCost(result.inputTokens, result.outputTokens, rates);
  result.costCurrency = rates?.currency ?? null;
}

const help = `Usage: node scripts/benchmark-journeys.mjs [--dry-run|--preflight|--run] [--journey ID]\nDefault: --preflight; neither mode makes model calls. --journey ID selects one complete direct/coordinated pair (two attempts); without it, all six journeys are selected (12 attempts max). --run requires ADELIC_JOURNEY_ALLOW_LIVE=${EXPLICIT_RUN_AUTH}, ADELIC_JOURNEY_ISOLATED_SERVER=1, explicit ADELIC_JOURNEY_MODEL and ADELIC_JOURNEY_URL, and a loopback URL. Continuation uses one shared 180-second budget.`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const selectedTasks = selectedJourneyTasks(options.journey);
  const maxJourneyAttempts = Math.min(MAX_ATTEMPTS, selectedTasks.length * PROFILE_ORDER.length);
  if (options.mode === 'help') return process.stdout.write(`${help}\n`);
  if (options.mode === 'dry-run') {
    const selectedIds = new Set(selectedTasks.map((task) => task.id));
    process.stdout.write(
      `${JSON.stringify({ mode: 'dry-run', modelCalls: 0, maxJourneyAttempts, selectedJourney: options.journey, manifest: frozenManifest().filter((entry) => selectedIds.has(entry.id)) }, null, 2)}\n`,
    );
    return;
  }
  const result = await preflight(maxJourneyAttempts);
  const selectedIds = new Set(selectedTasks.map((task) => task.id));
  const manifest = result.manifest.filter((entry) => selectedIds.has(entry.id));
  process.stdout.write(
    `${JSON.stringify({ mode: options.mode, modelCalls: 0, selectedJourney: options.journey, ...result, manifest }, null, 2)}\n`,
  );
  if (options.mode === 'run') await runPilot(manifest, selectedTasks);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`benchmark-journeys: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
