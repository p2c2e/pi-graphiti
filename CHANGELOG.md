# Changelog

## Unreleased

- **LLM curation pass for auto-writes (`reviewEnabled`, on by default).** The turn-based nudge now spawns a short-lived child `pi -p` that loads only this extension (so it has just the `graph` tool), reviews the recent conversation, and decides *what* to persist and at *which scope* (project vs global) by calling `graph add` itself — or replies "Nothing to save." When `reviewEnabled: false`, the nudge falls back to the previous raw-snapshot push (all project scope). New config: `reviewEnabled`, `reviewRecentMessages`, `llmModelOverride`, `llmThinkingOverride` (+ `PI_GRAPHITI_REVIEW_ENABLED`, `PI_GRAPHITI_REVIEW_RECENT`, `PI_GRAPHITI_LLM_MODEL`, `PI_GRAPHITI_LLM_THINKING`). Compact/shutdown flushes remain raw-snapshot safety nets. Verified end-to-end: a synthetic review correctly routed identity/preference facts to the global group and repo-specific facts to the project group in FalkorDB.
- Skip searches whose query has no RediSearch-searchable term (stopword-only, single-stopword, or punctuation-only queries). Such queries are tokenized to empty by FalkorDB, after which graphiti-core emits an invalid `(@group_id:"...") ()` clause and the server throws `RediSearch: Syntax error at offset 34`. `searchNodes`/`searchFacts` now guard via `hasSearchableTerms()` and degrade to zero results instead of hitting the server (also avoids a wasted embeddings call). Most visible with `injectContext: true` when the first user message was short/stopword-heavy.
- **Project scoping now ON by default** (`projectScoping: true`): graph memory splits into a per-project group + shared global group out of the box. Set `projectScoping: false` (or `PI_GRAPHITI_PROJECT_SCOPING=0`) for the old single-bucket behavior.
- FalkorDB single-`group_id` read padding (workaround for graphiti #1161): search/clear never send a 1-element `group_ids` array — padded with a distinct empty sentinel group to force graphiti's multi-group code path. Logical/display group ids stay unpadded. Harmless (no doubled hits) on server versions that don't exhibit the bug.
- `npm run test:scope` unit test (stubbed client) + `scripts/smoke.sh` headless end-to-end check; `npm test` runs check + scope test + smoke.
- `sandbox.sh` / `sandbox-scoped.sh` use `PI_GRAPHITI_CONFIG` to isolate graph config + group id without overriding `HOME` (preserves your model/auth config).

## 0.2.0 — project scoping, dump, search compaction

- Optional project/global scoping (`projectScoping`, default off): per-project group id `<groupId>_proj_<project>` + shared global group, derived from the cwd basename
- `graph` tool gains a `scope` argument (`project` / `global` / `both`)
- Search results are compacted before returning to the model: UUIDs moved to `details`, facts collapsed to strings, entity-summary sentences deduped against facts
- `/graph dump [path]` exports ALL episodes across every group to markdown (faithful export for reverting to flat-file memory)
- `agentRoot()` honors `PI_CODING_AGENT_DIR` for the default dump location
- MCP client identifies as `pi-graphiti`

## 0.1.0 — initial release

- `graph` tool with `add` / `search` / `episodes` actions
- `/graph` slash command (status, search, clear)
- Background sync: pushes a session snapshot every N user turns, before context compaction, and on shutdown
- Optional ambient recall block at session start (`PI_GRAPHITI_INJECT_CONTEXT=1`)
- Config via `~/.pi/agent/pi-graphiti-config.json` or `PI_GRAPHITI_*` env vars
- Group-id sanitization to `[A-Za-z0-9_]+` to avoid RediSearch operator collisions
