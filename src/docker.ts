/**
 * Cross-platform Docker control for the local graphiti backend stack.
 *
 * Works on macOS, Linux, and WSL/Windows because it shells out to the `docker`
 * CLI directly via `execFile` (no shell, no bash-isms, argument array only).
 * The bash controller `graphiti.sh` in the backend repo is intentionally NOT
 * used here — it is a dev convenience and does not run under native Windows.
 *
 * The stack is a docker compose project named "graphiti" defined by
 * `docker-compose-falkordb.yml` in the backend directory. Services:
 *   - falkordb       (graph store)
 *   - graphiti-mcp   (MCP server; host port from HOST_MCP_PORT, default 8431)
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const COMPOSE_PROJECT = "graphiti";
export const COMPOSE_FILENAME = "docker-compose-falkordb.yml";
export const MCP_SERVICE = "graphiti-mcp";

export interface DockerRunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the `docker` binary itself could not be found/spawned. */
  spawnError?: boolean;
}

/**
 * Run `docker <args>` without a shell. Never rejects — failures come back as
 * `{ ok:false }` so callers can branch on the result instead of catching.
 */
export function runDocker(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 20000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = (stdout ?? "").toString();
        const errOut = (stderr ?? "").toString();
        if (err) {
          const spawnError = (err as NodeJS.ErrnoException).code === "ENOENT";
          const code =
            typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code)
              : null;
          resolve({ ok: false, code, stdout: out, stderr: errOut, spawnError });
          return;
        }
        resolve({ ok: true, code: 0, stdout: out, stderr: errOut });
      },
    );
  });
}

export interface DockerProbe {
  /** `docker` binary is on PATH and responds. */
  installed: boolean;
  /** `docker compose` subcommand (v2) is available. */
  composeAvailable: boolean;
  /** Docker daemon/engine is reachable. */
  daemonRunning: boolean;
}

/** Probe the local Docker environment. Cross-platform. */
export async function probeDocker(): Promise<DockerProbe> {
  const version = await runDocker(["version", "--format", "{{.Server.Version}}"]);
  if (version.spawnError) {
    return { installed: false, composeAvailable: false, daemonRunning: false };
  }
  // `docker version` prints client info even when the daemon is down; a
  // non-empty Server.Version (ok exit) means the daemon answered.
  const daemonRunning = version.ok && version.stdout.trim().length > 0;
  const compose = await runDocker(["compose", "version", "--short"]);
  return {
    installed: true,
    composeAvailable: compose.ok,
    daemonRunning,
  };
}

/**
 * Resolve the compose file path from a backend directory. Accepts either the
 * directory itself or a direct path to the compose file. Returns null when no
 * compose file can be found.
 */
export function resolveComposeFile(backendDir: string): string | null {
  const p = path.resolve(backendDir);
  try {
    const stat = fs.statSync(p);
    if (stat.isFile()) return p;
    if (stat.isDirectory()) {
      const candidate = path.join(p, COMPOSE_FILENAME);
      return fs.existsSync(candidate) ? candidate : null;
    }
  } catch {
    return null;
  }
  return null;
}

function composeArgs(composeFile: string, rest: string[]): string[] {
  return ["compose", "-p", COMPOSE_PROJECT, "-f", composeFile, ...rest];
}

export interface StackStatus {
  /** graphiti-mcp service reports a running state. */
  running: boolean;
  /** Raw human-readable summary of `docker compose ps`. */
  detail: string;
}

/** Report whether the graphiti-mcp service is currently running. */
export async function stackStatus(composeFile: string): Promise<StackStatus> {
  const res = await runDocker(
    composeArgs(composeFile, ["ps", "--format", "json"]),
    { cwd: path.dirname(composeFile) },
  );
  if (!res.ok) {
    return { running: false, detail: (res.stderr || res.stdout).trim() || "docker compose ps failed" };
  }
  // `docker compose ps --format json` emits either a JSON array or newline-
  // delimited JSON objects depending on version. Handle both.
  const text = res.stdout.trim();
  const rows: Record<string, unknown>[] = [];
  if (text.startsWith("[")) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) rows.push(...arr);
    } catch {
      /* fall through */
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        /* skip non-JSON line */
      }
    }
  }
  let running = false;
  const summary: string[] = [];
  for (const r of rows) {
    const service = String(r.Service ?? r.Name ?? "");
    const state = String(r.State ?? r.Status ?? "");
    summary.push(`${service}: ${state}`);
    if (service === MCP_SERVICE && /run|up|healthy/i.test(state)) running = true;
  }
  return {
    running,
    detail: summary.length ? summary.join("\n") : "(no containers for project 'graphiti')",
  };
}

/** Start the stack detached (`up -d`). Longer timeout to allow image pulls. */
export function startStack(composeFile: string): Promise<DockerRunResult> {
  return runDocker(composeArgs(composeFile, ["up", "-d"]), {
    cwd: path.dirname(composeFile),
    timeoutMs: 180000,
  });
}

/** Tail the last `tail` lines of the graphiti-mcp service logs. */
export function stackLogs(composeFile: string, tail = 60): Promise<DockerRunResult> {
  return runDocker(
    composeArgs(composeFile, ["logs", "--no-color", "--tail", String(tail), MCP_SERVICE]),
    { cwd: path.dirname(composeFile), timeoutMs: 20000 },
  );
}

/**
 * Tear down the stack (`down`). Stops and removes the project's containers and
 * network. Volumes are preserved unless `removeVolumes` is set (graph data lives
 * in a bind mount / named volume, so default keeps it).
 */
export function stackDown(
  composeFile: string,
  removeVolumes = false,
): Promise<DockerRunResult> {
  const rest = removeVolumes ? ["down", "-v"] : ["down"];
  return runDocker(composeArgs(composeFile, rest), {
    cwd: path.dirname(composeFile),
    timeoutMs: 120000,
  });
}
