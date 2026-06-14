/**
 * Standalone types for pi-graphiti. No dependency on pi-hermes-memory.
 */

import type { TextContent } from "@earendil-works/pi-ai";

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
