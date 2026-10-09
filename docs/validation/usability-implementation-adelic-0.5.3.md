# Usability implementation through Adelic — 0.5.3

Date: 2026-10-08. Changes are in the local working tree, on top of the existing harness and usability work. Application version remains 0.5.3.

## Implementation process

The coordinator started the real Adelic backend on `127.0.0.1:4790`, with isolated operational data in `/tmp/adelic-usability-implementation/data`. It used the real Codex provider, four GPT-6 Luna coding conversations with high reasoning, and independent GPT-6.1 Sol and GPT-6 Astra review conversations. Work was submitted through Adelic's project, session and message APIs. The coordinator monitored run status, events, approvals, tool lifecycles and final answers through the session detail API.

Adelic rejected concurrent write runs in the same project. That guard was preserved: independent coding scopes used temporary source snapshots; the coordinator integrated only their assigned files after completion. Settings/model work used the actual repository. Project orchestration and Graphify were disabled in these temporary coding projects because the coordinator explicitly assigned each scope. Normal product defaults were preserved.

| Scope | Adelic conversation | Runtime / model |
| --- | --- | --- |
| Settings and models | `e09e842a-a39b-490a-b933-d1dd12722664` | Codex / gpt-6-luna, high |
| Guided SSH | `efd24710-7315-4dba-b9e4-3d09ac9d7421` | Codex / gpt-6-luna, high |
| Sidebar actions | `f3892cd9-5d3b-4544-9b82-853d7f4e9786` | Codex / gpt-6-luna, high |
| Progress and delivery | `cfa6e3ed-d723-43e0-83c1-03141177507b` | Codex / gpt-6-luna, high |
| Independent Sol review | `aab4c86f-6751-4353-9274-07feece048e3` | Codex / gpt-6.1-sol, high |
| Independent Astra review | `055914fd-80be-4f13-a288-88f8b97ade80` | Codex / gpt-6-astra, high |

Corrections to the SSH, sidebar and progress drafts were sent back through Adelic before integration. Reviewers used the local executor in read-only mode. Their first attempts exposed a real executor bug: the transport added a `readOnly` argument to read/list/stat/search tools whose strict schemas reject it. The coordinator fixed that adapter, added real isolated-executor coverage for the four tools while retaining write/exec denial, restarted the temporary backend and resumed both reviews successfully. Initial failed review runs are separate from the successful resumed reviews.

Operational records and raw model outputs remain outside the repository. No runtime credentials were copied into the source snapshots or test servers. The real provider implementation process used model calls; the browser regression suite uses scripted providers and isolated test data.

## Delivered journeys

- Settings opens in Basic mode, offers Advanced, keeps search visible while scrolling, searches advanced entries too and preserves mounted drafts. Cards distinguish global, project and mixed scope. The Automations settings shortcut opens the relevant setting directly.
- SSH setup discovers `~/.ssh/config` aliases automatically, then guides server selection, fingerprint verification, runner testing/preparation and project selection. A successful existing-runner test is sufficient; installation is optional and explicit. Failure clears readiness. Server details/actions stay separate from connection identity, including on mobile.
- Sidebar conversations have one contextual trigger with a conversation-specific accessible name. Rename, pin/unpin, archive/restore and move to a project or virtual folder use real API updates. Pins survive store reopening and sort first. Running conversations reject metadata changes. Keyboard navigation, Escape and focus restoration are covered.
- Model selection searches across providers and model identifiers, saves browser-local favorites, and displays only reported provider capabilities; absent data stays unknown. Favorites appear once. Model and runtime defaults remain distinct.
- A compact progress banner stays above the composer while reading older messages. It shows actual tool, approval, retry, response or disconnected state and time since activity. Silence does not imply a crash, and timers are not live-announced each second. The banner disappears when execution finishes or is cancelled.
- Delivery summarizes observed files and executed checks, preserves checks still running, collapses check output and groups next actions. Failed content reads can be retried. Opening/downloading content requests the current file again rather than serving stale cached contents. Evidence remains distinct from an agent's claim.
- Dedicated styles reuse the existing dark-theme tokens. Linux Chromium image baselines cover settings discovery, SSH setup, composer, model picker and access menu at 1280px and 390px. Images are generated using deterministic scripted-provider data, with fonts loaded before capture.

## Review findings and corrections

Sol and Astra identified: late SSH directory responses overwriting a new host/mode/path; the initial `/` listing rejected by HTTP validation; keyboard focus lost after sidebar actions; running checks filtered out when their command was not yet reported; and cached downloads contradicting the current-content label. These were corrected. HTTP root browsing, read-only executor behavior, check lifecycle consolidation, late SSH responses and fresh downloads have regression coverage.

Visual inspection caught a mobile flex-basis becoming a 230px vertical gap in the SSH selector. Its mobile basis now follows content height. The SSH screenshot shows the complete identity/steps/form without controls overlapping. Inspection also caught compressed access-menu options: their children now keep their natural height, the menu scrolls, and its selection mark no longer consumes half the option width. A geometry assertion checks that option text stays inside its button.

## Verification

Checks passed:

- `npm run typecheck`.
- `npm run lint`: zero errors, nine existing warnings outside these usability changes.
- `npm run format:check` and `git diff --check`.
- `npm test -- --maxWorkers=2`: 1,374 passed, one skipped, 91 files passed. A follow-up run of the four review regression files passed all 16 tests after check-identity consolidation.
- `npm run build`, including builds in the E2E commands.
- `npm run test:e2e`: 163 passed, about three minutes.
- After the final access-menu CSS correction: all six composer/access and visual-regression cases passed; the image baselines were inspected and then verified again without `--update-snapshots`. The existing full-suite result above preceded that final CSS adjustment.

The temporary real-provider Adelic instance was stopped after all six coding/review conversations completed. Its operational records remain under `/tmp/adelic-usability-implementation`; this path is temporary and is not a backup. Local-only access and the user's regular operational data were preserved.

The native T3 collaborative preview was queried and opened twice, using loopback URL variants. Both open calls timed out, so an interactive native-preview walkthrough could not be completed. Repository E2E journeys and their screenshots were used for regression validation; this limitation is not presented as an interactive preview pass.

The new SSH wizard browser cases simulate SSH responses. They validate client behavior, not a new connection to the user's real server. Real isolated-executor tests verify read-only reads and continued write restrictions. No production deployment or new release is implied by these checks.
