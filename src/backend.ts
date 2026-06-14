/**
 * Graphiti backend — high-level wrapper around the MCP HTTP client.
 *
 * Responsibilities:
 *   - lazy-init a single client per backend instance
 *   - sanitize group ids (FalkorDB/RediSearch treats `-` as a NOT operator,
 *     hyphenated group ids corrupt queries — verified bug; see
 *     README.graphiti_plan.md "verification findings")
 *   - expose: getStatus, addEpisode, searchNodes, searchFacts, getEpisodes,
 *     clearGraph
 *   - degrade silently to "unavailable" when the server is unreachable,
 *     so the rest of pi-hermes-memory keeps working without graphiti.
 */

import * as os from "node:os";
import { GraphitiMcpClient, McpClientError, type McpToolCallResult } from "./mcp-client.js";
import type { GraphitiConfig } from "./types.js";

export interface GraphitiStatus {
  available: boolean;
  message: string;
  backend?: string;
  raw?: string;
}

export interface GraphitiSearchHit {
  /** Best-effort label/name for the node or fact. */
  label: string;
  /** Optional UUID for the node, if surfaced by the server. */
  uuid?: string;
  /** Summary / fact body text. */
  summary?: string;
  /** Raw JSON object from graphiti, useful for advanced callers. */
  raw: Record<string, unknown>;
}

/**
 * Sanitize a group id for the FalkorDB backend.
 * RediSearch treats `-` (and other operator chars) as syntax. We keep only
 * `[A-Za-z0-9_]`. Empty result falls back to "pihermes".
 */
export function sanitizeGroupId(input: string | undefined | null): string {
  if (!input || typeof input !== "string") return defaultGroupId();
  const cleaned = input.replace(/[^A-Za-z0-9_]/g, "");
  if (cleaned.length === 0) return defaultGroupId();
  return cleaned;
}

export function defaultGroupId(): string {
  // pigraphiti + sanitized username + sanitized hostname.
  const user = process.env.USER || process.env.USERNAME || "user";
  const host = (() => {
    try { return os.hostname(); } catch { return "host"; }
  })();
  const tail = `${user}${host}`.replace(/[^A-Za-z0-9_]/g, "");
  return `pigraphiti${tail || "default"}`.slice(0, 64);
}

export interface GraphitiBackendOptions {
  /** Resolved (sanitized) group id used for all operations. */
  groupId: string;
  /** Graphiti MCP server URL. */
  url: string;
  /** Per-tool-call timeout. */
  timeoutMs: number;
}

export class GraphitiBackend {
  readonly options: GraphitiBackendOptions;
  private readonly client: GraphitiMcpClient;
  private lastStatus: GraphitiStatus | null = null;
  private statusCheckedAt = 0;
  private static readonly STATUS_TTL_MS = 30000;

  constructor(options: GraphitiBackendOptions) {
    this.options = options;
    this.client = new GraphitiMcpClient({ url: options.url, timeoutMs: options.timeoutMs });
  }

  /** Quick health check, cached for STATUS_TTL_MS to avoid hammering the server. */
  async getStatus(force = false): Promise<GraphitiStatus> {
    const now = Date.now();
    if (!force && this.lastStatus && now - this.statusCheckedAt < GraphitiBackend.STATUS_TTL_MS) {
      return this.lastStatus;
    }
    try {
      const res = await this.client.callTool("get_status", {});
      const parsed = tryParseJson(res.text);
      const status: GraphitiStatus = {
        available: true,
        message: typeof parsed?.status === "string" ? parsed.status : "ok",
        backend: typeof parsed?.message === "string" ? parsed.message : undefined,
        raw: res.text,
      };
      this.lastStatus = status;
      this.statusCheckedAt = now;
      return status;
    } catch (err) {
      const status: GraphitiStatus = {
        available: false,
        message: err instanceof McpClientError ? err.message : String(err),
      };
      this.lastStatus = status;
      this.statusCheckedAt = now;
      return status;
    }
  }

  /**
   * Add an episode. Graphiti queues it for async extraction; the returned
   * promise resolves as soon as the server acks (typically <1s).
   */
  async addEpisode(args: {
    name: string;
    body: string;
    source?: "text" | "message" | "json";
    sourceDescription?: string;
  }): Promise<McpToolCallResult> {
    return this.client.callTool("add_memory", {
      name: args.name,
      episode_body: args.body,
      group_id: this.options.groupId,
      source: args.source ?? "text",
      ...(args.sourceDescription ? { source_description: args.sourceDescription } : {}),
    });
  }

