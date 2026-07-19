/**
 * Standalone types for pi-graphiti.
 */

import type { TextContent } from "@earendil-works/pi-ai";

/**
 * Scope selector for graph reads/writes.
 *   - "project": the per-project group (falls back to global when no project)
 *   - "global":  the shared cross-project group
 *   - "both":    union of project + global (reads only)
 */
export type GraphScope = "project" | "global" | "both";

export interface GraphitiConfig {
  /** Enable the extension. Default: true (installing implies wanting it). */
  enabled: boolean;
  /** Graphiti MCP server URL. Default: http://localhost:8000/mcp/ */
  url: string;
  /** Stable group_id for graphiti. Sanitized to [A-Za-z0-9_]+ at load time
   * because the FalkorDB/RediSearch backend treats `-` as a NOT operator and
   * hyphenated group ids corrupt search queries. */
  groupId: string;
  /** Per-tool-call timeout for graphiti MCP requests. Default 60000ms. */
  toolTimeoutMs: number;
  /** When true, split graph memory into a per-project group + a shared global
   * group (per-project id = `<groupId>_proj_<sanitizedProjectName>`). When
   * false, every op uses the single `groupId` bucket — identical to
   * pre-scoping behavior. Default true. */
  projectScoping: boolean;
  /** When true, inject graphiti search results into the system prompt on
   * before_agent_start. Default false (writes accumulate; reads opt-in). */
  injectContext: boolean;
  /** Push an episode every N user turns (background sync). Default 10. */
  nudgeInterval: number;
  /** Push a snapshot before compaction. Default true. */
  flushOnCompact: boolean;
  /** Push a snapshot on shutdown. Default true. */
  flushOnShutdown: boolean;
  /** Minimum user turns before flush triggers. Default 6. */
  flushMinTurns: number;
  /** Recent messages included in nudge episode. 0 = all. Default 0. */
  nudgeRecentMessages: number;
  /** Recent messages included in flush episode. 0 = all. Default 0. */
  flushRecentMessages: number;
  /** When true, the turn-based nudge runs an LLM curation pass (child `pi -p`)
   * that reads the conversation and calls the `graph` tool itself, deciding
   * WHAT to persist and at WHICH scope (project vs global). When false, the
   * nudge falls back to pushing a raw conversation snapshot (all project
   * scope) and relies purely on graphiti's server-side extraction. Default
   * true. */
  reviewEnabled: boolean;
  /** Recent messages fed to the curation review. 0 = all. Default 0. */
  reviewRecentMessages: number;
  /** When true, detect user corrections in real time and fire an immediate
   * curation review (instead of waiting for the next nudge interval).
   * Default true. */
  correctionDetection: boolean;
  /** Optional model override for the review subprocess (e.g. a cheap/fast
   * model). Empty/undefined uses the default model. */
  llmModelOverride?: string;
  /** Optional thinking level for the review subprocess. When a model override
   * is set and this is unset, thinking defaults to "off". */
  llmThinkingOverride?: string;
}

/**
 * Extract concatenated text from a pi session message.
 * Returns null for non-message entries (BashExecutionMessage, etc.).
 */
export function getMessageText(msg: unknown, maxLength = 500): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  const { role, content } = msg as Record<string, unknown>;
  if (typeof role !== "string") return null;

  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }
  if (Array.isArray(content)) {
    const text = (content as TextContent[])
      .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return text.length > 0 ? text.slice(0, maxLength) : null;
  }
  return null;
}
