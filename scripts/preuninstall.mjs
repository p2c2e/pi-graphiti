#!/usr/bin/env node
/**
 * Best-effort npm preuninstall hook for pi-graphiti.
 *
 * Runs on `npm uninstall` (and any installer that honors npm lifecycle
 * scripts). It tears down the local graphiti Docker stack ONLY if `/graph
 * setup` started it (config `startedBySetup === true`); otherwise it leaves a
 * pre-existing / external stack running and prints a message.
 *
 * NOTE: `pi remove` only edits settings and does NOT run npm lifecycle
 * scripts, so the reliable path is the interactive `/graph uninstall` command.
 * This script is a convenience for plain `npm uninstall` and is intentionally
 * dependency-free (reads the JSON config directly, shells out to `docker`).
 *
 * Cross-platform: invokes the `docker` CLI via execFileSync (no shell/bash).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const COMPOSE_PROJECT = "graphiti";
const COMPOSE_FILENAME = "docker-compose-falkordb.yml";

function log(msg) {
  console.log(`[pi-graphiti preuninstall] ${msg}`);
}

function configPath() {
  return (
    process.env.PI_GRAPHITI_CONFIG ||
    path.join(os.homedir(), ".pi", "agent", "pi-graphiti-config.json")
  );
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveComposeFile(dir) {
  try {
    const resolved = path.resolve(expandHome(dir));
    const stat = fs.statSync(resolved);
    if (stat.isFile()) return resolved;
    if (stat.isDirectory()) {
      const candidate = path.join(resolved, COMPOSE_FILENAME);
      return fs.existsSync(candidate) ? candidate : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function main() {
  const cfg = readConfig();

  if (!cfg.startedBySetup) {
    log("stack was not started by /graph setup (already running or external); leaving it running.");
    log("stop it yourself with: docker compose -p graphiti down");
    return;
  }

  const composeFile = cfg.backendDir ? resolveComposeFile(cfg.backendDir) : null;
  if (!composeFile) {
    log(`startedBySetup is set but no compose file found (backendDir=${cfg.backendDir ?? "unset"}); skipping.`);
    log("stop it yourself with: docker compose -p graphiti down");
    return;
  }

  try {
    log("tearing down local graphiti stack: docker compose -p graphiti down");
    execFileSync(
      "docker",
      ["compose", "-p", COMPOSE_PROJECT, "-f", composeFile, "down"],
      { cwd: path.dirname(composeFile), stdio: "inherit", windowsHide: true, timeout: 120000 },
    );
    // Clear the ownership marker.
    try {
      cfg.startedBySetup = false;
      fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    } catch {
      /* best-effort */
    }
    log("stack torn down.");
  } catch (err) {
    log(`teardown failed (leaving as-is): ${err && err.message ? err.message : err}`);
  }
}

// Never fail the uninstall over cleanup.
try {
  main();
} catch (err) {
  log(`unexpected error (ignored): ${err && err.message ? err.message : err}`);
}
