/**
 * Graphiti backend — high-level wrapper around the MCP HTTP client.
 *
 * Responsibilities:
 *   - lazy-init a single client per backend instance
 *   - sanitize group ids (FalkorDB/RediSearch treats `-` as a NOT operator,
 *     hyphenated group ids corrupt queries) and derive per-project group ids
 *   - expose: getStatus, addEpisode, searchNodes, searchFacts, getEpisodes,
 *     clearGraph, allGroupIds, dumpAllEpisodes
 *   - degrade silently to "unavailable" when the server is unreachable, so the
 *     host agent keeps working without graphiti.
 */

import { GraphitiMcpClient, McpClientError, type McpToolCallResult } from "./mcp-client.js";
import type { GraphitiConfig, GraphScope } from "./types.js";

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
 * `[A-Za-z0-9_]`. Empty result falls back to a default.
 */
export function sanitizeGroupId(input: string | undefined | null): string {
  if (!input || typeof input !== "string") return defaultGroupId();
  const cleaned = input.replace(/[^A-Za-z0-9_]/g, "");
  if (cleaned.length === 0) return defaultGroupId();
  return cleaned;
}

/**
 * RediSearch (FalkorDB fulltext) default English stopword list. A query built
 * entirely from these tokens is stripped to empty by the tokenizer, after which
 * graphiti-core emits an invalid `(@group_id:"...") ()` clause and FalkorDB
 * throws `Syntax error at offset 34`. We filter client-side so these queries
 * (and punctuation-only ones) never reach the server.
 */
const REDISEARCH_STOPWORDS = new Set([
  "a", "is", "the", "an", "and", "are", "as", "at", "be", "but", "by", "for",
  "if", "in", "into", "it", "no", "not", "of", "on", "or", "such", "that",
  "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
]);

/**
 * True when a query has at least one term that will survive RediSearch
 * tokenization (alphanumeric token that is not a default stopword). Returning
 * false means the search would produce an invalid empty RediSearch clause, so
 * callers skip the round-trip and degrade to zero results.
 */
export function hasSearchableTerms(query: string | undefined | null): boolean {
  if (!query) return false;
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens) return false;
  return tokens.some((t) => !REDISEARCH_STOPWORDS.has(t));
}

export function defaultGroupId(): string {
  // pigraphiti + sanitized username only. The hostname is intentionally NOT
  // included: os.hostname() often returns an ephemeral IP-derived name (e.g.
  // `ip-192-168-1-177.ec2.internal` under VPN/DHCP), which would silently
  // change the base group id and orphan existing memory when the IP is
  // reassigned. For per-machine isolation, set `groupId` explicitly in
  // ~/.pi/agent/pi-graphiti-config.json (or PI_GRAPHITI_GROUP_ID).
  const user = process.env.USER || process.env.USERNAME || "user";
  const tail = user.replace(/[^A-Za-z0-9_]/g, "");
  return `pigraphiti${tail || "default"}`.slice(0, 64);
}

export interface GraphitiBackendOptions {
  /** Shared global group id (sanitized). Used as the fallback when no project
   * is active and as one leg of "both" reads. */
  groupId: string;
  /** Per-project group id (sanitized), or null when no project is active or
   * project scoping is disabled. */
  projectGroupId: string | null;
  /** Whether project/global scoping is active. When false, all ops use
   * `groupId` only (legacy single-bucket behavior). */
  projectScoping: boolean;
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

  /**
   * The group id used for WRITES at a given scope. "global" -> global group.
   * "project"/"both" -> project group when available, else global. With scoping
   * off, always the single global bucket.
   */
  writeGroupId(scope: GraphScope = "project"): string {
    if (!this.options.projectScoping) return this.options.groupId;
    if (scope === "global") return this.options.groupId;
    return this.options.projectGroupId ?? this.options.groupId;
  }

  /**
   * The group ids queried for READS at a given scope. "both" unions
   * project+global (deduped); "project"/"global" narrow to one. With scoping
   * off, always just the single global bucket.
   */
  readGroupIds(scope: GraphScope = "both"): string[] {
    if (!this.options.projectScoping) return [this.options.groupId];
    const project = this.options.projectGroupId;
    if (scope === "global") return [this.options.groupId];
    if (scope === "project") return [project ?? this.options.groupId];
    // "both": project + global, deduped, project first for recall priority
    const ids = [project ?? this.options.groupId, this.options.groupId];
    return [...new Set(ids)];
  }

  /**
   * Group ids to send on the wire for READS (search/clear), working around
   * graphiti #1161: on FalkorDB, a search scoped to a SINGLE group_id silently
   * returns zero results because graphiti's handle_multiple_group_ids decorator
   * only takes the per-graph clone path when len(group_ids) > 1; a single id
   * falls through to the empty default_db graph.
   *
   * Fix: never emit a 1-element group_ids array. Pad to >= 2 with a reserved,
   * never-written empty sentinel group. The decorator then clones onto the real
   * graph (hits) and the empty sentinel graph (nothing) and merges -> exactly
   * the real results. The sentinel must be DISTINCT (not a duplicate of the real
   * id): the decorator does not dedupe its input, so padding with the same id
   * would double every hit. Harmless on Neo4j (the extra id just matches
   * nothing). Logical/display group ids (readGroupIds) stay unpadded.
   */
  private padGroupIds(ids: string[]): string[] {
    const unique = [...new Set(ids)];
    if (unique.length >= 2) return unique;
    const sentinel = `${this.options.groupId}__pg_empty`;
    return unique[0] === sentinel
      ? [unique[0], `${sentinel}_2`]
      : [...unique, sentinel];
  }

