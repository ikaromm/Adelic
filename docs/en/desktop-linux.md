# Linux desktop

> Translated from the Portuguese original: [docs/desktop-linux.md](../desktop-linux.md).

The initial package is **Linux x86_64**, as an AppImage. Electron 44.5.1 bundles Node 24.21.0 and SQLite; the backend runs in a utility process and picks a free port on `127.0.0.1`. The window uses the same dark interface as the web mode. Packages are distributed through the [GitHub releases](https://github.com/ikaromm/Adelic/releases); the app does not update itself on its own; **Settings › Diagnostics › Update Adelic** downloads the new release, checks the SHA-256 and restarts when you ask ([updating Adelic](self-update.md)).

## Open and install

The v0.2.0 package uses `Adelic-0.2.0-linux-x86_64.AppImage`, as in the examples below. Local builds use the version from `package.json` in the file name, under `release/`; replace the name with the artifact you built. To take it to another computer, copy the AppImage and the matching `.sha256`:

```bash
cd /folder/with/package
sha256sum -c Adelic-0.2.0-linux-x86_64.AppImage.sha256
chmod +x Adelic-0.2.0-linux-x86_64.AppImage
./Adelic-0.2.0-linux-x86_64.AppImage
```

If AppImage mounting is not available, use `./Adelic-0.2.0-linux-x86_64.AppImage --appimage-extract-and-run`. The build uses the static runtime from toolset 1.0.3, following the [electron-builder AppImage documentation](https://www.electron.build/v26/docs/appimage/).

The installer is optional and can take the file explicitly:

```bash
./scripts/install-linux.sh /folder/with/package/Adelic-0.2.0-linux-x86_64.AppImage
```

When you download only the release assets, keep the AppImage and checksum in the same folder and run the downloaded installer:

```bash
bash install-linux.sh ./Adelic-0.2.0-linux-x86_64.AppImage
```

Without an argument, it looks for a single AppImage built in `release/`. It copies the app to `~/.local/share/adelic-desktop/Adelic.AppImage` and creates `~/.local/bin/adelic` and `~/.local/share/applications/io.adelic.desktop.desktop`. It uses extract-on-launch so FUSE mounting is not needed. It honors `XDG_DATA_HOME` and `ADELIC_BIN_DIR` for the installed files. If another `adelic` command already exists, it refuses to overwrite it. If the installer is missing the repository icon, the menu uses a generic one. Running it again updates the binary and the menu entry.

## Data and agents

The app keeps `~/.local/share/adelic/adelic.sqlite`, standalone conversations and existing indexes. `ADELIC_DATA_DIR` selects another database, including for tests. Chromium profile data lives in `<dataDir>/.desktop-profile`. The binary is installed in a folder separate from the database.

Close the web mode before opening the desktop app on the same database. A second desktop window hands focus to the first. A Linux lock on the folder's real path prevents another backend from opening the SQLite file; the lock goes away if the process dies. Closing the desktop app stops the server, agent runs and Graphify operations.

Install and sign in to the agents with their official CLIs. Adelic finds direct mise installs, common local paths and the PATH, without running shell configuration. Optional overrides point to executable files:

```bash
ADELIC_CODEX_BIN=/path/to/codex ./Adelic-0.2.0-linux-x86_64.AppImage
# Also: ADELIC_CLAUDE_BIN, ADELIC_KIRO_BIN and ADELIC_OPENCODE_BIN
```

An invalid override leaves the provider unavailable and reports a configuration error. Settings shows real availability and authentication. The package does not include CLIs, credentials or subscriptions. A CLI installed through npm may need its own external Node; that is not needed to open Adelic. The PATH of a graphical launch includes the usual Node version-manager locations.

Codex, Kiro and Claude depend on bubblewrap for the implemented isolation modes. Graphify and ai-memory are optional and remain external; the app shows when they are missing. OpenCode stays discovery-only, without execution, in this version. Access over Tailscale is not enabled in this local stage.

The isolated Codex profile uses a private operational CODEX_HOME and read-only access to the existing authentication file. Renewal/sign-in must be done with the official CLI outside Adelic. Native MCPs active in the effective configuration and local rules that cannot be verified prevent this profile from running; there is no fallback with more permissions. The memory and Graphify integrated into Adelic remain available. Approval limits, including native changes without a callback and commands inside approved scripts, are described in the [command policy](safe-command-approvals.md).

## Build and validate

```bash
npm ci
npm run typecheck
npm test
npm run package:linux
npm run desktop:smoke
```

The build requires Node >=22.13, npm, Linux x86_64 and internet access to download Electron and tools on the first run. `npm run desktop:dev` opens the desktop app without an AppImage. `npm run dev` and `npm start` keep the web mode on 4317.

The smoke test requires an X11/Wayland graphical session. It uses temporary data and an initial PATH of `/usr/bin:/bin`, runs the package outside the repository, creates a conversation, checks the second instance, stops with SIGTERM and reopens to validate DOM/API/SQLite and that history was preserved. It does not require signing in to any agent. The result is written to `.desktop/validation/smoke.json`.

`ADELIC_DESKTOP_REPORT=/path/to/report.json` enables a diagnostic report with the local address, PIDs and Node version. `ADELIC_DESKTOP_SMOKE=1` checks the window, API and SQLite, then exits automatically. The report contains no messages or credentials.

The AppImage still depends on the system's desktop libraries: glibc, GTK3, NSS, ALSA, X11/Wayland libraries and Electron-compatible graphics. It is not a binary for Alpine/musl. The Chromium sandbox must stay enabled; system restrictions on user namespaces need to be resolved in the distribution. The [Electron security documentation](https://www.electronjs.org/docs/latest/tutorial/security) underpins the renderer isolation.

Verified compatibility (x86_64):

- Arch/Omarchy with Wayland: real use.
- Ubuntu 24.04, Ubuntu 22.04, Debian 12 and Fedora 42: headless graphical smoke test in CI (X11 via xvfb), covering the window, API, SQLite, second instance, shutdown and reopening.

On Ubuntu 24.04 or newer and Debian 13 or newer, the AppArmor policy that restricts user namespaces needs to be relaxed for bubblewrap. Other distributions and architectures have not been tested. Evidence and limitations are in [validation.md](../validation.md) (in Portuguese), and the contracts in the [desktop-linux.md spec](../specs/desktop-linux.md) (in Portuguese).
