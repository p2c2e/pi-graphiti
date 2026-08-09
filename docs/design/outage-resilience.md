# Design: MCP outage resilience

Status: items 1, 2, 6, 9 implemented (0.5.0 and 0.6.0)
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

### 2. Bound the probe at the transport, not with a wrapper deadline

`getStatus()` passes ONE `AbortSignal.timeout(statusTimeoutMs)` into the client,
which bounds every request the probe makes (handshake + `get_status`) and cancels
the in-flight socket. `McpCallOptions.signal` threads it through
`ensureInitialized` and `post`, combined with the per-request timer via
`AbortSignal.any` (with a manual fallback for Node < 20.3).

Concurrent callers still share one in-flight probe (`statusInFlight`), which is
safe precisely because the probe is now guaranteed to settle within its budget.

**This replaced a layered design that had a real defect** (found in review, see
below): the first implementation wrapped the probe in a `Promise.race` deadline
and, when that deadline won, wrote a *provisional* failure into the cache while
deliberately leaving `consecutiveFailures` untouched and never abandoning the
in-flight probe. Against a probe that outlived the deadline that froze the breaker
at 0 forever: the backoff never escalated, no fresh probe was ever issued, and
even `force` could not break out because it bypassed the cache but joined the
pinned in-flight promise. Bounding at the transport removes the race rather than
patching it, and deletes four moving parts (wrapper deadline, grace constant,
provisional entry, timer-clobber hazard).

Also fixed here: `ensureInitialized` now carries a generation guard, so a
late-failing init cannot clear a newer caller's promise.

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

## Implemented (0.6.0)

### 9. Disk write spool

The functional half of the problem: every automatic write path used to *swallow*
its failure, so an outage silently became permanent memory loss.

`src/spool.ts` persists failed episodes as JSONL at
`<agentRoot>/pi-graphiti-spool/pending.jsonl` and replays them on the next healthy
cycle.

Key decisions:

- **Store the resolved `group_id`, not the scope.** Replay must land where the
  write was originally aimed even if the project, cwd, or scoping config changed
  between capture and replay. Replay therefore uses `addEpisodeToGroup`, not
  `addEpisode`.
- **Build the episode before probing.** `pushSnapshot` previously checked
  reachability first and returned, so an unreachable server discarded the
  snapshot *before it was ever assembled* - and the session state it derives from
  is gone once the session ends. The snapshot is now built first, then either
  written or spooled.
- **Shutdown does zero network I/O.** `session_shutdown` is fire-and-forget, so
  ANY await before the disk write is a chance for the process to exit and lose the
  episode. The shutdown path spools synchronously and lets the next session's init
  drain replay it.
- **The pre-compact flush has its own 5s write budget** (`COMPACT_WRITE_BUDGET_MS`,
  passed as `addEpisode({ timeoutMs })`, which also cancels the socket). That hook
  IS awaited by the host, so the 60s work default was unacceptable; on expiry the
  episode spools. This closes tracked item 8.
- **The nudge path spools even with `reviewEnabled`** (the default). `runReview`
  used to return early on an unavailable probe, which meant the default
  configuration built no snapshot and spooled nothing - the headline invariant did
  not hold for the most common path. It now falls back to `pushSnapshot`, so
  curation quality degrades but the memory survives.
- **Atomic `rename` claim for every mutation.** Two pi sessions draining
  concurrently cannot double-write an episode: exactly one wins the rename.
  Entries not replayed are appended back.
- **The claim is deleted only after the requeue is confirmed.** `requeue` returns
  a boolean; on a write failure (ENOSPC, EPERM) the claim file is deliberately
  left in place for the stale sweep. Deleting it unconditionally - as the first
  implementation did - destroyed the entire in-flight batch precisely under the
  disk conditions a spool exists to survive.
- **Liveness beats age in the stale sweep.** A claim is reclaimed only when its
  owning pid is gone (encoded in the filename, checked with `process.kill(pid, 0)`)
  or its heartbeat is stale; `drain` touches the claim after every replayed entry.
  An mtime-only sweep resurrected the batch of a *live but slow* drain and replayed
  every episode in it twice - measured at 8 writes for 4 episodes, and reachable
  through the normal post-outage flow (`/graph spool drain` replays the whole
  backlog sequentially against a server that answers in 10-40s).
