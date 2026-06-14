# pi-graphiti

🕸️ Persistent knowledge-graph extension for [Pi](https://github.com/earendil-works/pi-coding-agent), backed by a [Graphiti](https://github.com/getzep/graphiti) MCP server.

> **Independent of `pi-hermes-memory`.** Install whichever one (or both) matches your workflow. They do not share storage.

## What it gives you

The Graphiti MCP server is just an MCP — if you `pi mcp add` it, the LLM gets `add_memory`, `search_nodes`, etc. as raw tools. This extension wraps that surface to give you behavior an MCP cannot provide:

- **`graph` tool** — single pi-native tool with three actions (`add` / `search` / `episodes`) so you don't need pi-mcp-adapter to use graphiti.
- **Automatic episode writes** — pushes a snapshot every N user turns, before context compaction, and on session shutdown. No need for the model to remember to write.
- **System-prompt policy block** — every session starts knowing the graph exists and when to use it.
- **Optional ambient recall** — opt-in injection of relevant entities/facts at session start, keyed on the latest user message.
- **`/graph` slash command** — status, search, clear directly from the prompt.

## Requirements

A running Graphiti MCP server. For a fully-local stack (FalkorDB + Ollama, no cloud LLM), see the [`graphiti-mcp-local-stack`](../) skill in the parent repo or follow [Graphiti's docs](https://help.getzep.com/graphiti).

Default URL the extension expects: `http://localhost:8000/mcp/`.

## Install

```bash
# from npm (once published)
pi install npm:pi-graphiti

# or pinned from git
pi install git:github.com/<your-github-username>/pi-graphiti@v0.1.0

# or a local clone (dev loop)
pi install ~/workspace/pi-graphiti
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
| `PI_GRAPHITI_NUDGE_INTERVAL`    | `10`                          | User turns between background pushes. |
| `PI_GRAPHITI_FLUSH_ON_COMPACT`  | `true`                        | Push snapshot before compaction. |
| `PI_GRAPHITI_FLUSH_ON_SHUTDOWN` | `true`                        | Push snapshot on shutdown. |
| `PI_GRAPHITI_FLUSH_MIN_TURNS`   | `6`                           | Minimum user turns before flush triggers. |
| `PI_GRAPHITI_TIMEOUT_MS`        | `60000`                       | Per-tool-call timeout. |

## Usage

The `graph` tool is exposed to the LLM automatically. From the user side:

```
/graph                       Status + recent episodes + active group
/graph search QUERY          search_nodes + search_memory_facts
/graph clear                 clear_graph for the active group (destructive)
```

## Coexistence with `pi-hermes-memory`

The two extensions are fully independent — install either, both, or neither.

- They register **different tools** (`memory` / `memory_search` vs `graph`), so the LLM picks the right one based on tool descriptions.
- They both hook `before_agent_start` to append their own block to the system prompt — Pi composes them safely.
- They use **different group IDs / storage**, so no double-writes.
- If you want them to share a graph, set `PI_GRAPHITI_GROUP_ID` to the same value across machines/installs.

## Design notes

- **Direct HTTP MCP client** (no `pi mcp` dependency). Lets us own timeouts, retries, and silent degradation.
- **Group IDs are sanitized** to `[A-Za-z0-9_]+` because FalkorDB/RediSearch treats `-` as a `NOT` operator and silently corrupts queries.
- **Async extraction** — `add_memory` queues entity/fact extraction server-side. A just-added episode may not be searchable for tens of seconds.
- **Fail-quiet** — if the graphiti server is unreachable, all writes/reads degrade silently. The extension is an accelerator, never a blocker.

## License

MIT
