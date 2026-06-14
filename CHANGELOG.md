# Changelog

## 0.1.0 — initial release

- `graph` tool with `add` / `search` / `episodes` actions
- `/graph` slash command (status, search, clear)
- Background sync: pushes a session snapshot every N user turns, before context compaction, and on shutdown
- Optional ambient recall block at session start (`PI_GRAPHITI_INJECT_CONTEXT=1`)
- Config via `~/.pi/agent/pi-graphiti-config.json` or `PI_GRAPHITI_*` env vars
- Group-id sanitization to `[A-Za-z0-9_]+` to avoid RediSearch operator collisions
