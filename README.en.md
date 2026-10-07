[Português](README.md) · **English**

# Adelic

A local app for chatting with agents, organizing projects and sharing context, with a web interface and a Linux desktop package. This first version uses the runtimes installed on your computer; sign-in stays with Codex, Claude Code or Kiro.

Download **[v0.4.0 for Linux x86_64](https://github.com/ikaromm/Adelic/releases/tag/v0.4.0)**: the AppImage, checksum and optional installer are in the release assets. The [release notes](docs/releases/v0.4.0.md) (in Portuguese) describe features and limits; the [changelog](CHANGELOG.md) (in Portuguese) records each version, and its "Não publicado" (unreleased) section lists what is already in the code but not yet released.

The Linux x86_64 desktop uses Electron and AppImage, with Node and SQLite built in. To build and install the package locally:

```bash
npm ci
npm run package:linux
./scripts/install-linux.sh
```

The artifact is written to `release/Adelic-<version>-linux-x86_64.AppImage`, together with a SHA-256 file. When there are several builds, pass the file to the installer: `./scripts/install-linux.sh /path/to/Adelic.AppImage`. Copy the AppImage to another Linux x86_64 machine, make it executable and open it; the target does not need Node/npm to run Adelic. The optional installer adds the `adelic` command and a menu entry, without deleting history. See [desktop usage, dependencies and tests](docs/en/desktop-linux.md).

To develop or run the web mode, you need Node.js 22.13 or later and npm:

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:4317**. The server listens on loopback only. To serve the local build: `npm run build` and `npm start`.

To update, use **Settings › Diagnostics › Update Adelic** on this computer: in a git checkout it advances the branch of the chosen channel (`master` or `develop`) by fast-forward only, rebuilds and restarts the server; in the AppImage it downloads the new release, checks the SHA-256 and restarts. It refuses when there are local changes, commits ahead or runs in progress. See [updating Adelic](docs/en/self-update.md). By hand, in a checkout: `git pull --ff-only`, `npm ci` if `package-lock.json` changed, `npm run build`, and restart.

- **Auto** picks the route with local rules, without an extra AI call. Direct questions use low effort and a trimmed history; requests involving files, research and execution get additional resources.
- **Fast** forces the short path, with one executor and local tools available when needed, and no automatic memory search, graph or planning. Direct questions may be answered without running commands. **Full** increases context and effort; tools are enabled when the request needs them.
- **Thinking** offers Auto and the levels advertised by the chosen model, including Very high, Max and Ultra when available. An explicit choice is passed on to delegated tasks, adapted to each model's capabilities; it does not enable tools or memory by itself. Without advertised levels, the selector offers only Auto.
- **Per-project orchestrator** starts on: it delegates execution and keeps a compact summary and the relevant paths. Quick questions go straight to one executor, with a single call. Larger jobs may involve planning, executors, review and synthesis; the screen follows the actual tasks. Settings lets you choose the executor/reviewer per project or turn orchestration off.
- **Per-project Graphify** starts on to guide code search. The local CLI builds an AST graph on the first query and returns bounded slices; quick questions do not query the graph. Settings shows the index state and lets you refresh it and run queries. Semantic documents are not indexed in this increment.
- Conversations have streaming, cancellation, persisted history, a tool log, and approvals when the runtime offers that protocol.
- Activity appears next to the turn, collapsed by default. Open the details to check tasks and actions, and load the full output when you need it. Approvals and errors stay visible.
- **New conversation** and Ctrl/Cmd+K open standalone chats. Use the **+ next to a project** to start a linked thread, or the **Project and mode** menu next to the message field to attach, switch or unlink it later. Messages and history are preserved; link changes are blocked while a run is in progress.
- The interface uses a **dark theme inspired by Dracula**, with a layout based on T3 Code: recent conversations in the sidebar, your messages in bubbles, compact turn activity, and model, thinking, permissions, project and mode controls in the message field itself. Standalone conversations keep adaptive delegation and their own working folder, without loading another project's Graphify or memory.
- **Memory** browses, searches and edits the shared knowledge base of the local `ai-memory`, the same one used by T3/Codex and other clients. The library works without a code project selected, has a catalog per workspace/project and picks up external changes; drafts and conflicts are protected. No copy of the notes is imported into Adelic's database. Adelic uses only the service API, so it works the same with ai-memory installed on the computer or in Docker; `ADELIC_MEMORY_URL` (default `http://127.0.0.1:49374`, loopback only) and `ADELIC_MEMORY_TOKEN`/`ADELIC_MEMORY_TOKEN_FILE` (when the service uses `AI_MEMORY_AUTH_TOKEN`) configure access. Details in [shared memory](docs/en/shared-memory.md). Each project has an explicit workspace and project. To configure this checkout, copy `.ai-memory.example.toml` to `.ai-memory.toml` and adjust the scope; the local configuration stays out of Git.
- **Activity** shows measured times and the usage reported by the provider. Missing values are shown as unavailable.
- **Settings** sets the provider, mode, memory, response style, write permission and context procedures.

The SQLite database is at `~/.local/share/adelic/adelic.sqlite` by default. `ADELIC_DATA_DIR` lets you choose another folder. Desktop and web share this database and cannot open it at the same time. Closing the desktop window cancels runs and stops the server; closing just a browser keeps the web mode running. Restarting the server marks pending work as interrupted. The JSON export includes the app data, without automatically importing the memory wiki.

Files produced in standalone conversations are stored in `~/.local/share/adelic/conversations/<conversation-id>/`. Linking the conversation changes the folder used for the next turns; files already produced stay in the original folder.

Graphify indexes are stored in `~/.local/share/adelic/graphs/<path-hash>/graphify-out/graph.json`, outside the project folders. The full output of each task can be loaded from the chat when you want to check the details.

Codex and Kiro were tested with real responses and file reads. The Claude Code adapter is implemented, but the CLI on this computer needs to sign in before validation with the Pro/Max subscription. OpenCode offers only installation and model discovery in this version; running it shows as unavailable.

Codex, Kiro and Claude use bubblewrap on Linux to limit writes, in addition to the native controls available; the default policy is read only. Automatic approval allows recognized local queries; ambiguous commands, scripts and sensitive requests are left for confirmation. For Kiro, only shell commands whose full text reaches Adelic and passes the same read-only list are approved automatically (once, never "always"); everything else stays manual. This does not isolate the network. The `ai-jail` integration is planned, and the app reports the real availability of the binary. Unavailable providers show the reason; subscriptions keep the limits of the official runtimes. After authenticating a CLI, restart the server to refresh discovery right away; it is cached for five minutes.

Adelic listens only on `127.0.0.1` by default. Remote access with a username and password, over the tailnet or over the internet with Tailscale Funnel, is optional and off: see [remote access](docs/en/remote-access.md). The ai-jail evaluation is in [ai-jail](docs/specs/ai-jail.md) (in Portuguese).

### Features not yet released

These features are already in `develop` and will ship in the next release. The ones that run something on their own or leave the computer start off. Linked specs are in Portuguese unless marked otherwise.

- **Conversation:** [attachments](docs/specs/attachments.md) of images and text files, [`@file` mentions](docs/specs/mentions.md), a [message queue](docs/specs/message-queue.md) with Send now and Steer, [edit and branch](docs/specs/edit-branch.md), [compaction with a summary](docs/specs/compaction.md), [continue with another agent](docs/specs/provider-handoff.md) and [local voice dictation](docs/specs/voice.md).
- **Planning and commands:** [plan mode](docs/en/plan-mode.md) (English; plans read-only, you approve, then it runs task by task), [saved commands](docs/specs/saved-commands.md) (`/revisar`, `/testes`…), the [Ctrl+P palette](docs/specs/command-palette.md) and [model switching on overload](docs/specs/retries.md).
- **Files and git:**
  - [per-run changes and undo](docs/specs/checkpoints.md), in private refs;
  - [Git panel](docs/specs/git-panel.md), with repository hooks off by default;
  - [isolated copy (worktree) per conversation](docs/specs/worktrees.md);
  - [per-project checks and blocks](docs/specs/project-hooks.md).
- **Tools:** [sandboxed terminal and local preview](docs/specs/terminal-preview.md), [per-project MCP catalog](docs/specs/mcp-catalog.md) (opt-in, fails closed), [scheduled automations](docs/specs/automations.md) (only while Adelic is open), [usage limits](docs/specs/spend-limits.md), [notifications](docs/specs/notifications.md) and [install as an app (PWA)](docs/specs/pwa.md).

Local checks (the same as CI on GitHub Actions, on every push to `develop` and on PRs):

```bash
npm run typecheck
npm run lint          # ESLint; `any` and hook dependencies show up as warnings
npm run format:check  # Prettier; `npm run format` fixes it
npm test
npm run build
npm run test:e2e      # Playwright; locally: PLAYWRIGHT_CHROMIUM=/usr/bin/chromium, or npx playwright install chromium
```

Some tests use the real bubblewrap and expect `rg` and `pactl` in `/usr/bin`. The commit that formatted the whole codebase is listed in `.git-blame-ignore-revs`; to make `git blame` skip it, use `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

The ai-memory integration tests (`tests/integration-ai-memory.test.ts`) start a real, isolated server with a temporary folder, a token and a random port. They run when there is a binary in `AI_MEMORY_BIN` or `ai-memory` on the PATH; otherwise they are skipped.

Release: `npm run release -- 0.5.0 --push` bumps the version, closes the CHANGELOG section, creates `docs/releases/v0.5.0.md`, commits and pushes the tag. The **Release** workflow tests, builds the AppImage and publishes the release with the AppImage, the checksum and `install-linux.sh`. Use `--dry-run` to check first.

Diagnostics: in Settings › Diagnostics, or at `GET /api/diagnostics`. The report includes versions, paths (with the home folder as `~`) and service status, without credentials or conversations.

The E2E tests (`tests/e2e/`) start the real backend and build with a simulated provider, in a temporary data folder, without touching ai-memory or the computer's CLIs.

Database: the schema is versioned in `PRAGMA user_version` (`server/migrations.ts`). Before applying a migration to a database with data, Adelic writes a copy to `<data folder>/backups/` (mode 0600, the five most recent). A database created by a newer version of Adelic is refused without changes. To restore a copy, close Adelic and replace `adelic.sqlite` with it, removing `adelic.sqlite-wal` and `adelic.sqlite-shm`.

Layout: `server/index.ts` assembles the app, and the routes live in `server/http/` (projects, conversations, settings and memory). On the front end, `src/App.tsx` holds state and composition, and screens and parts are in `src/components/`. Request bodies are validated with zod in `shared/schemas.ts`. Each screen sits inside an error boundary: a rendering error shows the message and lets you try again, without taking down the rest of the window.

The [requirements](docs/specs/requirements.md), [design](docs/specs/design.md) and [tasks](docs/specs/tasks.md) (in Portuguese) document this increment. The [baseline research](docs/baseline.md) (in Portuguese) compares the references and the next steps. See the [real tests and validation limits](docs/validation.md) (in Portuguese).

The delegation and context increment is specified in [orchestration and Graphify](docs/specs/orchestration.md) (in Portuguese). With orchestration on, the conversation's agent/model selector configures the coordinator; executor and reviewer have their own per-project options. Detailed outputs stay in the persisted tasks and are not loaded in full into the coordinator's context. Independent reads may run in parallel; runs with write permission are serialized per project.

The standalone chat flow and the dark theme are described in [conversations](docs/specs/conversations.md) (in Portuguese).

Activity polish and the thinking control are in [chat usability](docs/specs/chat-usability.md). Local tool availability on the fast path is in [fast local tools](docs/specs/fast-local-tools.md). The development checkout may produce local versions newer than the release available on GitHub. The footer layout is in [chat controls](docs/specs/composer-layout.md), the theme and interface patterns in [theme and interface](docs/specs/visual-theme.md), and the next tests through the app itself in [dogfooding](docs/dogfooding.md) (all in Portuguese).

`master` holds the stable version; `develop` receives the next increments. `vX.Y.Z` tags mark releases. v0.1.0 starts with both branches on the same commit.
