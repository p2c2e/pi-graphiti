/**
 * Project detection — self-contained.
 *
 * A "project" is any working directory that is not the user's home directory.
 * The project name is the directory basename. Used to derive a per-project
 * graphiti group id when project scoping is enabled.
 */

import * as path from "node:path";
import * as os from "node:os";

/**
 * Detect the active project name from the current working directory.
 * Returns null when in the home directory, filesystem root, or otherwise
 * not inside a recognizable project.
 */
export function detectProjectName(cwd?: string): string | null {
  const dir = cwd ?? process.cwd();
  const resolved = path.resolve(dir);
  const resolvedHome = path.resolve(os.homedir());

  if (
    !resolved ||
    resolved === resolvedHome ||
    resolved === resolvedHome + "/" ||
    resolved === "/"
  ) {
    return null;
  }

  const name = path.basename(resolved);
  if (!name || name === "." || name === "..") return null;
  return name;
}

/**
 * Resolve the pi agent root directory, honoring PI_CODING_AGENT_DIR if set.
 * Falls back to ~/.pi/agent. Used as the default output location for dumps.
 */
export function agentRoot(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".pi", "agent");
}
