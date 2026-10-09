#!/usr/bin/env node

/**
 * Small, repeatable comparison between an isolated Adelic server and native Codex exec.
 * This is an adapted three-exercise trial, not an official Polyglot benchmark score.
 * Operational artifacts and generated code stay under /tmp/adelic-harness-eval.
 */
import { spawn } from 'node:child_process';
import { nativeUsageSnapshot, nativeTurnUsage } from './benchmark-usage.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVAL_ROOT = resolve(process.env.ADELIC_BENCHMARK_ROOT ?? '/tmp/adelic-harness-eval');
const SOURCE_ROOT = resolve(process.env.ADELIC_POLYGLOT_ROOT ?? join(EVAL_ROOT, 'polyglot'));
const BASE_URL = process.env.ADELIC_BENCHMARK_URL ?? 'http://127.0.0.1:4790';
const CODEX = resolve(
  process.env.ADELIC_CODEX_BIN ?? '/home/ikaromm/.local/share/mise/installs/codex/0.160.0/bin/codex',
);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REGRESSION_ROOT = resolve(
  process.env.ADELIC_REGRESSION_FIXTURE_ROOT ?? join(SCRIPT_DIR, 'fixtures', 'harness-regression'),
);
const MODEL = 'gpt-6-luna';
const EFFORT = 'high';
const ATTEMPT_LIMIT_MS = 180_000;
const REGRESSION_TURN_LIMIT_MS = 60_000;
const TEST_LIMIT_MS = 30_000;
const SOURCE_COMMIT = '7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f';
const activeChildren = new Set();
let interrupted = false;
const TASKS = [
  {
    id: 'grade-school',
    module: 'grade_school.py',
    test: 'grade_school_test.py',
    api: 'Implement class School with add_student(name, grade), grade(grade), roster(), and added(). grade(grade) returns a list of student names for that grade sorted alphabetically. roster() returns one flat list of names ordered by ascending grade, then alphabetically within each grade. added() returns a list of booleans, one result per add attempt.',
    reason: 'Small stateful API with duplicate handling and grade/name ordering.',
  },
  {
    id: 'phone-number',
    module: 'phone_number.py',
    test: 'phone_number_test.py',
    api: 'Implement class PhoneNumber; its constructor accepts a string, .number returns ten digits, .area_code returns the first three digits, and pretty() formats as (NXX)-NXX-XXXX. Match these ValueError messages for invalid inputs: fewer than 10 digits: "must not be fewer than 10 digits"; more than 11: "must not be greater than 11 digits"; 11 digits not starting in 1: "11 digits must start with 1"; letters: "letters not permitted"; punctuation: "punctuations not permitted"; area code starting with 0 or 1: "area code cannot start with zero" or "area code cannot start with one"; exchange code starting with 0 or 1: "exchange code cannot start with zero" or "exchange code cannot start with one".',
    reason: 'Input normalization and validation using only standard-library string operations.',
  },
  {
    id: 'transpose',
    module: 'transpose.py',
    test: 'transpose_test.py',
    api: 'Implement function transpose(text) returning the transposed text.',
    reason: 'Ragged rows and whitespace preservation exercise edge-case reasoning.',
  },
];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const help =
  `Usage: node scripts/benchmark-harness.mjs [--dry-run|--preflight|--run] [--suite polyglot|regression] [--harness adelic|native|both] [--task ID ...]\n\n` +
  `Default: --preflight (no model calls). --run runs one attempt per selected task and harness.\n` +
  `The regression suite is separate and opt-in: --run --suite regression (4 turn attempts max; 2 turns per harness; 60s active-time ceiling per turn). Internal model calls and token use can vary; this is not a strict token budget.\n` +
  `The same gpt-6-luna/high prompt is used with fresh workspaces; max attempt time is 180 seconds.\n` +
  `Optional paths: ADELIC_BENCHMARK_ROOT, ADELIC_POLYGLOT_ROOT, ADELIC_REGRESSION_FIXTURE_ROOT, ADELIC_CODEX_BIN, ADELIC_BENCHMARK_URL.`;