  async searchNodes(query: string, maxNodes = 5): Promise<GraphitiSearchHit[]> {
    if (!query.trim()) return [];
    const res = await this.client.callTool("search_nodes", {
      query,
      group_ids: [this.options.groupId],
      max_nodes: maxNodes,
    });
    return parseSearchNodes(res.text);
  }

  async searchFacts(query: string, maxFacts = 5): Promise<GraphitiSearchHit[]> {
    if (!query.trim()) return [];
    const res = await this.client.callTool("search_memory_facts", {
      query,
      group_ids: [this.options.groupId],
      max_facts: maxFacts,
    });
    return parseSearchFacts(res.text);
  }

  async getEpisodes(lastN = 5): Promise<GraphitiSearchHit[]> {
    const res = await this.client.callTool("get_episodes", {
      group_id: this.options.groupId,
      last_n: lastN,
    });
    return parseEpisodes(res.text);
  }

  async clearGraph(): Promise<McpToolCallResult> {
    return this.client.callTool("clear_graph", {
      group_ids: [this.options.groupId],
    });
  }
}

/**
 * Build a GraphitiBackend from standalone config, or return null when disabled.
 */
export function buildGraphitiBackend(config: GraphitiConfig): GraphitiBackend | null {
  if (!config.enabled) return null;
  const url = (config.url ?? "").trim() || "http://localhost:8000/mcp/";
  const groupId = sanitizeGroupId(config.groupId);
  return new GraphitiBackend({
    url,
    groupId,
    timeoutMs: config.toolTimeoutMs ?? 60000,
  });
}

/** Best-effort JSON parser — returns null on any error. */
function tryParseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const obj = JSON.parse(text);
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Graphiti returns search results encoded as a JSON string inside the text
 * content. Different versions wrap differently — handle common shapes:
 *   - `{ "nodes": [...] }`
 *   - `{ "results": [...] }`
 *   - bare array `[ ... ]`
 *   - plain text fallback ("No relevant nodes found")
 */
function parseSearchNodes(text: string): GraphitiSearchHit[] {
  const arr = extractArray(text, ["nodes", "results"]);
  return arr.map((node) => {
    const obj = node as Record<string, unknown>;
    return {
      label: stringField(obj, ["name", "label", "entity_name", "id"]) || "(unnamed)",
      uuid: stringField(obj, ["uuid", "id"]),
      summary: stringField(obj, ["summary", "description"]),
      raw: obj,
    };
  });
}

function parseSearchFacts(text: string): GraphitiSearchHit[] {
  const arr = extractArray(text, ["facts", "edges", "results"]);
  return arr.map((fact) => {
    const obj = fact as Record<string, unknown>;
    const summary = stringField(obj, ["fact", "summary", "edge_name", "relation", "description"]);
    return {
      label: summary || stringField(obj, ["name", "id"]) || "(fact)",
      uuid: stringField(obj, ["uuid", "id"]),
      summary,
      raw: obj,
    };
  });
}

function parseEpisodes(text: string): GraphitiSearchHit[] {
  const arr = extractArray(text, ["episodes", "results"]);
  return arr.map((ep) => {
    const obj = ep as Record<string, unknown>;
    return {
      label: stringField(obj, ["name", "id"]) || "(episode)",
      uuid: stringField(obj, ["uuid", "id"]),
      summary: stringField(obj, ["content", "episode_body", "summary"]),
      raw: obj,
    };
  });
}

function extractArray(text: string, keys: string[]): unknown[] {
  if (!text || !text.trim()) return [];
  // Try parsing the whole payload first
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Some graphiti responses concatenate text + JSON; try to find the JSON tail
    const start = text.indexOf("{");
    const arrStart = text.indexOf("[");
    const idx = start === -1 ? arrStart : (arrStart === -1 ? start : Math.min(start, arrStart));
    if (idx === -1) return [];
    try { parsed = JSON.parse(text.slice(idx)); } catch { return []; }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const k of keys) {
      const val = (parsed as Record<string, unknown>)[k];
      if (Array.isArray(val)) return val;
    }
  }
  return [];
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
