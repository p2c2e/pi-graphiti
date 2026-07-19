/**
 * Correction detection for pi-graphiti.
 *
 * Detects user corrections in real time and fires an IMMEDIATE curation review
 * (child `pi -p` that calls the `graph` tool) instead of waiting for the next
 * turn-based nudge interval. A user correcting the agent is the single highest
 * signal "you should have remembered that" moment in a session, so we capture
 * it right away.
 *
 * Two-pass filter (ported from pi-hermes-memory):
 *   - Strong patterns: always trigger (high confidence)
 *   - Weak patterns:   only trigger if followed by a directive clause
 *   - Negative patterns: suppress even if a positive pattern matched
 *
 * Fail-quiet: gated on graphiti reachability; every failure is swallowed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GraphitiBackend } from "./backend.js";
import type { GraphitiConfig } from "./types.js";
import { getMessageText } from "./types.js";
import { runGraphitiReview } from "./review.js";

/** Strong patterns — always trigger. */
const CORRECTION_STRONG_PATTERNS: RegExp[] = [
  /don'?t do that/i,
  /not like that/i,
  /^I said\b/i,
  /^I told you\b/i,
  /we already discussed/i,
  /^please don'?t/i,
  /^that'?s not what I/i,
];

/** Weak patterns — only trigger if followed by a directive clause. */
const CORRECTION_WEAK_PATTERNS: RegExp[] = [
  /^no[,\.\s!]/i,
  /^wrong[,\.\s!]/i,
  /^actually[,\.\s]/i,
  /^stop[,\.\s!]/i,
];

/** Negative patterns — suppress trigger even if a positive pattern matches. */
const CORRECTION_NEGATIVE_PATTERNS: RegExp[] = [
  /^no worries/i,
  /^no problem/i,
  /^no thanks/i,
  /^no need/i,
  /^actually.{0,10}(looks? great|perfect|good|correct|right)/i,
  /^stop.{0,5}(there|here|for now)/i,
];

/** Directive words required after a weak correction pattern. */
const CORRECTION_DIRECTIVE_WORDS: string[] = [
  "use", "don't", "dont", "do", "try", "make", "run", "install", "add",
  "remove", "delete", "change", "fix", "put", "set", "write", "go", "stop",
  "start", "the", "that", "this", "it",
];

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDirectiveWord(remainder: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const source = words.map(escapeRegexLiteral).join("|");
  return new RegExp(`\\b(${source})\\b`, "i").test(remainder);
}

/**
 * Check if a user message is a correction using the two-pass filter.
 */
export function isCorrection(text: string): boolean {
  // Negative patterns first — suppress even if a positive pattern matches.
  for (const pattern of CORRECTION_NEGATIVE_PATTERNS) {
    if (pattern.test(text)) return false;
  }

  // Strong patterns — always trigger.
  for (const pattern of CORRECTION_STRONG_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  // Weak patterns — only trigger if immediately followed by a directive.
  for (const pattern of CORRECTION_WEAK_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index === 0) {
      const remainder = text.slice(match[0].length).trim();
      if (hasDirectiveWord(remainder, CORRECTION_DIRECTIVE_WORDS)) return true;
    }
  }

  return false;
}

export function setupGraphitiCorrectionDetector(
  pi: ExtensionAPI,
  backend: GraphitiBackend,
  config: GraphitiConfig,
): void {
  if (!config.correctionDetection) return;

  let pendingCorrection = false;
  let turnsSinceLastCorrection = 3; // start at threshold so first can fire immediately
  let correctionInProgress = false;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "user") return;
    const text = getMessageText(event.message, 4000);
    if (!text) return;
    if (isCorrection(text)) pendingCorrection = true;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!pendingCorrection) {
      turnsSinceLastCorrection++;
      return;
    }
    pendingCorrection = false;

    // Rate limit: at most one correction-triggered review per 3 turns.
    if (turnsSinceLastCorrection < 3) return;
    if (correctionInProgress) return;

    turnsSinceLastCorrection = 0;
    correctionInProgress = true;

    try {
      // Cheap reachability gate — no point spawning a child review whose
      // `graph add` writes would just fail against a down server.
      const status = await backend.getStatus();
      if (!status.available) return;

      const saved = await runGraphitiReview(pi, ctx as any, config);
      if (saved) {
        const notify = (ctx as { ui?: { notify?: (m: string, l?: string) => void } }).ui?.notify;
        if (notify) notify("Correction detected - graph memory updated", "info");
      }
    } catch {
      // Best-effort — never block the session.
    } finally {
      correctionInProgress = false;
    }
  });
}