  /** Padded read group ids for on-the-wire search/clear calls (see #1161). */
  private queryGroupIds(scope: GraphScope = "both"): string[] {
    return this.padGroupIds(this.readGroupIds(scope));
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
    scope?: GraphScope;
  }): Promise<McpToolCallResult> {
    return this.client.callTool("add_memory", {
      name: args.name,
      episode_body: args.body,
      group_id: this.writeGroupId(args.scope ?? "project"),
      source: args.source ?? "text",
      ...(args.sourceDescription ? { source_description: args.sourceDescription } : {}),
    });
  }

  /**
   * Add an episode into an EXPLICIT group id (bypasses scope->group mapping).
   * Used by the load/import path so episodes are restored into the very group
   * they were dumped from, regardless of the current project scope.
   */
  async addEpisodeToGroup(args: {
    name: string;
    body: string;
    groupId: string;
    source?: "text" | "message" | "json";
    sourceDescription?: string;
  }): Promise<McpToolCallResult> {
    return this.client.callTool("add_memory", {
      name: args.name,
      episode_body: args.body,
      group_id: args.groupId,
      source: args.source ?? "text",
      ...(args.sourceDescription ? { source_description: args.sourceDescription } : {}),
    });
  }

  async searchNodes(query: string, maxNodes = 5, scope: GraphScope = "both"): Promise<GraphitiSearchHit[]> {
    if (!hasSearchableTerms(query)) return [];
    const res = await this.client.callTool("search_nodes", {
      query,
      group_ids: this.queryGroupIds(scope),
      max_nodes: maxNodes,
    });
    return parseSearchNodes(res.text);
  }

  async searchFacts(query: string, maxFacts = 5, scope: GraphScope = "both"): Promise<GraphitiSearchHit[]> {
    if (!hasSearchableTerms(query)) return [];
    const res = await this.client.callTool("search_memory_facts", {
      query,
      group_ids: this.queryGroupIds(scope),
      max_facts: maxFacts,
    });
    return parseSearchFacts(res.text);
  }

  async getEpisodes(lastN = 5, scope: GraphScope = "project"): Promise<GraphitiSearchHit[]> {
    const res = await this.client.callTool("get_episodes", {
      group_id: this.writeGroupId(scope),
      last_n: lastN,
    });
    return parseEpisodes(res.text);
  }

  async clearGraph(scope: GraphScope = "project"): Promise<McpToolCallResult> {
    // Padded for #1161 parity; the empty sentinel graph clears to a no-op.
    return this.client.callTool("clear_graph", {
      group_ids: this.queryGroupIds(scope),
    });
  }

  /**
   * Every distinct group id this backend knows about: the global group plus the
   * per-project group when scoping is on and a project is active. Deduped.
   * Used by the dump/export path so a revert-to-flat-files captures both buckets.
   */
  allGroupIds(): string[] {
    const ids = [this.options.groupId];
    if (this.options.projectGroupId) ids.push(this.options.projectGroupId);
    return [...new Set(ids)];
  }

  /**
   * Dump ALL episodes across every known group (global + project). Episodes are
   * the source-of-truth text the extension pushed; entities/facts are derived
   * from them, so this is the faithful export for reverting to flat files.
   *
   * `get_episodes` takes a single group_id, so we loop. `last_n` is set high to
   * approximate "all"; bump it if a group holds more than that.
   */
  async dumpAllEpisodes(lastN = 10000): Promise<{ groupId: string; episodes: GraphitiSearchHit[] }[]> {
    const out: { groupId: string; episodes: GraphitiSearchHit[] }[] = [];
    for (const groupId of this.allGroupIds()) {
      try {
        const res = await this.client.callTool("get_episodes", {
          group_id: groupId,
          last_n: lastN,
        });
        out.push({ groupId, episodes: parseEpisodes(res.text) });
      } catch {
        // Record the group with an empty list rather than aborting the whole dump.
        out.push({ groupId, episodes: [] });
      }
    }
    return out;
  }
}

/**
 * Build a GraphitiBackend from standalone config, or return null when disabled.
 *
 * @param projectName Active project name (from detectProjectName()). When
 *   project scoping is on and a project is active, a per-project group id is
 *   derived as `<globalGroup>_proj_<sanitizedName>`.
 */
export function buildGraphitiBackend(
  config: GraphitiConfig,
  projectName?: string | null,
): GraphitiBackend | null {
  if (!config.enabled) return null;
  const url = (config.url ?? "").trim() || "http://localhost:8000/mcp/";
  const groupId = sanitizeGroupId(config.groupId);
  const projectScoping = config.projectScoping === true;
  const projectGroupId = computeProjectGroupId(groupId, projectName, projectScoping);
  return new GraphitiBackend({
    url,
    groupId,
    projectGroupId,
    projectScoping,
    timeoutMs: config.toolTimeoutMs ?? 60000,
  });
}

/**
 * Derive a per-project group id from the global group + project name.
 * Returns null when scoping is off or no project is active (callers then fall
 * back to the global group). Sanitized to [A-Za-z0-9_] (FalkorDB constraint)
 * and truncated to 64 chars.
 */
export function computeProjectGroupId(
  globalGroupId: string,
  projectName: string | null | undefined,
  projectScoping: boolean,
): string | null {
  if (!projectScoping) return null;
  const cleanName = (projectName ?? "").replace(/[^A-Za-z0-9_]/g, "");
  if (!cleanName) return null;
  return `${globalGroupId}_proj_${cleanName}`.slice(0, 64);
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
