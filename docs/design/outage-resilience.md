# Design: MCP outage resilience

Status: partially implemented (items 1, 2, 6 landed in 0.5.0)
Owner: pi-graphiti
Last updated: see git log for this file

## Problem

`pi-graphiti` talks to a Graphiti MCP server over HTTP. That server is optional
infrastructure: a local Docker stack (FalkorDB + Graphiti MCP) or a remote
endpoint. It can be stopped, paused, wedged, or unreachable behind a VPN at any
time, while the host pi agent must keep working at full speed.

Every code path already degrades *functionally* (failures are caught, the agent
keeps going). The exposure is **latency** and **silent data loss**, not crashes.

### Failure modes, ranked by real-world frequency

| Mode | Symptom at the socket | Cost before this design |
| --- | --- | --- |
| Container stopped / port closed | `ECONNREFUSED` in ~1ms | negligible |
| Server hung, VPN black-hole, paused container, wedged FalkorDB | TCP accepted (or SYN dropped), no response body | full `toolTimeoutMs` (60s) per probe |
| Server restarted mid-session | stale `Mcp-Session-Id`, HTTP 4xx | every subsequent call fails until process restart |
| Server up but slow (cold embeddings, LLM extraction backlog) | response after 10-40s | delays proportional to real work |

The refused case is a non-issue. **The hung case is the whole problem**, and the
hung case is also the one a VPN-heavy environment produces most often.

### Where a hang was actually blocking (pre-0.5.0)

| Path | Awaited by host? | Worst case |
| --- | --- | --- |
| `init()` | n/a, no I/O | 0 |
| `sync.ts` `turn_end` nudge | no (detached promise chain) | 0 |
| `session_shutdown` flush | no (fire-and-forget) | 0 |
| `graph` tool call | yes, as a tool call | 60s, then an error result |
| `correction-detector.ts` `turn_end` | **yes**, awaited in-handler | 60s stall at turn end |
| `session_before_compact` | **yes** | compaction delayed 60s |
| `before_agent_start` injection (`injectContext`, default off) | **yes** | 60s at session start |

Two structural bugs amplified this:

1. `src/context.ts` defines `SEARCH_DEADLINE_MS = 4000`, but the race only wraps
   `searchNodes`/`searchFacts`. The `await backend.getStatus()` that *precedes*
   the race was unbounded, so the deadline never did what it was written to do.
2. `GraphitiBackend.STATUS_TTL_MS = 30000` was applied identically to success and
   failure, so a sustained outage was re-probed every 30 seconds forever. With a
   60s hang and a 30s TTL, the extension could be in a probe more often than not.

## Design principles

1. **A health probe is not work.** Reachability checks get a small budget
   (single-digit seconds); real writes and searches keep a generous one.
2. **Bound the wait where it is created, not at each call site.** Any deadline
   that call sites must remember to apply will eventually be forgotten (this
   already happened once, see `context.ts`).
3. **A known-dead server must get cheaper over time, not cost the same forever.**
4. **Never lose the user's memory silently.** Deferred is acceptable; dropped is
   not. (Spooling, tracked below, is the piece that delivers this.)
5. **Degradation must be observable at least once**, not inferred from the
   absence of graph writes hours later.

## Implemented (0.5.0)

### 1. Split timeout: probe budget vs work budget

`GraphitiMcpClient.callTool(name, args, { timeoutMs })` takes a per-call budget
that overrides the client default, threaded through `post()` into the existing
`AbortController`. `ensureInitialized()` accepts the same override, which matters
because a *cold* hung server spends its entire hang inside the `initialize`
handshake; without this, a 2s probe against a never-initialized client would
still block for the 60s client default.

New config `statusTimeoutMs` (`PI_GRAPHITI_STATUS_TIMEOUT_MS`), default
**3000ms**, is used for `get_status` only. `toolTimeoutMs` (default 60000)
continues to govern `add_memory`, `search_nodes`, `search_memory_facts`,
`get_episodes`, and `clear_graph`.

Design note: the timeout is per HTTP request, not per logical operation. A
`callTool` on a cold client performs two requests (initialize, then the call), so
a pathological server can consume up to `2 x budget`. Item 2 caps the logical
operation independently, which is why both exist.

### 2. Enforce the deadline inside `getStatus()`

`getStatus()` races the probe against its own deadline
(`statusTimeoutMs + 500ms` grace, so the client's own abort normally wins and
produces the better error message). Every current and future call site inherits
the bound, including `context.ts`, `correction-detector.ts`, `sync.ts`, and
`tool.ts`.

