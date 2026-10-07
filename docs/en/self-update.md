# Updating Adelic

> Translated from the Portuguese original: [docs/specs/self-update.md](../specs/self-update.md).

The **Update Adelic** card in Settings › Diagnostics never updates on its own, and refuses rather than risk your work. Nothing changes without a click and a confirmation; there are no background updates.

## Install types

The install type is detected at runtime (`detectInstall` in `server/self-update.ts`):

- **Git checkout** (`npm start` / `npm run dev`): the process folder is the root (`git rev-parse --show-toplevel`) of a repository whose `package.json` is named `adelic`.
- **AppImage**: the backend runs inside Electron and `$APPIMAGE` is set.
- **Other** (a copied build, desktop outside an AppImage): shows the version and the release link, without an update button.

The card shows the version, commit (checkout), install type, **Check for updates** and, when possible, **Update now**. Checking uses the network only when "Check for new versions" is on or when you click.

## Git checkout

**Update channel** (`Settings.updateChannel`): `master` (stable, the default) or `develop` (preview).

Check: `git fetch origin <channel>` and a comparison of `HEAD` with `origin/<channel>`: commits behind (count and the last 10 subjects), commits ahead, whether the tree is clean and whether `package-lock.json` changes.

Updating only fast-forwards the branch (`git merge --ff-only`). It refuses, with the reason, when there are:

- changes to tracked files (untracked files do not block);
- local commits ahead, or a diverged branch;
- HEAD on another branch: it offers to **switch to the channel** only with a clean tree, a local branch tracking `origin/<channel>`, and when that is also a fast-forward;
- clean/smudge filters in the repository configuration;
- any run, queue, running plan, undo, Git panel operation, worktree or project check in progress. During the update, new runs and git operations get 409.

Steps: fetch → (branch switch) → merge → `npm ci --no-audit --no-fund` if the lockfile changed → build into a separate `.adelic/update-build-…` folder (10 min limit each) → swap the `dist` folder by rename → restart. The `dist` in use is only replaced after a successful build. Any failure before that moves HEAD (and the branch, if it was switched) back to the starting commit with `git reset --hard`; this is safe because the tree was clean at the start. If the lockfile changed, `npm ci` runs again on the previous version. The server keeps running the old code.

Git runs through the hardened runner also used by checkpoints: `execFile` without a shell, timeouts, no terminal prompts, inherited `GIT_*` variables dropped, hooks and fsmonitor off, no submodule recursion. The fetch also blocks the `ext::` and `git://` transports, ignores the repository's askpass and credential helpers, and uses SSH in `BatchMode`. npm runs with your environment (minus the parent `npm start` variables), since it is the project's own build.

## AppImage

Check: GitHub `releases/latest`, ignoring drafts and pre-releases. Update:

1. downloads `Adelic-<v>-linux-x86_64.AppImage.sha256` and the AppImage, only from `https://github.com/ikaromm/Adelic/releases/download/…`, following https redirects only to `github.com`, `objects.githubusercontent.com` or `release-assets.githubusercontent.com`; 500 MB limit, written to a temporary file in the same folder as `$APPIMAGE`;
2. checks the SHA-256 against the release's `.sha256` and the ELF signature at the start of the file;
3. `chmod 755`, keeps the current file as `Adelic.AppImage.previous` (hard link, or copy) and swaps the file by atomic rename;
4. restarts.

If `$APPIMAGE` or its folder is not writable, the card explains it and points to the release page.

**What is verified:** the SHA-256 comes from the same release, so it protects against a corrupted or truncated download, not against a compromised release. The provenance attestation (`gh attestation verify`) is not checked here; for that, download from the release page and verify it manually.

## Restart

- **Checkout**: the server starts a detached copy of itself with the same command, environment and folder. The copy retries opening the data-folder lock and the ports for up to 30 s while they are still in use. The old process shuts down normally and exits. The new process's output goes to `<data folder>/self-update.log`.
- **AppImage**: the backend tells the main Electron process, which stops the backend as in a normal close and relaunches the AppImage.

The interface shows the steps and the output (last 64 KB). When it reaches "Restarting…", it polls until the new server answers and reloads the page.

## Access

Only requests made on this computer (loopback) can check or apply updates; over remote access every update route answers 403. The confirmation pins the commit or version shown to you; if it changed in the meantime, the update is refused.

## Limits

- A failure after the build (during restart) does not undo the update: the card asks you to restart by hand.
- If `npm ci` fails while restoring the previous version, it is recorded in the output; run `npm ci` manually.
- In a normal start (without the restart wait), a busy port fails immediately.
