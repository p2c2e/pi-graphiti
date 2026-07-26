# Changelog

## 0.4.0

- **`/graph setup` interactive wizard.** New subcommand that captures your top-level `groupId` and project-scoping preference, then configures the backend: it can detect Docker, start the local FalkorDB + Graphiti MCP stack (`docker compose -p graphiti up -d`) and tail its logs, or point at an external MCP server URL. All Docker control shells out to the `docker` CLI directly (no bash), so it works on macOS, Linux, and WSL/Windows. Writes `~/.pi/agent/pi-graphiti-config.json` and warns when a `PI_GRAPHITI_*` env var would shadow a saved value; changes take effect after restarting pi. New config key `backendDir` (`PI_GRAPHITI_BACKEND_DIR`) records the backend directory holding `docker-compose-falkordb.yml`. Before offering to start the stack, the wizard first health-probes the target URL and skips the start when an MCP server already answers there (this stack, a foreign container, or a remote), avoiding a port-conflict race.
- **`/graph uninstall` (alias `teardown`) + best-effort `preuninstall`.** Tears down the local Docker stack (`docker compose -p graphiti down`, keeping the data volume) but ONLY if `/graph setup` actually started it, tracked via the new `startedBySetup` config marker; a pre-existing or externally started stack is left running with a message. Run it before `pi remove` (package removal only edits settings and runs no teardown hook). A dependency-free `preuninstall` npm script performs the same owned-only teardown for plain `npm uninstall`.

## 0.3.0

- **Merit-based save criterion (self-contained).** The policy block and `graph` tool guidance now tell the agent to judge each input on its OWN merit - save to the graph when the content carries relational or temporal signal (entities/relationships, changes over time), independent of whatever other memory tools exist. This replaces the earlier presence-dependent "coexists with flat memory / save to BOTH" wording, which was wrong for a standalone pi-graphiti install (no `memory` tool to route to) and coupled the decision to another extension. Narrowing graph's trigger to genuinely relational/temporal content also removes the winner-take-all overlap with a flat-memory tool without either one having to know about the other.
- **Proactive in-turn saving.** The system-prompt policy block now gives the main agent an explicit imperative "WHEN TO SAVE (proactively, do NOT wait to be asked)" trigger list (corrections, preferences, durable facts/decisions, environment/convention discoveries, end of significant work) plus per-save scope guidance. Previously the block was purely descriptive, so the agent almost never called `graph add` unless explicitly told to. This restores autonomous saving during normal turns rather than only on the background nudge or explicit `graph`/`/graph` invocation.
- **Correction detector (`correctionDetection`, on by default).** Detects user corrections in real time (two-pass strong/weak/negative pattern filter ported from pi-hermes-memory) and fires an *immediate* curation review instead of waiting for the next `nudgeInterval`. Rate-limited to one review per 3 turns and gated on graphiti reachability. Disable with `correctionDetection: false` or `PI_GRAPHITI_CORRECTION_DETECTION=0`.
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
