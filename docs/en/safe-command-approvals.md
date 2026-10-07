# Safe command approvals

> Translated and condensed from the Portuguese original: [docs/specs/safe-command-approvals.md](../specs/safe-command-approvals.md). This page covers the behavior at a high level; the original lists every rule.

Adelic approves common read-only commands automatically and asks you about anything destructive, sensitive or ambiguous. Classification is deterministic and local: there is no extra model call, and the command text is parsed, never executed, to analyze it.

## Modes

Choose the mode in Settings › Execution permissions, or in the permissions selector of the message field:

- **Safe automatic approval** (`auto-safe`, the default): recognized reads are approved; everything else waits for you.
- **Confirm requests** (`manual`): every request the runtime sends is shown for you to approve or deny.

There is no unrestricted mode. The mode never changes the sandbox you chose (read only or write in the project). Over the internet (Tailscale Funnel), runs are forced to manual approval by default; see [remote access](remote-access.md).

## What is approved automatically

A command is approved only when every part of it is recognized:

- **Simple scripts:** commands joined with `;`, `&&`, `||` and pipes `|` (up to 12 commands, 4,000 characters), each one checked on its own. The only redirections accepted are `2>/dev/null`, `>/dev/null` and `2>&1`.
- **Reads and diagnostics:** `pwd`, `ls`, `tree`, `cat`/`head`/`tail`, `wc`, `sort`, `uniq`, `cut`, `stat`, `du`, `find` (search options only, never `-exec`/`-delete`), `grep`, `sed -n` with line ranges, `rg --no-config`, `jq` with a literal filter, `uname`/`id`/`whoami`/`uptime`/`free`/`df`, known audio queries (`pactl`, `wpctl`) and `--version` of common tools.
- **Read-only git:** `status`, `log`, `show`, `diff`, `branch`/`tag --list`, `describe`, `rev-parse`, `ls-files`, `remote -v`, `blame` and `config --get` of non-sensitive keys, but only when no git configuration layer the command reads can run a program (fsmonitor, pager, external diff, textconv, filters, includes, submodules and similar ask instead).
- **The Graphify query Adelic suggests:** only the exact `graphify query … --graph … --budget …` form, pointing at Adelic's own binary and at this project's graph.

Paths must stay inside the project: no `..`, absolute or hidden paths outside known files (such as `.gitignore`), and no secret-looking names. Recursive searches walk the tree first and ask if they find secrets or unexcluded hidden entries.

## What always asks

- Writing or removing files (`rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `ln`, `tee`, `dd`…) and redirection to a file.
- Mutating git (`reset`, `clean`, `push`, commits…), `sudo`, package installs, publishing and system changes.
- Network access (`curl`, `wget`), `xargs`, `env`/`printenv`, secrets (`.env`, keys, cookies, auth dotfiles) and paths or links that escape the project.
- Tests, builds and interpreters (`npm`, `npx`, `node`, `python` with a script): they can run project code and hooks.
- Command substitution, variables, globs, heredocs, background jobs, unknown commands, and anything the parser does not fully understand.

Commands matching a project's blocked patterns (for example `git push*`) are denied without asking, even in automatic mode.

## Per agent

- **Codex:** runs with the `untrusted` approval policy, and the runtime's own reviewer is disabled so approvals belong to the interface. An automatic answer accepts only that one request, never "for the session". If Codex `.rules` files exist that Adelic cannot verify, the run fails before any tool executes rather than falling back to a more permissive policy.
- **Kiro:** shell commands in the exact format Kiro 2.23 sends are classified with the same rules and, when safe, answered with the offered `allow_once`. File writes and other tools still ask. Adelic never picks `allow_always` and never enables trust-all. If Kiro uses a non-bash shell or a shell override, everything stays manual.
- **Claude Code:** offers no remote approval protocol, so Adelic keeps its restrictions and says so in the interface.
- **OpenCode:** discovery only.

## Limits

The policy classifies the requests the runtime sends. It does not intercept every effect: natively trusted reads, and changes or deletions through patches, can happen without a callback, and an approved script can modify or delete files. The real barrier is the sandbox: Codex, Kiro and Claude use bubblewrap to limit writes; for Codex, `/` is read-only and only the project (as configured) and a private scratch folder are writable, and without bubblewrap it runs no tools at all. Bubblewrap limits writes, but cannot tell an edit from a deletion inside a writable folder. Human approval never widens those mounts, and the sandbox does not isolate the network.