function parseArgs(argv) {
  const options = { mode: 'preflight', suite: 'polyglot', harness: 'both', tasks: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.mode = 'help';
    else if (arg === '--dry-run') options.mode = 'dry-run';
    else if (arg === '--preflight') options.mode = 'preflight';
    else if (arg === '--run') options.mode = 'run';
    else if (arg === '--suite') options.suite = takeValue(argv, ++i, arg);
    else if (arg === '--harness') options.harness = takeValue(argv, ++i, arg);
    else if (arg === '--task') options.tasks.push(takeValue(argv, ++i, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!['adelic', 'native', 'both'].includes(options.harness)) throw new Error(`Invalid harness: ${options.harness}`);
  if (!['polyglot', 'regression'].includes(options.suite)) throw new Error(`Invalid suite: ${options.suite}`);
  if (options.suite === 'regression' && options.tasks.length)
    throw new Error('--task applies only to the Polyglot suite');
  if (options.tasks.some((id) => !TASKS.some((task) => task.id === id)))
    throw new Error(`Unknown task. Choose: ${TASKS.map((task) => task.id).join(', ')}`);
  return options;
}

function takeValue(argv, index, flag) {
  if (!argv[index] || argv[index].startsWith('--')) throw new Error(`${flag} needs a value`);
  return argv[index];
}

function signalChildTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function interruptActiveChildren(signal) {
  interrupted = true;
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  for (const child of activeChildren) signalChildTree(child, 'SIGINT');
  setTimeout(() => {
    for (const child of activeChildren) signalChildTree(child, 'SIGTERM');
  }, 1500).unref();
  setTimeout(() => {
    for (const child of activeChildren) signalChildTree(child, 'SIGKILL');
  }, 3000).unref();
}

process.once('SIGINT', () => interruptActiveChildren('SIGINT'));
process.once('SIGTERM', () => interruptActiveChildren('SIGTERM'));

function execFile(file, args, { cwd, env = process.env, timeoutMs = 15_000, input } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalChildTree(child, 'SIGINT');
      setTimeout(() => signalChildTree(child, 'SIGTERM'), 1500).unref();
      setTimeout(() => signalChildTree(child, 'SIGKILL'), 3000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolvePromise({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function api(path, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = text;
  }
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(value)}`);
  return value;
}

function sourceRevision() {
  const result = readFileSync(join(SOURCE_ROOT, '.git', 'HEAD'), 'utf8').trim();
  return result.startsWith('ref: ') ? readFileSync(join(SOURCE_ROOT, '.git', result.slice(5)), 'utf8').trim() : result;
}

function taskPrompt(task, instructions) {
  return [
    `Implement the Python solution for the Exercism exercise “${task.id}”.`,
    '',
    'Exercise instructions:',
    instructions.trim(),
    '',
    `Required module and public API: ${task.api}`,
    `Write the implementation to ${task.module}. Use Python standard library only.`,
    'Do not create or modify tests. Keep all work inside the current workspace. When finished, briefly state what you implemented.',
  ].join('\n');
}

function taskFiles(task) {
  const sourceDir = join(SOURCE_ROOT, 'python', 'exercises', 'practice', task.id);
  const instructionPath = join(sourceDir, '.docs', 'instructions.md');
  const testPath = join(sourceDir, task.test);
  if (!existsSync(instructionPath) || !existsSync(testPath)) throw new Error(`Missing upstream files for ${task.id}`);
  const instructions = readFileSync(instructionPath, 'utf8');
  const prompt = taskPrompt(task, instructions);
  return {
    sourceDir,
    instructionPath,
    testPath,
    instructions,
    prompt,
    metadata: {
      task: task.id,
      module: task.module,
      upstreamRepository: 'Aider-AI/polyglot-benchmark',
      upstreamCommit: SOURCE_COMMIT,
      upstreamCheckoutCommit: sourceRevision(),
      upstreamTaskPath: `python/exercises/practice/${task.id}`,
      instructionSha256: sha256(instructions),
      originalTestSha256: sha256(readFileSync(testPath)),
      adaptedPromptSha256: sha256(prompt),
      selectionRationale: task.reason,
      limitations:
        'Three selected Python exercises only; adapted task prompt; not an official benchmark score. grade-school API return formats are clarified in the prompt; exploratory runs with the earlier ambiguous prompt are excluded.',
    },
  };
}

function regressionCase() {
  const fixture = (name) => join(REGRESSION_ROOT, name);
  const files = {
    starter: fixture('reading_list.py'),
    repairPrompt: fixture('repair_prompt.md'),
    followupPrompt: fixture('followup_prompt.md'),
    repairTest: fixture('test_repair.py'),
    followupTest: fixture('test_followup.py'),
  };
  for (const path of Object.values(files)) {
    if (!existsSync(path)) throw new Error(`Regression fixture is missing: ${path}`);
  }
  const texts = {
    repair: readFileSync(files.repairPrompt, 'utf8').trim(),
    followup: readFileSync(files.followupPrompt, 'utf8').trim(),
  };
  return {
    id: 'reading-list-maintenance',
    files,
    texts,
    metadata: {
      suite: 'opt-in regression mini-project; not part of Polyglot cases or score',
      caseId: 'reading-list-maintenance',
      fixtureRoot: REGRESSION_ROOT,
      fixtureSha256: Object.fromEntries(Object.entries(files).map(([key, path]) => [key, sha256(readFileSync(path))])),
      promptSha256: {
        repair: sha256(texts.repair),
        followup: sha256(texts.followup),
      },
      turnAttemptsMaximum: 4,
      turnsPerHarness: 2,
      maxActiveTurnSeconds: REGRESSION_TURN_LIMIT_MS / 1000,
      maxAggregateActiveTurnSeconds: 240,
      timeoutCleanupSecondsPerAdelicTimeout: 25,
      retryPolicy: 'one attempt per turn; no retries',
      sequence: ['repair remove() case matching', 'follow-up read tracking in the same session'],
      limitation: 'A single short scripted maintenance scenario; not a general benchmark score.',
    },
  };
}

function selectedTasks(options) {
  return options.tasks.length ? TASKS.filter((task) => options.tasks.includes(task.id)) : TASKS;
}

function selectedHarnesses(options) {
  return options.harness === 'both' ? ['adelic', 'native'] : [options.harness];
}

async function preflight(harnesses, suite) {
  const checks = {
    sourceRoot: suite === 'polyglot' ? existsSync(SOURCE_ROOT) : null,
    regressionFixture: null,
    codexBinary: existsSync(CODEX),
    codexVersion: null,
    adelic: null,
    nativeOptions: null,
    pythonVersion: null,
  };
  let taskChecks = [];
  if (suite === 'polyglot') {
    if (!checks.sourceRoot) throw new Error(`Polyglot checkout is missing: ${SOURCE_ROOT}`);
    const revision = sourceRevision();
    if (revision !== SOURCE_COMMIT)
      throw new Error(`Polyglot revision mismatch: expected ${SOURCE_COMMIT}, found ${revision}`);
    checks.sourceRevision = revision;
    taskChecks = TASKS.map((task) => {
      const files = taskFiles(task);
      return {
        id: task.id,
        module: task.module,
        test: task.test,
        rationale: task.reason,
        promptSha256: files.metadata.adaptedPromptSha256,
      };
    });
  } else {
    const regression = regressionCase();
    checks.regressionFixture = regression.metadata;
    const python = await execFile('python3', ['--version'], { timeoutMs: 10_000 });
    if (python.code !== 0) throw new Error(`python3 --version failed: ${python.stderr || python.stdout}`);
    checks.pythonVersion = (python.stdout || python.stderr).trim();
  }
  if (harnesses.includes('native')) {
    if (!checks.codexBinary) throw new Error(`Codex CLI missing: ${CODEX}`);
    const version = await execFile(CODEX, ['--version'], { timeoutMs: 10_000 });
    if (version.code !== 0) throw new Error(`Codex --version failed: ${version.stderr || version.stdout}`);
    checks.codexVersion = version.stdout.trim();
    const helpResult = await execFile(CODEX, ['exec', '--help'], { timeoutMs: 10_000 });
    checks.nativeOptions = {
      json: helpResult.stdout.includes('--json'),
      model: helpResult.stdout.includes('--model'),
      sandbox: helpResult.stdout.includes('--sandbox'),
      ephemeral: helpResult.stdout.includes('--ephemeral'),
      skipGitRepoCheck: helpResult.stdout.includes('--skip-git-repo-check'),
    };
    if (suite === 'regression') {
      const resumeHelp = await execFile(CODEX, ['exec', 'resume', '--help'], { timeoutMs: 10_000 });
      checks.nativeOptions.resumeJson = resumeHelp.stdout.includes('--json');
      checks.nativeOptions.resumeModel = resumeHelp.stdout.includes('--model');
      checks.nativeOptions.resumeIgnoreConfig = resumeHelp.stdout.includes('--ignore-user-config');
    }
    if (Object.values(checks.nativeOptions).some((present) => !present))
      throw new Error('Codex CLI is missing a required exec option');
  }
  if (harnesses.includes('adelic')) {
    const bootstrap = await api('/api/bootstrap');
    const codex = bootstrap.providers?.find((provider) => provider.id === 'codex');
    const model = codex?.models?.find((entry) => entry.id === MODEL);
    checks.adelic = {
      url: BASE_URL,
      codexAvailable: Boolean(codex?.available),
      modelSupported: Boolean(model),
      effortSupported: model?.efforts?.includes(EFFORT) ?? null,
      sandboxSetting: bootstrap.settings?.sandbox ?? null,
      memoryEnabled: bootstrap.settings?.memoryEnabled ?? null,
    };
    if (!checks.adelic.codexAvailable || !checks.adelic.modelSupported)
      throw new Error('Adelic does not advertise the required Codex provider/model');
    if (checks.adelic.effortSupported === false)
      throw new Error(`Adelic model does not advertise ${EFFORT} reasoning effort`);
    const diagnostics = await api('/api/diagnostics');
    checks.adelic.loopbackDiagnostics = {
      platform: diagnostics.system?.platform,
      bubblewrapAvailable: Boolean(diagnostics.sandbox?.bubblewrap),
      remoteAccess: 'not inspected by runner; no remote-access settings are changed',
    };
  }
  return { checks, taskChecks };
}

function ensureDirs() {
  for (const path of ['runs', 'workspaces', 'logs', 'tests'])
    mkdirSync(join(EVAL_ROOT, path), { recursive: true, mode: 0o700 });
}

function prepareWorkspace(harness, task, attemptId, info) {
  const path = join(EVAL_ROOT, 'workspaces', `${harness}-${task.id}-${attemptId}`);
  if (existsSync(path)) throw new Error(`Fresh workspace already exists: ${path}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const instructionTarget = join(path, 'EXERCISE.md');
  writeFileSync(instructionTarget, `${info.instructions.trim()}\n\nPublic API: ${task.api}\n`, { mode: 0o600 });
  return path;
}

function normalizeRun(task, harness, attemptId, startedAt, wallTimeMs, fields = {}) {
  return {
    task: task.id,
    harness,
    attempt: 1,
    attemptId,
    model: MODEL,
    reasoningEffort: EFFORT,
    startedAt,
    finishedAt: nowIso(),
    wallTimeMs,
    outcome: fields.outcome ?? 'unknown',
    inputTokens: fields.inputTokens ?? null,
    outputTokens: fields.outputTokens ?? null,
    cachedInputTokens: fields.cachedInputTokens ?? null,
    reasoningOutputTokens: fields.reasoningOutputTokens ?? null,
    tokenAvailability: fields.tokenAvailability ?? 'not reported by runtime',
    toolCalls: fields.toolCalls ?? null,
    failures: fields.failures ?? [],
    exitCode: fields.exitCode ?? null,
    testResult: fields.testResult ?? null,
    workspace: fields.workspace,
    runId: fields.runId ?? null,
    sessionId: fields.sessionId ?? null,
    terminalStateConfirmed: fields.terminalStateConfirmed ?? null,
    toolCountMethod: fields.toolCountMethod ?? null,
    ...fields.extra,
  };
}

async function configureAdelic() {
  const current = await api('/api/bootstrap');
  const patch = {
    sandbox: 'workspace-write',
    memoryEnabled: false,
    approvalMode: 'automatic',
    autoRetry: false,
    autoCompact: false,
  };
  // This benchmark server must be disposable and isolated; avoid persisting settings to a personal profile.
  if (
    current.settings?.sandbox !== 'workspace-write' ||
    current.settings?.memoryEnabled !== false ||
    current.settings?.approvalMode !== 'automatic' ||
    current.settings?.autoRetry !== false ||
    current.settings?.autoCompact !== false
  )
    await api('/api/settings', { method: 'PATCH', body: patch });
}

async function waitAdelicRun(sessionId, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let detail;
  while (Date.now() < deadline) {
    detail = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const run = detail.runs?.find((candidate) => candidate.id === runId);
    if (run && run.status !== 'running') return { detail, run };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  return { detail, run: detail?.runs?.find((candidate) => candidate.id === runId), timedOut: true };
}

async function cancelAdelicRun(sessionId, runId) {
  const failures = [];
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', timeoutMs: 10_000 });
  } catch (error) {
    failures.push(`Cancellation request failed: ${error.message}`);
  }
  let terminal;
  try {
    terminal = await waitAdelicRun(sessionId, runId, 15_000);
  } catch (error) {
    failures.push(`Could not confirm terminal run state after cancellation: ${error.message}`);
    return { terminalStateConfirmed: false, failures };
  }
  const terminalStateConfirmed = Boolean(terminal.run && terminal.run.status !== 'running');
  if (!terminalStateConfirmed) failures.push('Adelic did not reach a confirmed terminal state after cancellation');
  return { ...terminal, terminalStateConfirmed, failures };
}

async function cancelLatestActiveAdelicRun(sessionId) {
  try {
    const detail = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    const run = [...(detail.runs ?? [])].reverse().find((candidate) => candidate.status === 'running');
    if (!run) return { terminalStateConfirmed: true, failures: [] };
    return cancelAdelicRun(sessionId, run.id);
  } catch (error) {
    return {
      terminalStateConfirmed: false,
      failures: [`Could not inspect/cancel active Adelic run: ${error.message}`],
    };
  }
}

async function runAdelic(task, info, workspace, attemptId) {
  const setupStartedAt = Date.now();
  await configureAdelic();
  const project = await api('/api/projects', {
    method: 'POST',
    body: {
      name: `Benchmark ${task.id} ${attemptId.slice(0, 8)}`,
      path: workspace,
      memoryWorkspace: 'benchmark',
      memoryProject: task.id,
      approvalMode: 'automatic',
      orchestration: { enabled: false, maxWorkers: 1, review: false },
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
  const setupWallTimeMs = Date.now() - setupStartedAt;
  const startIso = nowIso();
  const startedAt = Date.now();
  let accepted;
  try {
    accepted = await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      body: { content: info.prompt, clientMessageId: `benchmark-${attemptId}` },
      timeoutMs: 15_000,
    });
  } catch (error) {
    const cleanup = await cancelLatestActiveAdelicRun(session.id);
    throw new Error(
      `Adelic message submission failed; cleanup terminal=${cleanup.terminalStateConfirmed}: ${error.message}; ${cleanup.failures.join('; ')}`,
      { cause: error },
    );
  }
  const runId = accepted.run?.id ?? accepted.runId;
  if (!runId) {
    const cleanup = await cancelLatestActiveAdelicRun(session.id);
    throw new Error(
      `Adelic did not return a run id; cleanup terminal=${cleanup.terminalStateConfirmed}: ${JSON.stringify(accepted)}; ${cleanup.failures.join('; ')}`,
    );
  }
  let result;
  try {
    result = await waitAdelicRun(session.id, runId, ATTEMPT_LIMIT_MS);
  } catch (error) {
    const cleanup = await cancelAdelicRun(session.id, runId);
    throw new Error(
      `Adelic polling failed; cleanup terminal=${cleanup.terminalStateConfirmed}: ${error.message}; ${cleanup.failures.join('; ')}`,
      { cause: error },
    );
  }
  const attemptTimedOut = result.timedOut === true;
  let terminalStateConfirmed = Boolean(result.run && result.run.status !== 'running');
  let timeoutFailures = [];
  if (result.timedOut) {
    const cancelled = await cancelAdelicRun(session.id, runId);
    result = cancelled;
    terminalStateConfirmed = cancelled.terminalStateConfirmed;
    timeoutFailures = cancelled.failures;
  }
  const run = result.run;
  const toolEvents = (result.detail?.events ?? []).filter((event) => event.runId === runId && event.type === 'tool');
  const failures = [];
  if (attemptTimedOut) failures.push('Adelic run exceeded 180-second attempt limit');
  failures.push(...timeoutFailures);
  if (run?.error) failures.push(run.error);
  if (run?.failure) failures.push(run.failure.reason);
  failures.push(
    ...(result.detail?.events ?? [])
      .filter((event) => event.runId === runId && event.type === 'error')
      .map((event) => event.error ?? event.text),
  );
  const assistantMessages = (result.detail?.messages ?? []).filter(
    (message) => message.runId === runId && message.role === 'assistant',
  );
  const output = assistantMessages.map((message) => message.content).join('\n');
  writeFileSync(join(EVAL_ROOT, 'logs', `${attemptId}.adelic-output.txt`), output, { mode: 0o600 });
  const elapsed = Date.now() - startedAt;
  return normalizeRun(task, 'adelic', attemptId, startIso, elapsed, {
    outcome: attemptTimedOut ? 'timeout' : (run?.status ?? 'unknown'),
    inputTokens: run?.inputTokens ?? null,
    outputTokens: run?.outputTokens ?? null,
    cachedInputTokens: run?.cachedInputTokens ?? null,
    reasoningOutputTokens: run?.reasoningOutputTokens ?? null,
    tokenAvailability:
      run?.inputTokens !== undefined ||
      run?.outputTokens !== undefined ||
      run?.cachedInputTokens !== undefined ||
      run?.reasoningOutputTokens !== undefined
        ? 'reported by Adelic Run contract'
        : 'token counts not reported by Adelic Run contract for this run',
    toolCalls:
      new Set(toolEvents.map((event) => event.toolCallId).filter(Boolean)).size +
      toolEvents.filter((event) => !event.toolCallId).length,
    failures,
    testResult: null,
    workspace,
    runId,
    sessionId: session.id,
    terminalStateConfirmed,
    toolCountMethod: 'Adelic unique toolCallId values; events without IDs counted once each',
    extra: { projectId: project.id, setupWallTimeMs },
  });
}

function parseNativeJson(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Preserve non-JSON diagnostics in the log; the result reports parse failures only when none exist.
    }
  }
  return events;
}

async function runNative(task, info, workspace, attemptId) {
  const startIso = nowIso();
  const startedAt = Date.now();
  const args = [
    'exec',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--model',
    MODEL,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '-c',
    'approval_policy="never"',
    '-c',
    'model_reasoning_effort="high"',
    '-c',
    'mcp_servers={}',
    '--cd',
    workspace,
    '-',
  ];
  const child = await execFile(CODEX, args, {
    cwd: workspace,
    timeoutMs: ATTEMPT_LIMIT_MS,
    input: info.prompt,
    env: { ...process.env, CODEX_DISABLE_TELEMETRY: '1' },
  });
  const events = parseNativeJson(child.stdout);
  const turnCompleted = [...events].reverse().find((event) => event.type === 'turn.completed');
  const turnFailed = [...events].reverse().find((event) => event.type === 'turn.failed');
  const usage =
    turnCompleted?.usage ??
    events
      .map((event) => event.usage)
      .filter(Boolean)
      .at(-1) ??
    {};
  const toolItems = new Set(
    events
      .filter(
        (event) =>
          event.type === 'item.started' &&
          ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(event.item?.type),
      )
      .map((event) => event.item?.id)
      .filter(Boolean),
  );
  const failures = [];
  if (child.timedOut) failures.push('Native Codex run exceeded 180-second attempt limit');
  if (child.code !== 0 && !child.timedOut) failures.push(`Codex CLI exited ${child.code ?? child.signal}`);
  if (turnFailed) failures.push(turnFailed.error?.message ?? turnFailed.message ?? 'Codex turn failed');
  const result = normalizeRun(task, 'native', attemptId, startIso, Date.now() - startedAt, {
    outcome: child.timedOut
      ? 'timeout'
      : turnCompleted
        ? 'completed'
        : turnFailed
          ? 'failed'
          : child.code === 0
            ? 'unknown'
            : 'failed',
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? null,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? null,
    cachedInputTokens:
      usage.cached_input_tokens ??
      usage.cachedInputTokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.inputTokenDetails?.cachedTokens ??
      null,
    reasoningOutputTokens:
      usage.reasoning_output_tokens ??
      usage.reasoningOutputTokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.outputTokenDetails?.reasoningTokens ??
      null,
    tokenAvailability: Object.keys(usage).length
      ? 'reported by Codex JSON events'
      : 'Codex JSON events contained no usage object',
    toolCalls: toolItems.size,
    failures,
    exitCode: child.code,
    testResult: null,
    workspace,
    terminalStateConfirmed: child.code !== null && !child.timedOut,
    toolCountMethod: 'Native Codex item.started events, unique item IDs for command/tool-like items',
    extra: { timedOut: child.timedOut, signal: child.signal },
  });
  writeFileSync(join(EVAL_ROOT, 'logs', `${attemptId}.native.jsonl`), child.stdout, { mode: 0o600 });
  writeFileSync(join(EVAL_ROOT, 'logs', `${attemptId}.native.stderr.log`), child.stderr, { mode: 0o600 });
  const finalText = [...events]
    .reverse()
    .find((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')?.item?.text;
  if (finalText) writeFileSync(join(EVAL_ROOT, 'logs', `${attemptId}.native-output.txt`), finalText, { mode: 0o600 });
  return result;
}

async function createRegressionContext(harness, regression, attemptId) {
  const workspace = join(EVAL_ROOT, 'workspaces', `${harness}-regression-${attemptId}`);
  mkdirSync(workspace, { recursive: false, mode: 0o700 });
  copyFileSync(regression.files.starter, join(workspace, 'reading_list.py'));
  const context = { harness, workspace, sessionId: null, projectId: null, threadId: null };
  if (harness === 'adelic') {
    const setupStartedAt = Date.now();
    await configureAdelic();
    const project = await api('/api/projects', {
      method: 'POST',
      body: {
        name: `Harness regression ${attemptId.slice(0, 8)}`,
        path: workspace,
        memoryWorkspace: 'benchmark',
        memoryProject: 'reading-list-maintenance',
        approvalMode: 'automatic',
        orchestration: { enabled: false, maxWorkers: 1, review: false },
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
    context.sessionId = session.id;
    context.projectId = project.id;
    context.setupWallTimeMs = Date.now() - setupStartedAt;
  }
  return context;
}

async function runRegressionAdelicTurn(context, regression, turnIndex, attemptId) {
  const turnName = turnIndex === 0 ? 'repair' : 'followup';
  const startedAt = Date.now();
  const startedIso = nowIso();
  let accepted;
  try {
    accepted = await api(`/api/sessions/${encodeURIComponent(context.sessionId)}/messages`, {
      method: 'POST',
      body: { content: regression.texts[turnName], clientMessageId: `regression-${attemptId}` },
      timeoutMs: 15_000,
    });
  } catch (error) {
    const cleanup = await cancelLatestActiveAdelicRun(context.sessionId);
    throw new Error(
      `Adelic regression turn ${turnName} submission failed; cleanup terminal=${cleanup.terminalStateConfirmed}: ${error.message}; ${cleanup.failures.join('; ')}`,
      { cause: error },
    );
  }
  const runId = accepted.run?.id ?? accepted.runId;
  if (!runId) {
    const cleanup = await cancelLatestActiveAdelicRun(context.sessionId);
    throw new Error(
      `Adelic regression turn ${turnName} returned no run id; cleanup terminal=${cleanup.terminalStateConfirmed}; ${cleanup.failures.join('; ')}`,
    );
  }
  let waited;
  try {
    waited = await waitAdelicRun(context.sessionId, runId, REGRESSION_TURN_LIMIT_MS);
  } catch (error) {
    const cleanup = await cancelAdelicRun(context.sessionId, runId);
    throw new Error(
      `Adelic regression turn ${turnName} polling failed; cleanup terminal=${cleanup.terminalStateConfirmed}: ${error.message}; ${cleanup.failures.join('; ')}`,
      { cause: error },
    );
  }
  const timedOut = waited.timedOut === true;
  let terminalStateConfirmed = Boolean(waited.run && waited.run.status !== 'running');
  let failures = [];
  if (timedOut) {
    failures.push(`Adelic regression turn exceeded ${REGRESSION_TURN_LIMIT_MS / 1000}-second limit`);
    const cancelled = await cancelAdelicRun(context.sessionId, runId);
    waited = cancelled;
    terminalStateConfirmed = cancelled.terminalStateConfirmed;
    failures = [...failures, ...cancelled.failures];
  }
  const run = waited.run;
  if (run?.error) failures.push(run.error);
  if (run?.failure?.reason) failures.push(run.failure.reason);
  const events = (waited.detail?.events ?? []).filter((event) => event.runId === runId);
  failures.push(...events.filter((event) => event.type === 'error').map((event) => event.error ?? event.text));
  const output = (waited.detail?.messages ?? [])
    .filter((message) => message.runId === runId && message.role === 'assistant')
    .map((message) => message.content)
    .join('\n');
  writeFileSync(join(EVAL_ROOT, 'logs', `${attemptId}.adelic-output.txt`), output, { mode: 0o600 });
  const toolEvents = events.filter((event) => event.type === 'tool');
  const item = {
    id: regression.id,
    module: 'reading_list.py',
    reason: 'opt-in multi-turn maintenance regression case',
  };
  return normalizeRun(item, 'adelic', attemptId, startedIso, Date.now() - startedAt, {
    outcome: timedOut ? 'timeout' : (run?.status ?? 'unknown'),
    inputTokens: run?.inputTokens ?? null,
    outputTokens: run?.outputTokens ?? null,
    cachedInputTokens: run?.cachedInputTokens ?? null,
    reasoningOutputTokens: run?.reasoningOutputTokens ?? null,
    tokenAvailability:
      run?.inputTokens !== undefined ||
      run?.outputTokens !== undefined ||
      run?.cachedInputTokens !== undefined ||
      run?.reasoningOutputTokens !== undefined
        ? 'reported by Adelic Run contract'
        : 'token counts not reported by Adelic Run contract for this turn',
    toolCalls:
      new Set(toolEvents.map((event) => event.toolCallId).filter(Boolean)).size +
      toolEvents.filter((event) => !event.toolCallId).length,
    failures,
    workspace: context.workspace,
    runId,
    sessionId: context.sessionId,
    terminalStateConfirmed,
    toolCountMethod: 'Adelic unique toolCallId values; events without IDs counted once each',
    extra: {
      turn: turnName,
      projectId: context.projectId,
      setupWallTimeMs: turnIndex === 0 ? context.setupWallTimeMs : 0,
    },
  });
}

async function runRegressionNativeTurn(context, regression, turnIndex, attemptId) {
  const turnName = turnIndex === 0 ? 'repair' : 'followup';
  const startedAt = Date.now();
  const startedIso = nowIso();
  const args =
    turnIndex === 0
      ? [
          'exec',
          '--json',
          '--ignore-user-config',
          '--ignore-rules',
          '--model',
          MODEL,
          '--sandbox',
          'workspace-write',
          '--skip-git-repo-check',
          '-c',
          'approval_policy="never"',
          '-c',
          'model_reasoning_effort="high"',
          '-c',
          'mcp_servers={}',
          '--cd',
          context.workspace,
          '-',
        ]
      : [
          '--sandbox',
          'workspace-write',
          'exec',
          'resume',
          '--json',
          '--ignore-user-config',
          '--ignore-rules',
          '--model',
          MODEL,
          '--skip-git-repo-check',
          '-c',
          'approval_policy="never"',
          '-c',
          'model_reasoning_effort="high"',
          '-c',
          'mcp_servers={}',
          context.threadId,
          '-',
        ];
  const child = await execFile(CODEX, args, {
    cwd: context.workspace,
    timeoutMs: REGRESSION_TURN_LIMIT_MS,
    input: regression.texts[turnName],
    env: { ...process.env, CODEX_DISABLE_TELEMETRY: '1' },
  });
  const events = parseNativeJson(child.stdout);
  if (turnIndex === 0) {
    const started = events.find((event) => event.type === 'thread.started');
    context.threadId = started?.thread_id ?? started?.threadId ?? started?.session_id ?? null;
  }
  const turnCompleted = [...events].reverse().find((event) => event.type === 'turn.completed');
  const turnFailed = [...events].reverse().find((event) => event.type === 'turn.failed');
  const usage =
    turnCompleted?.usage ??
    events
      .map((event) => event.usage)
      .filter(Boolean)
      .at(-1) ??
    {};
  const toolItems = new Set(
    events
      .filter(
        (event) =>
          event.type === 'item.started' &&
          ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(event.item?.type),
      )
      .map((event) => event.item?.id)
      .filter(Boolean),
  );
  const failures = [];
  if (child.timedOut) failures.push(`Native regression turn exceeded ${REGRESSION_TURN_LIMIT_MS / 1000}-second limit`);
  if (child.code !== 0 && !child.timedOut) failures.push(`Codex CLI exited ${child.code ?? child.signal}`);
  if (turnFailed) failures.push(turnFailed.error?.message ?? turnFailed.message ?? 'Codex turn failed');
  if (turnIndex === 0 && !context.threadId)
    failures.push('Codex JSON stream did not report a thread id; follow-up turn cannot resume');
  const item = {
    id: regression.id,
    module: 'reading_list.py',
    reason: 'opt-in multi-turn maintenance regression case',
  };
  const nativeUsageReported = nativeUsageSnapshot(usage);
  const nativeUsageBaseline = turnIndex === 0 ? undefined : context.nativeUsage;
  const turnUsage = nativeTurnUsage(nativeUsageReported, nativeUsageBaseline ?? (turnIndex === 0 ? undefined : {}));
  context.nativeUsage = nativeUsageReported;
  const result = normalizeRun(item, 'native', attemptId, startedIso, Date.now() - startedAt, {
    outcome: child.timedOut
      ? 'timeout'
      : turnCompleted
        ? 'completed'
        : turnFailed
          ? 'failed'
          : child.code === 0
            ? 'unknown'
            : 'failed',
    ...turnUsage,
    tokenAvailability: Object.keys(usage).length
      ? 'per-turn delta of cumulative Codex JSON usage'
      : 'Codex JSON events contained no usage object',
    toolCalls: toolItems.size,
    failures,
    exitCode: child.code,
    workspace: context.workspace,
    terminalStateConfirmed: child.code !== null && !child.timedOut,
    toolCountMethod: 'Native Codex item.started events, unique item IDs for command/tool-like items',
    extra: {
      turn: turnName,
      threadId: context.threadId,
      timedOut: child.timedOut,
      signal: child.signal,
      nativeUsageReported,
      nativeUsageBaseline,
      usageAccounting: 'thread-total delta',
    },
  });
  writeFileSync(join(EVAL_ROOT, 'logs', `${attemptId}.native.jsonl`), child.stdout, { mode: 0o600 });
  writeFileSync(join(EVAL_ROOT, 'logs', `${attemptId}.native.stderr.log`), child.stderr, { mode: 0o600 });
  return result;
}

async function evaluateRegression(run, regression, testName, attemptId) {
  if (run.terminalStateConfirmed === false) {
    run.testResult = { outcome: 'not_run', reason: 'Model run did not reach a confirmed terminal state' };
    return run;
  }
  const testDir = join(EVAL_ROOT, 'tests', 'regression', attemptId);
  mkdirSync(testDir, { recursive: true, mode: 0o700 });
  const sourceTest = testName === 'test_repair.py' ? regression.files.repairTest : regression.files.followupTest;
  copyFileSync(sourceTest, join(testDir, testName));
  const result = await execFile('python3', ['-m', 'unittest', 'discover', '-s', testDir, '-p', testName], {
    cwd: run.workspace,
    timeoutMs: TEST_LIMIT_MS,
    env: { ...process.env, PYTHONPATH: [run.workspace, process.env.PYTHONPATH].filter(Boolean).join(':') },
  });
  const testLog = join(EVAL_ROOT, 'logs', `${attemptId}.tests.log`);
  writeFileSync(testLog, `${result.stdout}${result.stderr}`, { mode: 0o600 });
  const passed = result.code === 0 && !result.timedOut;
  run.testResult = {
    outcome: result.timedOut ? 'timeout' : passed ? 'passed' : 'failed',
    exitCode: result.code,
    log: testLog,
    testCount: Number((result.stderr.match(/Ran (\d+) tests?/) ?? [])[1] ?? 0),
  };
  if (!passed) run.failures.push(`Regression unittest suite ${run.testResult.outcome}`);
  return run;
}

async function runRegressionSuite(harnesses, checked) {
  ensureDirs();
  const regression = regressionCase();
  const attemptId = randomUUID();
  const runMeta = {
    id: attemptId,
    startedAt: nowIso(),
    suite: 'opt-in regression mini-project; independent from Polyglot cases',
    caseId: regression.id,
    fixtureMetadata: regression.metadata,
    model: MODEL,
    reasoningEffort: EFFORT,
    adelicMode: 'deep',
    nativeExecMode:
      'Codex exec with one fresh persisted thread and one resume turn; conversation history persists in configured CODEX_HOME for regression only',
    harnesses,
    turnAttemptsMaximum: harnesses.length * 2,
    maxActiveTurnSeconds: REGRESSION_TURN_LIMIT_MS / 1000,
    maxAggregateActiveTurnSeconds: (harnesses.length * 2 * REGRESSION_TURN_LIMIT_MS) / 1000,
    timeoutCleanupBudgetSeconds: harnesses.includes('adelic') ? 50 : 0,
    oneAttemptPerTurn: true,
    retryPolicy: 'no retries',
    harnessOrder: ['repair: adelic then native', 'follow-up: native then adelic'],
    preflight: checked.checks,
  };
  const contexts = new Map();
  for (const harness of harnesses)
    contexts.set(harness, await createRegressionContext(harness, regression, `${attemptId}-${harness}`));
  const results = [];
  const turnRuns = new Map();
  for (let turnIndex = 0; turnIndex < 2; turnIndex += 1) {
    const order = harnesses.length === 2 && turnIndex === 1 ? [...harnesses].reverse() : harnesses;
    for (const harness of order) {
      const context = contexts.get(harness);
      const turnName = turnIndex === 0 ? 'repair' : 'followup';
      const key = `${attemptId}-${turnName}-${harness}`;
      const priorRun = turnRuns.get(`${harness}-repair`);
      if (
        turnIndex === 1 &&
        (priorRun?.terminalStateConfirmed === false || (harness === 'native' && !context.threadId))
      ) {
        results.push({
          task: regression.id,
          harness,
          turn: turnName,
          attempt: 1,
          attemptId: key,
          model: MODEL,
          reasoningEffort: EFFORT,
          outcome: 'not_run',
          wallTimeMs: 0,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          reasoningOutputTokens: null,
          toolCalls: null,
          failures: ['Previous turn did not reach a confirmed terminal state'],
          testResult: { outcome: 'not_run' },
          workspace: context.workspace,
        });
        continue;
      }
      const run =
        harness === 'adelic'
          ? await runRegressionAdelicTurn(context, regression, turnIndex, key)
          : await runRegressionNativeTurn(context, regression, turnIndex, key);
      if (interrupted) throw new Error('Interrupted; model process stopped and test evaluation skipped');
      run.turn = turnName;
      turnRuns.set(`${harness}-${turnName}`, run);
      const evaluated = await evaluateRegression(
        run,
        regression,
        turnIndex === 0 ? 'test_repair.py' : 'test_followup.py',
        key,
      );
      results.push(evaluated);
      writeJson(join(EVAL_ROOT, 'runs', `${attemptId}-${harness}-${turnName}.json`), evaluated);
      process.stdout.write(
        `${JSON.stringify({ completed: `${regression.id}/${harness}/${turnName}`, outcome: run.outcome, tests: run.testResult?.outcome, wallTimeMs: run.wallTimeMs })}\n`,
      );
    }
  }
  const reportPath = join(EVAL_ROOT, 'regression-report.md');
  const lines = [
    '# Opt-in harness regression mini-project',
    '',
    `Generated: ${nowIso()}`,
    'Separate from the three fixed Polyglot exercises; this scenario is not an official benchmark score.',
    'Sequence: repair a case-insensitive removal defect, then add read tracking in the same session/workspace.',
    `Budget: ${runMeta.turnAttemptsMaximum} turn attempts maximum; ${runMeta.maxActiveTurnSeconds}s active-time ceiling per turn and ${runMeta.maxAggregateActiveTurnSeconds}s aggregate active-turn ceiling. These are time ceilings, not strict limits on internal model calls, tokens, or cost; Adelic timeout cancellation may add up to ${runMeta.timeoutCleanupBudgetSeconds}s. One attempt per turn, no retries.`,
    'Native regression mode starts a fresh persisted Codex thread and resumes it for the second turn; its conversation history persists in configured CODEX_HOME. This persistence applies only to regression. Adelic sends both turns in one fresh session.',
    'Token counts reflect only runtime-reported fields; Adelic Run and native Codex turn usage may have different accounting. No cost is inferred.',
    '',
    '| Turn | Harness | Outcome | Tests | Wall time | Input | Output | Cached input | Reasoning output | Tools | Failures |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const item of results)
    lines.push(
      `| ${item.turn ?? 'follow-up'} | ${item.harness} | ${item.outcome} | ${item.testResult?.outcome ?? 'not run'} | ${(item.wallTimeMs / 1000).toFixed(1)}s | ${item.inputTokens ?? 'unknown'} | ${item.outputTokens ?? 'unknown'} | ${item.cachedInputTokens ?? 'unknown'} | ${item.reasoningOutputTokens ?? 'unknown'} | ${item.toolCalls ?? 'unknown'} | ${item.failures?.length ? item.failures.join('; ').replaceAll('|', '\\|') : 'none'} |`,
    );
  lines.push('');
  writeFileSync(reportPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  runMeta.finishedAt = nowIso();
  writeJson(join(EVAL_ROOT, 'regression-results.json'), { run: runMeta, results });
  process.stdout.write(`Report: ${reportPath}\n`);
}

async function evaluate(task, harness, run, info) {
  if (run.terminalStateConfirmed === false) {
    run.testResult = { outcome: 'not_run', reason: 'Adelic run did not reach a confirmed terminal state' };
    return run;
  }
  const testDir = join(EVAL_ROOT, 'tests', task.id);
  mkdirSync(testDir, { recursive: true, mode: 0o700 });
  const externalTest = join(testDir, task.test);
  copyFileSync(info.testPath, externalTest);
  const result = await execFile('python3', ['-m', 'unittest', 'discover', '-s', testDir, '-p', task.test], {
    cwd: run.workspace,
    timeoutMs: TEST_LIMIT_MS,
    env: { ...process.env, PYTHONPATH: [run.workspace, process.env.PYTHONPATH].filter(Boolean).join(':') },
  });
  const testLog = join(EVAL_ROOT, 'logs', `${run.attemptId}.tests.log`);
  writeFileSync(testLog, `${result.stdout}${result.stderr}`, { mode: 0o600 });
  const passed = result.code === 0 && !result.timedOut;
  run.testResult = {
    outcome: result.timedOut ? 'timeout' : passed ? 'passed' : 'failed',
    exitCode: result.code,
    log: testLog,
    testCount: Number((result.stderr.match(/Ran (\d+) tests?/) ?? [])[1] ?? 0),
  };
  if (!passed) run.failures.push(`Original upstream unittest suite ${run.testResult.outcome}`);
  return run;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function report(results, runMeta) {
  const lines = [
    '# Adelic harness trial',
    '',
    `Generated: ${nowIso()}`,
    `Polyglot source: Aider-AI/polyglot-benchmark @ ${SOURCE_COMMIT}`,
    'Scope: 3 selected Python exercises × one attempt per harness; adapted subset, not an official score.',
    `Model: ${MODEL}; reasoning effort: ${EFFORT}; per-attempt limit: ${ATTEMPT_LIMIT_MS / 1000}s.`,
    '',
    '| Task | Harness | Outcome | Tests | Wall time | Input tokens | Output tokens | Cached input | Reasoning output | Tool calls | Failures |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const item of results) {
    const testResult = item.testResult?.outcome ?? 'not run';
    lines.push(
      `| ${item.task} | ${item.harness} | ${item.outcome} | ${testResult} | ${(item.wallTimeMs / 1000).toFixed(1)}s | ${item.inputTokens ?? 'unknown'} | ${item.outputTokens ?? 'unknown'} | ${item.cachedInputTokens ?? 'unknown'} | ${item.reasoningOutputTokens ?? 'unknown'} | ${item.toolCalls ?? 'unknown'} | ${item.failures.length ? item.failures.join('; ').replaceAll('|', '\\|') : 'none'} |`,
    );
  }
  lines.push(
    '',
    'Tasks were chosen for small standard-library implementations covering state, validation, and whitespace edge cases. The original tests remained outside the model workspace and were run only after generation.',
    'grade-school was clarified to specify list return formats after an exploratory run exposed ambiguity in the source instructions; that earlier run is excluded from formal results.',
    'Wall time begins with the Adelic message request or native Codex process start; Adelic project/session setup is recorded separately as setupWallTimeMs in results.json.',
    'Adelic uses mode=deep; native Codex exec has no equivalent mode parameter, so this compares the real harness flows rather than identical orchestration settings.',
    'Token counts are recorded only when the runtime reports them: Adelic run-level usage and native Codex turn-level usage are not guaranteed to use identical accounting; cached input is unknown when omitted. No cost is inferred from tokens.',
    '',
  );
  const reportPath = join(EVAL_ROOT, 'report.md');
  writeFileSync(reportPath, lines.join('\n'), { mode: 0o600 });
  writeJson(join(EVAL_ROOT, 'results.json'), { run: runMeta, results });
  return reportPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'help') return process.stdout.write(`${help}\n`);
  const tasks = options.suite === 'polyglot' ? selectedTasks(options) : [];
  const harnesses = selectedHarnesses(options);
  if (options.mode === 'dry-run') {
    const revision = options.suite === 'polyglot' ? sourceRevision() : null;
    const dryRun =
      options.suite === 'polyglot'
        ? tasks.map((task) => ({ ...taskFiles(task).metadata, harnesses, model: MODEL, reasoningEffort: EFFORT }))
        : regressionCase().metadata;
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'dry-run',
          suite: options.suite,
          sourceCommit: revision,
          turnAttemptsPlanned: 0,
          turnAttemptsMaximumIfRun:
            options.suite === 'regression' ? harnesses.length * 2 : tasks.length * harnesses.length,
          tasks: dryRun,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const checked = await preflight(harnesses, options.suite);
  process.stdout.write(
    `${JSON.stringify({ mode: options.mode, suite: options.suite, preflight: checked.checks, tasks: checked.taskChecks }, null, 2)}\n`,
  );
  if (options.mode !== 'run') return;
  if (options.suite === 'regression') return runRegressionSuite(harnesses, checked);
  ensureDirs();
  const attemptId = randomUUID();
  const runMeta = {
    id: attemptId,
    startedAt: nowIso(),
    sourceRepository: 'Aider-AI/polyglot-benchmark',
    sourcePath: SOURCE_ROOT,
    sourceCommit: SOURCE_COMMIT,
    scope: 'adapted three-task subset; not official benchmark score',
    model: MODEL,
    reasoningEffort: EFFORT,
    adelicMode: 'deep',
    nativeExecMode: 'Codex exec default; no Adelic mode setting exists in the CLI harness',
    maxAttemptSeconds: ATTEMPT_LIMIT_MS / 1000,
    oneAttemptPerTaskAndHarness: true,
    codexBinary: CODEX,
    adelicUrl: harnesses.includes('adelic') ? BASE_URL : null,
    artifactRoot: EVAL_ROOT,
    harnesses,
    harnessOrder: tasks.map((task, index) => ({
      task: task.id,
      order: harnesses.length === 2 && index % 2 === 1 ? [...harnesses].reverse() : harnesses,
    })),
  };
  const results = [];
  for (const task of tasks) {
    const info = taskFiles(task);
    const taskDir = join(EVAL_ROOT, 'runs', `${attemptId}-${task.id}`);
    mkdirSync(taskDir, { recursive: true, mode: 0o700 });
    writeJson(join(taskDir, 'task-metadata.json'), info.metadata);
    const orderedHarnesses =
      harnesses.length === 2 && tasks.indexOf(task) % 2 === 1 ? [...harnesses].reverse() : harnesses;
    for (const harness of orderedHarnesses) {
      const workspaceAttempt = `${attemptId}-${task.id}`;
      const workspace = prepareWorkspace(harness, task, workspaceAttempt, info);
      const run =
        harness === 'adelic'
          ? await runAdelic(task, info, workspace, `${attemptId}-${task.id}-${harness}`)
          : await runNative(task, info, workspace, `${attemptId}-${task.id}-${harness}`);
      if (interrupted) throw new Error('Interrupted; model process stopped and test evaluation skipped');
      results.push(await evaluate(task, harness, run, info));
      writeJson(join(taskDir, `${harness}-result.json`), run);
      process.stdout.write(
        `${JSON.stringify({ completed: `${task.id}/${harness}`, outcome: run.outcome, tests: run.testResult?.outcome, wallTimeMs: run.wallTimeMs })}\n`,
      );
    }
  }
  runMeta.finishedAt = nowIso();
  const reportPath = report(results, runMeta);
  process.stdout.write(`Report: ${reportPath}\n`);
}

main().catch((error) => {
  if (interrupted) {
    process.exitCode = 130;
    return;
  }
  process.stderr.write(`benchmark-harness: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