Two consequences had to be handled:

- **Probe pileup.** If the deadline wins, the probe is still in flight and
  `statusCheckedAt` has not been updated, so the next caller would start a
  *second* probe. Fixed by writing a **provisional** unavailable status into the
  cache at deadline expiry (without touching the failure counter, since the
  probe still owns the authoritative outcome and overwrites it on settle), plus a
  shared in-flight promise (`statusInFlight`) so concurrent callers join one
  probe instead of opening N sockets. This is a partial, deliberate pull-forward
  of tracked item 3, because item 2 is not correct without it.
- **Timer clobbering.** The deadline timer must be cleared when the probe wins,
  otherwise it fires later and overwrites a healthy cache entry with a failure.
  Handled with `clearTimeout` in a `finally` around the race.

The probe also calls `client.reset()` on failure, so a server that restarted gets
a fresh `initialize` (and a fresh `Mcp-Session-Id`) on the next attempt rather
than reusing a session the server has forgotten.

### 6. Exponential backoff instead of a flat TTL

`getStatus()` caches success for `STATUS_TTL_MS` (30s, unchanged) and failure for
a backoff schedule indexed by `consecutiveFailures`:

```
failure 1 -> retry after   5s     (server restarting: recover fast)
failure 2 -> retry after  15s
failure 3 -> retry after  60s
failure 4+ -> retry after 300s    (cap)
```

A success resets the counter to 0. `getStatus(true)` (used by every `/graph`
subcommand) always probes, so the user is never told to wait out a backoff
window. Steady-state cost during a multi-hour outage drops from 120 probes/hour
to 12, and recovery latency stays bounded at 5 minutes.

`GraphitiStatus` gained optional `consecutiveFailures` and `retryAfterMs` fields
so a future `/graph status` can render breaker state without further plumbing.

### Net effect

Worst-case interactive stall from a hung server goes from **60s, repeatable every
30s**, to **~3.5s, decaying to once per 5 minutes**. Refused-connection outages
remain sub-millisecond.

## Tracked, not yet implemented

| # | Item | Value | Notes |
| --- | --- | --- | --- |
| 3 | Full in-flight probe dedup | medium | Partially landed as a prerequisite of item 2 (`statusInFlight`). Remaining: dedup non-probe calls. |
| 4 | Detach `correction-detector.turn_end` | medium | Mirror the `sync.ts` detached `.catch().finally()` pattern so the handler never awaits, even for 3s. |
| 5 | Honor the tool `AbortSignal` | medium | `tool.ts execute(_toolCallId, params, _signal, ...)` discards the signal; thread it into `post()` via `AbortSignal.any` so Esc cancels immediately. |
| 7 | Warm the status cache at init | low | Detached `void backend.getStatus()` at the end of `init()` so the first awaited gate is a cache hit. |
| 8 | Tighter budget for the compact flush | medium | `session_before_compact` is awaited and user-visible; cap the whole flush (probe + write) at ~5s. |
| 9 | **Disk spool for failed writes** | **high** | The real functional gap: during an outage, nudge/compact/shutdown snapshots and correction curations are dropped permanently. Append JSONL under `~/.pi/agent/pi-graphiti-spool/`, drain on first healthy probe, bound by size and age. |
| 10 | Review-child policy during outage | low | Decide whether a 120s child LLM curation pass is worth running when its writes can only reach a spool. |
| 11 | Notify once per session on outage | medium | Single `ui.notify` on first detected outage, guarded by a session flag. |
| 12 | Breaker state in `/graph status` | low | Render `consecutiveFailures`, last error, next retry, spool depth. |

Suggested next commit: **9** (spool), then **4**, **8**, **11** together as the
"never stall, always tell you" pass.

## Verification

- `npm run test:resilience` (`scripts/test-resilience.ts`) drives a deliberately
  hanging local HTTP server plus a dead port, asserting: the probe returns within
  its budget against a hang, the failure backoff schedule advances and suppresses
  re-probes, a success resets the breaker, `force` bypasses the backoff, and
  concurrent callers share a single probe.
- `npm test` runs `check` + `test:scope` + `test:resilience` + smoke tests.
- Manual hang check: `docker pause graphiti-mcp` (or block the port), then run a
  turn. Previously a ~60s stall on a correction turn; now sub-4s, and subsequent
  turns are instant until the backoff window elapses.
