# General journey pilot

`scripts/benchmark-journeys.mjs` compares two Adelic project profiles with the same explicitly selected Codex model and `high` effort: **direct** has orchestration disabled; **coordinated** enables orchestration, review, and up to two workers, with worker and reviewer set to the same Codex model. Both use the same session model, deep mode, automatic approvals, `workspace-write`, disabled memory, and disabled Graphify. The experiment records configured and observed profiles. A coordinated project may correctly take a direct path for a simple task; that is recorded as a path observation rather than forced into delegation.

The six frozen general journeys cover repository inspection, a cohesive change, bug repair with regression coverage, a two-message continuation, a small change across two modules, and diagnosis of an unavailable runtime. The external graders and prompts live under `scripts/fixtures/general-journeys/`; the runner copies only each `starter/` tree into a new Git checkout for each profile. Oracles are outside the writable checkouts and independently check the resulting files or behavior. Graders run with Node's permission model, read access limited to the checkout and fixture tree, and no child-process, write, or network permission. Fixture Git init/commit and external grading are harness operations, not model runs.

The pair order alternates by journey: direct/coordinated, then coordinated/direct. There are at most 12 journey attempts (six journeys × two profiles). The continuation is one journey attempt per profile with two messages in the same session and a shared 180-second journey deadline. The 30-second finalization reserve is preserved for timeout cleanup; it is not renewed before message two. A failed or timed-out first turn prevents its continuation, and one profile's failure does not stop later journeys.

## Running safely

Both default mode and `--dry-run` make zero model calls. Dry-run checks the frozen prompt, starter, and grader inventory without a server. Preflight checks that inventory and the loopback URL; add `ADELIC_JOURNEY_CHECK_SERVER=1` to read `/api/bootstrap` and verify the selected model, advertised effort, sandbox, approval, retry, compaction, fallback, and memory settings. None of these modes submits a message.

The live mode requires an operator's explicit authorization and an isolated local Adelic server already configured for Codex, automatic approval, `workspace-write`, disabled memory, retry, compaction, and model fallback. It refuses a non-loopback URL and does not reconfigure the server. Its isolation marker is an operator attestation; the runner independently checks the URL and settings, but cannot prove the process data directory or host provenance.

```sh
ADELIC_JOURNEY_ALLOW_LIVE=I_AUTHORIZE_LOCAL_GENERAL_JOURNEY_RUNS \
ADELIC_JOURNEY_ISOLATED_SERVER=1 \
ADELIC_JOURNEY_MODEL=gpt-6-luna \
ADELIC_JOURNEY_URL=http://127.0.0.1:4790 \
node scripts/benchmark-journeys.mjs --run
```

`ADELIC_JOURNEY_ROOT` selects the artifact directory (default `/tmp/adelic-general-journeys`). Checkouts, assistant captures, per-attempt JSON, the persistent anti-replay ledger, and reports are created there with user-only permissions. Every run receives a unique ID, each attempt checks the ledger and rejects a reused attempt ID, and an existing checkout is never reused. Timeout/error attempts are retained in the denominator and profile failures are isolated.

## Evidence and limits

Each report includes external acceptance by profile and paired journey, medians and ranges, source commit and source/input hashes, alternating order, per-checkout diff hashes, setup and journey wall time, timeouts, errors, submitted turns, observed provider-call spans, delegated task roles, tool calls, available phase spans, and context byte diagnostics. Direct run usage and trace IDs are captured where available. Missing runtime counters remain `null`. The missing-runtime grader checks the diagnosis artifact and preserved fixture; the execution of the requested probe is not independently observed and is marked `unknown`. Initial prompt bytes are labeled separately and are not treated as total context or tokens. Provider-internal token/call hard caps are not claimed when the runtime does not expose them.

Actual billed cost is always unknown to this runner. An estimated cost is calculated only when both `ADELIC_JOURNEY_INPUT_USD_PER_MILLION` and `ADELIC_JOURNEY_OUTPUT_USD_PER_MILLION` are supplied explicitly; no current provider prices are embedded. Observed repair-attempt counts remain unknown when the runtime does not expose them. Trace spans can overlap and are never summed as wall latency. First-tool timing is reported only when the event has a timestamp.

Only medians and ranges are reported at this sample size; no P95 is calculated. Cache state cannot be controlled, so the runner labels it unknown and records local load average per attempt. Residual confounds include provider-side load, cold/warm caches, queue variation, a single run per profile/task, and runtime implementation details hidden from Adelic. This small pilot can guide a later repeated evaluation; it does not establish a production model policy or automatic routing rule.
