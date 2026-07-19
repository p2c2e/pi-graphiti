/**
 * Config loader for pi-graphiti.
 *
 * Precedence (highest first):
 *   1. Environment variables (PI_GRAPHITI_*)
 *   2. ~/.pi/agent/pi-graphiti-config.json
 *   3. Defaults
 *
 * Designed so that simply installing the extension works out of the box
 * against a default local graphiti MCP server (http://localhost:8000/mcp/).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { GraphitiConfig } from "./types.js";

export const DEFAULT_URL = "http://localhost:8000/mcp/";
export const DEFAULT_TOOL_TIMEOUT_MS = 60000;
export const DEFAULT_NUDGE_INTERVAL = 10;
export const DEFAULT_FLUSH_MIN_TURNS = 6;

function configPath(): string {
  return (
    process.env.PI_GRAPHITI_CONFIG ||
    path.join(os.homedir(), ".pi", "agent", "pi-graphiti-config.json")
  );
}

function readJsonSafe(p: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function pick<T>(value: unknown, fallback: T): T {
  return value === undefined || value === null ? fallback : (value as T);
}

export function loadConfig(): GraphitiConfig {
  const file = readJsonSafe(configPath());

  return {
    enabled: envBool(
      "PI_GRAPHITI_ENABLED",
      pick<boolean>(file.enabled, true),
    ),
    url: envStr(
      "PI_GRAPHITI_URL",
      pick<string>(file.url, DEFAULT_URL),
    ),
    groupId: envStr(
      "PI_GRAPHITI_GROUP_ID",
      pick<string>(file.groupId, ""),
    ),
    toolTimeoutMs: envInt(
      "PI_GRAPHITI_TIMEOUT_MS",
      pick<number>(file.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS),
    ),
    projectScoping: envBool(
      "PI_GRAPHITI_PROJECT_SCOPING",
      pick<boolean>(file.projectScoping, true),
    ),
    injectContext: envBool(
      "PI_GRAPHITI_INJECT_CONTEXT",
      pick<boolean>(file.injectContext, false),
    ),
    nudgeInterval: envInt(
      "PI_GRAPHITI_NUDGE_INTERVAL",
      pick<number>(file.nudgeInterval, DEFAULT_NUDGE_INTERVAL),
    ),
    flushOnCompact: envBool(
      "PI_GRAPHITI_FLUSH_ON_COMPACT",
      pick<boolean>(file.flushOnCompact, true),
    ),
    flushOnShutdown: envBool(
      "PI_GRAPHITI_FLUSH_ON_SHUTDOWN",
      pick<boolean>(file.flushOnShutdown, true),
    ),
    flushMinTurns: envInt(
      "PI_GRAPHITI_FLUSH_MIN_TURNS",
      pick<number>(file.flushMinTurns, DEFAULT_FLUSH_MIN_TURNS),
    ),
    nudgeRecentMessages: envInt(
      "PI_GRAPHITI_NUDGE_RECENT",
      pick<number>(file.nudgeRecentMessages, 0),
    ),
    flushRecentMessages: envInt(
      "PI_GRAPHITI_FLUSH_RECENT",
      pick<number>(file.flushRecentMessages, 0),
    ),
    reviewEnabled: envBool(
      "PI_GRAPHITI_REVIEW_ENABLED",
      pick<boolean>(file.reviewEnabled, true),
    ),
    reviewRecentMessages: envInt(
      "PI_GRAPHITI_REVIEW_RECENT",
      pick<number>(file.reviewRecentMessages, 0),
    ),
    correctionDetection: envBool(
      "PI_GRAPHITI_CORRECTION_DETECTION",
      pick<boolean>(file.correctionDetection, true),
    ),
    llmModelOverride: envStr(
      "PI_GRAPHITI_LLM_MODEL",
      pick<string>(file.llmModelOverride, ""),
    ) || undefined,
    llmThinkingOverride: envStr(
      "PI_GRAPHITI_LLM_THINKING",
      pick<string>(file.llmThinkingOverride, ""),
    ) || undefined,
  };
}