- **A failed entry requeues at the TAIL.** At its original position it would be
  retried first every cycle and, with stop-on-first-failure, block every healthy
  entry behind it for `MAX_ATTEMPTS` cycles (~50 user turns).
- **Transport failures do not consume attempts.** Only server-side rejections
  count toward `MAX_ATTEMPTS`, so an outage or a flaky link cannot burn through a
  healthy episode's budget and discard it.
- **Nothing is deleted silently.** Expired, abandoned, and evicted entries are
  appended to `dead-letter.jsonl` with a reason and timestamp, and the count is
  surfaced in `/graph`. Principle 5 applies to the spool's own drops too.
- **Truncation is reported, never silent.** `enqueue` returns
  `{ ok, truncated, storedChars, originalChars }` and the tool echoes it. The
  first version cut bodies at 20k on the spool path only (the direct write path
  has no cap) behind a `success: true, "No need to retry"` message.
- **`stats()` counts claim files, not just `pending.jsonl`.** Otherwise entries
  stranded by a `kill -9` read as zero, which made both the UI and
  `maybeDrain`'s depth gate blind to them - so the recovery sweep, reachable only
  from inside `drain`, was never invoked at all.
- **Limits clamp to >= 1.** `maxEntries: 0` hit `slice(-0)`, which keeps the whole
  array and silently disabled the cap; `batchLimit: 0` made every drain a no-op.
- **Three bounds:** `spoolMaxEntries` (200), `spoolMaxBytes` (8MB),
  `spoolMaxAgeDays` (14). A long outage degrades to "newest N kept".
- **`add` during an outage reports success, with `spooled: true`.** Deliberate:
  the content is durably captured, so the agent must not retry or re-derive it -
  but only when `ok` is true, and with truncation surfaced. Reads (`search`,
  `episodes`) still fail honestly, because they genuinely cannot be served.
- **Empty-spool fast path.** `maybeDrain` checks on-disk depth *before* probing,
  so the overwhelmingly common healthy-and-empty case costs one `stat` and no
  network call.
- **`/graph clear` also clears the spool.** Otherwise pending episodes replay on
  the next healthy cycle and re-populate the graph the user just wiped.
- **`/graph dump` reports partial failure and includes the spool.**
  `dumpAllEpisodes` now returns a per-group `error`, the markdown marks the section
  INCOMPLETE, and the notification is a warning. Spooled episodes get their own
  section, since before replay they exist nowhere else - exactly the memory a
  pre-revert export must not miss.

Drain triggers: extension init (detached), and after each turn-nudge cycle. Manual
control via `/graph spool [drain|clear]`, and `/graph` status shows spool depth,
stranded count, dead-letter count, and breaker state.

### Bug found while verifying the spool: `get_episodes` read the wrong args

Proving that a replayed episode had actually landed required reading episodes
back, which exposed a pre-existing defect unrelated to spooling. Current graphiti
servers expose `get_episodes(group_ids: string[], max_episodes: int)`, but the
backend sent the legacy `{ group_id, last_n }`. FastMCP ignored the unknown args,
`group_ids` defaulted to null, the query fell through to the empty `default_db`
graph, and **every episode read returned zero results**:

- `/graph` status always claimed "no recent episodes"
- the `graph` tool's `episodes` action was always empty
- **`/graph dump` wrote an empty export while reporting success** - actively
  dangerous, since that dump is the documented safety net before reverting to
  flat-file memory

Fixed in `fetchEpisodes()`: modern shape first (padded to >= 2 group ids for the
same graphiti #1161 reason as search), falling back to the legacy shape when the
server rejects it. Verified live: 0 episodes before, 2 after (including the
spool-replayed one).

## Independent review (pre-release, 0.6.0)

Two fresh-context read-only reviewers audited this work before it shipped, one on
simplicity, one on robustness. The robustness pass ran empirical probes against
the real modules rather than reading only. It is worth recording what that caught,
because several items were *invariant violations hidden behind passing tests*:

1. **The headline invariant did not hold in the default configuration.** With
   `reviewEnabled: true` (default) the nudge path spooled nothing. The author's own
   live demo passed only because its fixture set `reviewEnabled: false`.
2. **Crash recovery was unreachable.** `recoverStaleClaims` lived inside `drain`,
   but the real entry point `maybeDrain` gated on a depth check that ignored claim
   files. The test passed because it called `drain()` directly.
3. **The stale sweep double-wrote a live drain's batch** (measured 8 writes for 4
   episodes) because it used mtime alone with no liveness check or heartbeat.
