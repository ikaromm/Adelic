# Plan mode: plan, approve, run

> Translated from the Portuguese original: [docs/specs/plan-mode.md](../specs/plan-mode.md).

Like Kiro Specs, the agent first writes a plan (requirements, design and tasks), you review and approve it, and only then does execution start, one task at a time.

## When it plans

Always by your choice, never automatically. Ordinary questions stay on the fast path, with no extra model call.

- **Plan first** (button in the message field, next to project and mode): while on, every message in the conversation produces a plan. The setting is saved with the conversation.
- **`/plano <request>`**: only this message produces a plan. The prefix is recognized on the server; `/plano` without a request is rejected.

## The planning run is read-only

Regardless of settings, the planning run gets a `read-only` sandbox, writes no checkpoint and does not reserve the project for writing. File-change requests are denied immediately, without asking you, and show in the activity as a denied change because planning is read-only. Read commands and tools follow the usual approval policy. It is a direct call to the conversation's agent, even with orchestration on: the plan already is the division of the work.

The prompt asks for Markdown with a requirements section (a numbered, testable list), a design section (approach and files) and a tasks section (a `- [ ] …` checklist, each item small and verifiable). The prompt is written in Portuguese.

## How the plan is read

- Sections are recognized by heading name at any level (`## Requisitos`, `### 2. Design`, `**Tarefas**`, `Tarefas:`, and English names such as Requirements and Tasks), ignoring accents. Headings inside code blocks are ignored, and a ` ```markdown ` fence around the whole answer is removed.
- Tasks are the top-level items of the list under Tasks (with or without a checkbox); nested lists and indented lines become the task's details. Up to 50 tasks of up to 500 characters.
- With no sections at all, the whole text becomes the design and only `- [ ]` items count as tasks. With no tasks, the card asks you to edit the plan, and approving is refused.
- Editing the Markdown and saving re-reads the plan. Tasks with the same text keep their id, status and run.

## Plan card

It replaces the answer of the planning run: title, status, progress ("1 of 2 tasks done"), collapsible Requirements and Design, and the task list with each task's status, updated live. Buttons: **Approve and run**, **Run only the next task**, **Discard**, edit (pencil), skip / restore a task, **Stop after the current task** while running, and **Save to project** once approved.

## Execution: one task per run

Approving starts a normal run for the first pending (or failed) task: it respects the configured sandbox, approvals and checkpoints, so each task has its own "Changed N files" and its own undo. Your message shows "Plan task 1/2: …"; the prompt carries the approved plan with the updated checklist and asks for the current task only.

- A task is **done** only when its run finishes successfully.
- **Failure**: the task is marked failed with the reason, and the plan stops. Approving again retries that task; skipping moves on to the next.
- **Cancelling** the run: the task goes back to pending and the plan stops.
- **Stop after the current task**: the running task finishes; no other starts.
- With "all", when a task finishes the next one starts on its own; queued messages wait for the plan to end.
- Restarting Adelic: running tasks go back to pending and the plan stays approved, waiting for you.

## Saving to the project

Only when you click, and only in a conversation linked to a project. The plan is written to `<project>/.adelic/specs/<slug>.md`. The path is resolved with `realpath`; if `.adelic/specs` or the file is a symbolic link (or points outside the project), nothing is written. An existing file is never replaced silently: the card asks before **Replace**. `.adelic/` is in this repository's `.gitignore`, but not necessarily in your project's.

## Limits

- Automatic denial applies to requests marked as file changes; the real isolation is the runtime's read-only sandbox (Adelic's bubblewrap and each agent's sandbox policy). Agents without tools plan from the request alone.
- The plan cannot be edited while it runs; edit it after stopping.
- Message attachments go to the planning run, not to the tasks.
