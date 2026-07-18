/**
 * Graphiti write path — push episodes from existing memory cadence.
 *
 * Hooks into the same triggers as flat memory:
 *   - session_before_compact       (full snapshot, can afford to wait)
 *   - session_shutdown             (fire-and-forget)
 *   - turn_end + nudge-interval    (mirrors background-review cadence)
 *
 * Each event builds a compact episode from the recent conversation and
 * pushes it to graphiti via direct HTTP MCP (no child pi -p). Failures are
 * swallowed: graphiti is an optional accelerator, never a blocker.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GraphitiBackend } from "./backend.js";
import type { GraphitiConfig } from "./types.js";
import { collectMessageParts } from "./message-parts.js";
import { runGraphitiReview } from "./review.js";

const MAX_EPISODE_BODY_CHARS = 8000;
const EPISODE_NAME_MAX = 80;

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
    // fire-and-forget — never block shutdown
    pushSnapshot(ctx, backend, config, "shutdown").catch(() => {});
  });
}

async function runReview(
  pi: ExtensionAPI,
  ctx: any,
  backend: GraphitiBackend,
  config: GraphitiConfig,
): Promise<void> {
  // Cheap reachability gate first — if graphiti is down there's no point
  // spending a child-LLM call whose `graph add` writes would just fail.
  const status = await backend.getStatus();
  if (!status.available) return;
  await runGraphitiReview(pi, ctx, config);
}

async function pushSnapshot(
  ctx: any,
  backend: GraphitiBackend,
  config: GraphitiConfig,
  trigger: "nudge" | "compact" | "shutdown",
): Promise<void> {
  // Reach status first — degrade silently if graphiti is unreachable so we
  // don't pile up failed fetches on every turn_end.
  const status = await backend.getStatus();
  if (!status.available) return;

  let entries;
  try { entries = ctx.sessionManager.getBranch(); } catch { return; }

  const recentN = trigger === "nudge"
    ? (config.nudgeRecentMessages || 0)
    : (config.flushRecentMessages || 0);
  const parts = collectMessageParts(entries, recentN);
  if (parts.length < 2) return;

  const body = parts.join("\n\n").slice(0, MAX_EPISODE_BODY_CHARS);
  const name = buildEpisodeName(trigger);

  try {
    await backend.addEpisode({
      name,
      body,
      source: "message",
      sourceDescription: `pi-graphiti ${trigger}`,
    });
  } catch {
    // Swallowed — graphiti is optional accelerator.
  }
}

function buildEpisodeName(trigger: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `pi-${trigger}-${ts}`;
  return name.slice(0, EPISODE_NAME_MAX);
}
