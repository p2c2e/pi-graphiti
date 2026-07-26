# pi-graphiti

🕸️ Persistent knowledge-graph extension for [Pi](https://github.com/earendil-works/pi-coding-agent), backed by a [Graphiti](https://github.com/getzep/graphiti) MCP server.

## What it gives you

The Graphiti MCP server is just an MCP — if you `pi mcp add` it, the LLM gets `add_memory`, `search_nodes`, etc. as raw tools. This extension wraps that surface to give you behavior an MCP cannot provide:

- **`graph` tool** — single pi-native tool with three actions (`add` / `search` / `episodes`) so you don't need pi-mcp-adapter to use graphiti.
- **Automatic episode writes** — pushes a snapshot every N user turns, before context compaction, and on session shutdown. No need for the model to remember to write.
- **LLM curation pass (on by default)** — the turn-based nudge spawns a short-lived child `pi -p` (loading only this extension, so it just has the `graph` tool) that reviews the recent conversation and decides *what* is worth persisting and at *which scope* (project vs global), then calls `graph add` itself — or says "Nothing to save." Set `reviewEnabled: false` to fall back to raw snapshot pushes (all project scope) that rely purely on graphiti's server-side extraction.
- **Proactive in-turn saving** — the system-prompt policy tells the agent *when* to persist proactively (corrections, preferences, durable facts/decisions, conventions, end of significant work), so it saves during normal turns instead of only on the background nudge.
- **Correction detector (on by default)** — a user correcting the agent fires an *immediate* curation review, capturing the highest-signal "you should have remembered that" moment right away. Set `correctionDetection: false` to disable.
- **System-prompt policy block** — every session starts knowing the graph exists and when to use it.
- **Optional ambient recall** — opt-in injection of relevant entities/facts at session start, keyed on the latest user message.
- **Project/global scoping (on by default)** — split of graph memory into a per-project group and a shared global group, so project-specific facts and cross-project knowledge stay separated. Set `projectScoping: false` to collapse to a single bucket.
- **`/graph` slash command** — status, search, ingest, dump, load, clear directly from the prompt.

## Requirements

A running Graphiti MCP server (FalkorDB or Neo4j backend). Stand one up by following [Graphiti's docs](https://help.getzep.com/graphiti), or run `/graph setup` after installing to provision and start a local Docker stack for you.

Default URL the extension expects: `http://localhost:8000/mcp/` (Graphiti's default HTTP endpoint).

## Install

```bash
# from npm (once published)
pi install npm:pi-graphiti

# or pinned from git
pi install git:github.com/p2c2e/pi-graphiti@v0.4.0
```

## Configure

Configuration is optional — defaults work against a local graphiti server.

**Config file:** `~/.pi/agent/pi-graphiti-config.json`

```json
{
  "enabled": true,
  "url": "http://localhost:8000/mcp/",
  "groupId": "",
  "injectContext": false,
  "projectScoping": true,
  "nudgeInterval": 10,
  "flushOnCompact": true,
  "flushOnShutdown": true,
  "flushMinTurns": 6
}
```

**Environment overrides** (take precedence over the JSON file):

| Variable                        | Default                       | Notes |
| ------------------------------- | ----------------------------- | ----- |
| `PI_GRAPHITI_ENABLED`           | `true`                        | Set to `false` to disable without uninstalling. |
| `PI_GRAPHITI_URL`               | `http://localhost:8000/mcp/`  | MCP endpoint. |
| `PI_GRAPHITI_GROUP_ID`          | `pigraphiti<user><host>`      | Sanitized to `[A-Za-z0-9_]+` — hyphens corrupt RediSearch queries. |
| `PI_GRAPHITI_INJECT_CONTEXT`    | `false`                       | Inject recall block at session start. |
| `PI_GRAPHITI_PROJECT_SCOPING`   | `true`                        | Split memory into per-project (`<groupId>_proj_<project>`) + global groups. Set `false` for a single bucket. |
| `PI_GRAPHITI_NUDGE_INTERVAL`    | `10`                          | User turns between background pushes. |
| `PI_GRAPHITI_REVIEW_ENABLED`    | `true`                        | Nudge runs an LLM curation pass (child `pi -p`) that picks facts + scope. `false` = raw snapshot push. |
| `PI_GRAPHITI_CORRECTION_DETECTION` | `true`                     | Detect user corrections in real time and fire an immediate curation review (rate-limited, reachability-gated). |
| `PI_GRAPHITI_REVIEW_RECENT`     | `0`                           | Recent messages fed to the curation review. `0` = all. |
| `PI_GRAPHITI_LLM_MODEL`         | (default model)               | Model override for the review subprocess (e.g. a cheap/fast model). |
| `PI_GRAPHITI_LLM_THINKING`      | (`off` when model set)        | Thinking level for the review subprocess. |
| `PI_GRAPHITI_FLUSH_ON_COMPACT`  | `true`                        | Push snapshot before compaction. |
| `PI_GRAPHITI_FLUSH_ON_SHUTDOWN` | `true`                        | Push snapshot on shutdown. |
| `PI_GRAPHITI_FLUSH_MIN_TURNS`   | `6`                           | Minimum user turns before flush triggers. |
| `PI_GRAPHITI_TIMEOUT_MS`        | `60000`                       | Per-tool-call timeout. |

## Usage

The `graph` tool is exposed to the LLM automatically. From the user side:

```
/graph                       Status + recent episodes + active group
/graph setup                 Interactive wizard: set group id + project scoping, and configure/start the backend (local Docker stack or external MCP server)
/graph search QUERY          search_nodes + search_memory_facts
/graph dump [path]           Export ALL episodes (every group) to markdown; use before reverting to flat files
/graph load <path>           Re-import episodes from a dump file back into their original group ids
/graph ingest <path> [global] Memorize a text file: chunk it and push the chunks as episodes into the current project's graph memory (or the global group with "global")
/graph clear                 clear_graph for the active group (destructive)
/graph uninstall             Tear down the local Docker stack, but ONLY if /graph setup started it; run before `pi remove`
```

> **Uninstalling:** run `/graph uninstall` (alias `/graph teardown`) *before* `pi remove`. It stops the local Docker stack only when the setup wizard started it (config `startedBySetup`); a pre-existing or external stack is left running with a message. `pi remove` itself only edits settings and cannot run teardown. A best-effort `preuninstall` npm script does the same cleanup for plain `npm uninstall`.

### Scope (when `projectScoping` is enabled)

The `graph` tool accepts a `scope` argument:

- `add` / `episodes`: `"project"` (default) or `"global"`.
- `search`: `"both"` (default, unions project + global), `"project"`, or `"global"`.

The per-project group id is derived as `<groupId>_proj_<sanitizedProjectName>`, where the project name is the current working directory's basename. With scoping disabled (`projectScoping: false`), every operation uses the single `groupId` bucket and `scope` is ignored.

### Ingesting a document from the CLI

To load an arbitrary text file (notes, docs, transcripts) into graphiti episode memory outside of a pi session, use the ingest script:

```
npm run ingest -- <file> [options]
# or: npx tsx scripts/ingest-file.ts <file> [options]
```

Options:

- `--group <id>` target group_id (sanitized to `[A-Za-z0-9_]`).
- `--name <base>` episode base name (default: file basename).
- `--source <kind>` `text` | `message` | `json` (default: `text`).
- `--chunk-chars <n>` per-episode safety cap (default: 8000; `0` = whole file as one episode). Chunking is paragraph-driven: each paragraph is its own episode, and a paragraph larger than the cap is split into sentences packed up to the cap (hard-cut only if a single sentence still exceeds it).
- `--dry-run` show the chunk plan without writing.

Group precedence: `--group` > `PI_GRAPHITI_GROUP_ID` > default. The document is written to that one explicit group (project scoping does not remap it), so you can drop a file into a specific bucket:

```
PI_GRAPHITI_GROUP_ID=myscratch npx tsx scripts/ingest-file.ts notes.md --chunk-chars 6000
```

Episodes extract asynchronously; allow ~30-90s before the entities/facts are searchable.

## Coexistence with other memory extensions

This extension is self-contained and stores everything in its own graphiti group IDs, so it can run alongside other memory extensions without conflict.

- It registers its own `graph` tool, so the LLM picks it based on tool descriptions.
- Its `before_agent_start` hook appends its own block to the system prompt — Pi composes multiple such blocks safely.
- It uses its own group IDs / storage, so there are no double-writes.
- To share a graph across machines/installs, set `PI_GRAPHITI_GROUP_ID` to the same value.

## Design notes

- **Direct HTTP MCP client** (no `pi mcp` dependency). Lets us own timeouts, retries, and silent degradation.
- **Group IDs are sanitized** to `[A-Za-z0-9_]+` because FalkorDB/RediSearch treats `-` as a `NOT` operator and silently corrupts queries.
- **Async extraction** — `add_memory` queues entity/fact extraction server-side. A just-added episode may not be searchable for tens of seconds.
- **Fail-quiet** — if the graphiti server is unreachable, all writes/reads degrade silently. The extension is an accelerator, never a blocker.

## License

MIT
