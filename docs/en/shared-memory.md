# Shared local memory

> Translated and condensed from the Portuguese original: [docs/specs/shared-memory.md](../specs/shared-memory.md). The original also covers the internal API contract, the work split and the validation log.

## Goal

The **Memory** page exposes, inside Adelic, the existing ai-memory knowledge base used by T3/Codex and other clients. It is the same source: no notes are copied into Adelic's SQLite database or into versioned files. The page works without a code project selected. Personal and repository scopes stay separate, and browsing the library changes neither the scope nor the automatic context of conversations.

## Source and compatibility

The library uses only the ai-memory service, never its files. So it works the same with the service installed on the computer or in Docker, where the SQLite database and Markdown live in the `ai-memory-data` volume (`/data` inside the container) and are not accessible to Adelic's user.

- **Address:** `ADELIC_MEMORY_URL`, default `http://127.0.0.1:49374`. Loopback only (`127.0.0.1`, `localhost`, `::1`), with no credentials, query or fragment in the URL.
- **Token:** when the service uses `AI_MEMORY_AUTH_TOKEN` (common in Docker), give the same value in `ADELIC_MEMORY_TOKEN` or in a file named by `ADELIC_MEMORY_TOKEN_FILE`. If neither is set, `AI_MEMORY_AUTH_TOKEN` from the environment is used. Adelic reads `ADELIC_MEMORY_TOKEN` at startup and removes it from the environment so agents do not inherit it. The token is sent as `Authorization: Bearer` on every call and never appears in logs or responses.
- **Service features used**, checked against ai-memory 2.1.0 and 2.5.2 (CI runs the integration tests against both):
  - MCP `/mcp`: `memory_query` (search restricted to one workspace/project), `memory_read_page` (body and frontmatter) and `memory_write_page` (creation).
  - The read-only `/api/v1` API: lists scopes and counts, lists the current notes of a scope, and checks whether a path exists. This API requires `serve --enable-web`; the official Docker image already uses that option.
  - `POST /admin/write-page`: rewrites existing notes.
- Pagination (50 per page, up to 100) is done in Adelic over the service's list. Counts are the service's: current notes; notes with an expired TTL remain until the next sweep.
- **Errors never become an empty catalog.** The cases handled are: service unavailable (with the address), missing or wrong token (points to `ADELIC_MEMORY_TOKEN`), missing API (points to `--enable-web`), unknown scope, incompatible response, and an empty catalog while the service reports current notes.

The automatic memory search in chat stays separate: it uses the workspace/project of the linked project, and the library does not change that scope.

## Interface

- Catalog, workspace and project are independent of the code project. The preferred personal scope is selected first when available, otherwise the first one; the scope name is remembered in the browser.
- Existing notes appear on open, without a required search: count, search, pagination, refresh, new note, edit, save/cancel.
- While the page is visible, it refreshes about every 5 seconds (never in the chat or a hidden tab), updating the list, catalog and the open note when it is not being edited.
- Drafts are protected when switching note or scope, leaving the page, cancelling or detecting an external change. Polling never replaces a draft; if the note changed elsewhere, you are offered a reload after explicit confirmation, and saving is blocked until the conflict is resolved. A failure shows an error and keeps the draft.

## Editing existing notes

Edits go through the service itself, which updates the index, creates its Git checkpoint and runs its admission hooks.

None of the service's writers accepts arbitrary frontmatter: they rebuild metadata from a fixed set of fields (`title`, `kind`, `tier`, `tags`, `pinned`, `expires_at`, depending on the writer). So Adelic only allows editing when one of the writers reproduces every field of the note exactly:

- Without `expires_at`, it uses `/admin/write-page`. With `expires_at` and without `kind`, it uses `memory_write_page`.
- Editing is blocked before writing, with an explanation on screen, when the note has fields no writer preserves, a `type` different from the derived one, `kind` together with `expires_at`, `tags: []`, `pinned: false`, an unknown tier, or `stale_after` different from `expires_at`.
- Conflicts are detected by version: a hash of the body and the whole frontmatter, checked at the start and again right before writing. Adelic serializes its own saves per scope/path, and a stale version is rejected while keeping your draft.
- After writing, the note is read back through MCP. The body must match what was sent; the service's secret filter may change it, and in that case Adelic reports an error. The frontmatter must match too, except for fields the service refreshes (`generated.at`, and `last_modified_by` with user authentication).
- New notes are created with `memory_write_page`. A path that already exists in the service is never overwritten silently.

## Limits

The service offers no compare-and-swap across processes. An external change between the last check and the write can still be overwritten; the window is small, but it exists. Notes with custom metadata written by other clients are read-only in Adelic until there is a writer that preserves the full frontmatter. Proposed fixes are in [proposals to ai-memory](../specs/ai-memory-proposals.md) (in Portuguese).