4. **Requeue failure destroyed the batch** - `requeue` swallowed its error and the
   claim was unlinked unconditionally.
5. **The layered `getStatus` deadline froze the breaker** (see item 2 above).
6. **Three tests passed for the wrong reason**: the "concurrent drains" test was
   single-process, so `claim()`'s synchronous rename meant the second drain simply
   found no file; the stale-claim test bypassed the real entry point; and the
   deadline branch was never reached because the probe budget was shorter than the
   deadline.

Lessons folded into the tests: exercise concurrency across real processes (the
suite now re-execs itself with a start barrier), always drive the *public* entry
point rather than the internal one, and build fixtures from DEFAULT config.

## Tracked, not yet implemented

| # | Item | Value | Notes |
| --- | --- | --- | --- |
| 3 | Full in-flight probe dedup | low | `statusInFlight` covers probes. Remaining: dedup non-probe calls. Lower value now that probes always settle within budget. |
| 4 | Detach `correction-detector.turn_end` | medium | Still awaits `getStatus()` in-handler. Bounded at ~3s now, but should mirror the detached `.catch().finally()` pattern in `sync.ts`. |
| 5 | Thread the tool `AbortSignal` into the request | low | `McpCallOptions.signal` now exists and the tool uses the signal to avoid spooling a user-cancelled write; passing it into `post` for true mid-flight cancellation is a one-line follow-up. |
| 7 | Warm the status cache at init | low | Detached `void backend.getStatus()` at the end of `init()` so the first awaited gate is a cache hit. |
| 8 | Tighter budget for the compact flush | **done** | `COMPACT_WRITE_BUDGET_MS` (5s) with socket cancellation; spools on expiry. |
| 10 | Curation during an outage | low | The review path now falls back to a spooled raw snapshot. The correction detector still SKIPS rather than spools when the server is down. |
| 11 | Notify once per session on outage | medium | Single `ui.notify` on first detected outage, guarded by a session flag; should report spool depth and any dead-letter drops. |
| 12 | Breaker + spool state in `/graph status` | **done** | Shows spool depth, stranded count, dead-letter count, consecutive failures, and next-probe countdown. |
| 13 | `fsync` the spool append | low | An episode acked as spooled can still be lost to a machine crash (page cache). Acceptable for a local accelerator; recorded so the gap is explicit. |
| 14 | Spool is global, not per-project | low | It lives under `agentRoot()` and is shared by all sessions, so `/graph spool clear` in one project discards another's pending memory, and eviction is global. |

Suggested next commit: **4** and **11** together as the "never stall, always tell
you" pass.

## Verification

- `npm run test:resilience` (20 assertions) drives a deliberately hanging local
  HTTP server plus a dead port: probe returns within budget against a hang, a hung
  probe COUNTS toward the breaker and escalates 1 -> 2 -> 3 with fresh sockets,
  `force` can start a new probe while hung, the backoff schedule advances and
  suppresses re-probes, success resets the breaker, and concurrent callers share a
  single probe.
- `npm run test:spool` (28 assertions, isolated via `PI_CODING_AGENT_DIR`) asserts:
  group-faithful ordered replay, requeue-on-failure, transport-vs-server error
  accounting, failed-entry-to-tail, batch limits and clamping, age expiry,
  abandonment, dead-letter recording, entry and byte bounds, truncation reporting,
  batch preservation when the requeue write fails, **no double-write across two
  simultaneously-released OS processes**, live-claim protection, crash recovery
  **through `maybeDrain`**, corrupt-line tolerance, and the no-probe empty-spool
  fast path.
- `npm run test:scope` (8) additionally asserts the `get_episodes` arg shape and
  its legacy-server fallback.
- `npm test` runs `check` + all three suites + smoke tests.
- Live end-to-end against the real FalkorDB stack: spool -> drain -> read back.
- Live hook-chain check with DEFAULT config against a dead port: `turn_end`
  returned in 8ms and spooled 1; `session_shutdown` returned in 1ms and spooled
  without any network call; a backdated orphan claim was recovered and replayed
  through `maybeDrain`.
- Manual hang check: `docker pause graphiti-mcp` (or block the port), then run a
  turn. Previously a ~60s stall on a correction turn; now sub-4s, and subsequent
  turns are instant until the backoff window elapses.
