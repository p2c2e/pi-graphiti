/**
 * LLM curation pass for graphiti (the "decide what + at what scope" brain).
 *
 * Instead of dumping a raw conversation snapshot and leaning entirely on
 * graphiti's server-side extraction, this spawns a short-lived child
 * `pi -p` that loads ONLY this extension (so it has the `graph` tool and
 * nothing else) and asks it to review the recent conversation and persist
 * anything genuinely worth remembering, choosing the scope (project vs
 * global) per fact.
 *
 * Fail-quiet: any spawn/timeout/parse failure is swallowed. The next cycle
 * retries; graphiti is an accelerator, never a blocker.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GraphitiConfig } from "./types.js";
import { applyRecentMessageLimit, collectMessageParts } from "./message-parts.js";

const REVIEW_TIMEOUT_MS = 120000;
const MIN_PARTS_TO_REVIEW = 4;

export const GRAPHITI_REVIEW_PROMPT = `You are a memory-curation pass for a persistent temporal knowledge graph. Review the conversation below and persist anything genuinely worth remembering across future sessions, using the \`graph\` tool with action="add".

Decide WHAT is worth saving:
- Durable facts, decisions, entities, relationships, and temporal changes ("X now uses Y", "A depends on B", "we moved Z out of W").
- User preferences, identity, standing instructions, and work style.
- Failures, corrections, conventions, and hard-won insights worth recalling later.
Skip transient chatter, tool noise, restated context, and anything not useful beyond this session.

Decide the SCOPE for each add (choose per fact):
- scope="global": facts that should follow the user across ALL projects (identity, preferences, cross-project conventions, durable general knowledge).
- scope="project" (default): facts specific to THIS project/codebase.

Rules:
- Write one concise episode per distinct fact/topic. Do NOT paste the raw transcript; distill it.
- Prefer a few high-signal adds over many low-signal ones.
- Give each add a short, specific name.
- If nothing is worth saving, reply exactly "Nothing to save." and make no tool calls.

--- Conversation to review ---
`;

/** Resolve this extension's entry point so the child loads only pi-graphiti. */
const OWN_EXTENSION_PATH: string = (() => {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
  } catch {
    return "";
  }
})();

interface PiExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
}

function buildChildArgs(prompt: string, config: GraphitiConfig): string[] {
  // --no-session: don't persist a session for a throwaway review.
  // --no-extensions -e <own>: skip every settings.json plugin; the child only
  //   needs the `graph` tool. Loading the full plugin set wastes tokens/CPU.
  const args = ["-p", "--no-session"];
  const model = config.llmModelOverride?.trim();
  const thinking = config.llmThinkingOverride?.trim() || (model ? "off" : "");
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (OWN_EXTENSION_PATH) args.push("--no-extensions", "-e", OWN_EXTENSION_PATH);
  args.push(prompt);
  return args;
}

/** Windows needs `node <cli.js>`; POSIX can spawn `pi` directly. */
function resolveInvocation(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "pi", args };
  const currentCli = process.argv[1];
  const cliPath =
    currentCli && currentCli.replace(/\\/g, "/").toLowerCase().endsWith("/cli.js") && existsSync(currentCli)
      ? currentCli
      : resolvedInstalledCli();
  if (!cliPath) return { command: "pi", args };
  return { command: process.execPath, args: [cliPath, ...args] };
}

function resolvedInstalledCli(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = join(dirname(entry), "cli.js");
    return existsSync(cli) ? cli : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one curation review over the recent conversation. Fire-and-forget from
 * the caller's perspective; resolves to true when a review ran and reported a
 * save, false otherwise (nothing to save, too short, unavailable, or error).
 */
export async function runGraphitiReview(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: { sessionManager: { getBranch: () => unknown[] } },
  config: GraphitiConfig,
): Promise<boolean> {
  let allParts: string[];
  try {
    allParts = collectMessageParts(ctx.sessionManager.getBranch());
  } catch {
    return false;
  }
  if (allParts.length < MIN_PARTS_TO_REVIEW) return false;

  const parts = applyRecentMessageLimit(allParts, config.reviewRecentMessages);
  const prompt = GRAPHITI_REVIEW_PROMPT + parts.join("\n\n");

  try {
    const { command, args } = resolveInvocation(buildChildArgs(prompt, config));
    const result = (await pi.exec(command, args, { timeout: REVIEW_TIMEOUT_MS })) as PiExecResult;
    if (result.code !== 0 || !result.stdout) return false;
    const out = result.stdout.trim().toLowerCase();
    return out.length > 0 && !out.includes("nothing to save");
  } catch {
    // Best-effort. Next cycle retries.
    return false;
  }
}
