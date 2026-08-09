/**
 * Graphiti write path — push episodes from existing memory cadence.
 *
 * Hooks into the same triggers as flat memory:
 *   - session_before_compact       (full snapshot, can afford to wait)
 *   - session_shutdown             (fire-and-forget)
 *   - turn_end + nudge-interval    (mirrors background-review cadence)
 *
 * Each event builds a compact episode from the recent conversation and
 * pushes it to graphiti via direct HTTP MCP (no child pi -p).
 *
 * Write failures are never dropped: when the server is unreachable (or the
 * write throws) the episode is appended to the disk spool and replayed on the
 * next healthy cycle. Graphiti remains an optional accelerator and never a
 * blocker, but an outage now costs DELAY, not memory (docs/design/
 * outage-resilience.md item 9).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GraphitiBackend } from "./backend.js";
import type { GraphitiConfig } from "./types.js";
import { collectMessageParts } from "./message-parts.js";
import { runGraphitiReview } from "./review.js";
import { maybeDrain, spoolEpisode } from "./spool.js";

const MAX_EPISODE_BODY_CHARS = 8000;
const EPISODE_NAME_MAX = 80;
/**
 * Write budget for the pre-compact flush. This hook IS awaited by the host, so
 * it is user-visible latency; the 60s default work budget is unacceptable here.
 * On expiry the episode spools instead (docs/design/outage-resilience.md item 8).
 */
const COMPACT_WRITE_BUDGET_MS = 5000;

export function setupGraphitiSync(
  pi: ExtensionAPI,
  backend: GraphitiBackend,
  config: GraphitiConfig,
): void {
  let userTurnsSinceReview = 0;
  let userTurnCount = 0;
  let pushInProgress = false;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") {
      userTurnCount++;
      userTurnsSinceReview++;
    }
  });

  // Push on the same cadence as background-review (turn-based nudge),
  // independent of the flat-memory review subprocess. We piggyback on turn_end.
  //
  // When config.reviewEnabled (default), the nudge runs an LLM curation pass
  // (child `pi -p`) that decides WHAT to persist and at WHICH scope by calling
  // the `graph` tool itself. When disabled, it falls back to pushing a raw
  // conversation snapshot (all project scope) and leans on graphiti's
  // server-side extraction.
  pi.on("turn_end", async (_event, ctx) => {
    if (pushInProgress) return;
    if (userTurnsSinceReview < config.nudgeInterval) return;
    if (userTurnCount < 3) return;
    userTurnsSinceReview = 0;
    pushInProgress = true;

    const work = config.reviewEnabled
      ? runReview(pi, ctx, backend, config).then(() => {})
      : pushSnapshot(ctx, backend, config, "nudge");

    work
      // Opportunistic replay of anything stranded by an earlier outage. Runs
      // after the push so a recovered server drains on the same cadence that
      // filled the spool. No-ops (single stat, no probe) when the spool is empty.
      .then(() => maybeDrain(backend, config))
      .catch(() => {})
      .finally(() => { pushInProgress = false; });
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (!config.flushOnCompact) return;
    if (userTurnCount < config.flushMinTurns) return;
    await pushSnapshot(ctx, backend, config, "compact");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!config.flushOnShutdown) return;
    if (userTurnCount < config.flushMinTurns) return;
    // Spools synchronously (no probe, no network) and returns; the next session's
    // init drain replays it. Never blocks shutdown, never loses the episode.
    pushSnapshot(ctx, backend, config, "shutdown").catch(() => {});
  });
}

async function runReview(
  pi: ExtensionAPI,
  ctx: any,
  backend: GraphitiBackend,
  config: GraphitiConfig,
): Promise<void> {
  // Cheap reachability gate first - a child-LLM curation pass is expensive and
  // its `graph add` calls would have to spool anyway.
  const status = await backend.getStatus();
  if (!status.available) {
    // Do NOT just return: with reviewEnabled (the default) that made the whole
    // turn-nudge path lossy during an outage, since no snapshot was ever built.
    // Fall back to the raw snapshot, which spools. Curation quality degrades;
    // the memory survives.
    await pushSnapshot(ctx, backend, config, "nudge");
    return;
  }
  await runGraphitiReview(pi, ctx, config);
}

async function pushSnapshot(
  ctx: any,
  backend: GraphitiBackend,
  config: GraphitiConfig,
  trigger: "nudge" | "compact" | "shutdown",
): Promise<void> {
  // Build the episode BEFORE probing: the snapshot is the thing we must not
  // lose, and it is derived from session state that is gone once the session
  // ends. Probing first (as this used to) meant an unreachable server threw the
  // snapshot away before it was ever assembled.
  let entries;
  try { entries = ctx.sessionManager.getBranch(); } catch { return; }

  const recentN = trigger === "nudge"
    ? (config.nudgeRecentMessages || 0)
    : (config.flushRecentMessages || 0);
  const parts = collectMessageParts(entries, recentN);
  if (parts.length < 2) return;

  const episode = {
    name: buildEpisodeName(trigger),
    body: parts.join("\n\n").slice(0, MAX_EPISODE_BODY_CHARS),
    groupId: backend.writeGroupId("project"),
    source: "message" as const,
    sourceDescription: `pi-graphiti ${trigger}`,
    origin: trigger,
  };

  // Shutdown is special: the host does not await this work, so ANY await before
  // the disk write is a chance for the process to exit and lose the episode.
  // Spool synchronously and let the next session's init drain replay it. That
  // also means shutdown does zero network I/O.
  if (trigger === "shutdown") {
    spoolEpisode(config, episode);
    return;
  }

  // Cheap reachability gate (bounded probe + failure backoff) so we don't pile
  // up doomed fetches on every turn_end. One spool path covers both "server was
  // already down" and "the write itself failed".
  try {
    const status = await backend.getStatus();
    if (!status.available) throw new Error(status.message);
    await backend.addEpisode({
      name: episode.name,
      body: episode.body,
      source: episode.source,
      sourceDescription: episode.sourceDescription,
      ...(trigger === "compact" ? { timeoutMs: COMPACT_WRITE_BUDGET_MS } : {}),
    });
  } catch {
    spoolEpisode(config, episode);
  }
}

function buildEpisodeName(trigger: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `pi-${trigger}-${ts}`;
  return name.slice(0, EPISODE_NAME_MAX);
}
