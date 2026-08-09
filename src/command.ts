/**
 * `/graph` command — inspect & manage the graphiti backend.
 *
 * Usage (typed at the pi prompt):
 *   /graph              status + recent episodes + group_id
 *   /graph search QUERY search_nodes + search_memory_facts
 *   /graph dump [path]  export ALL episodes (every group) to a markdown file;
 *                       use before reverting to flat-file memory
 *   /graph load <path>  re-import episodes from a dump file back into the graph
 *                       (into their original group ids)
 *   /graph ingest <path> [global]
 *                       memorize the contents of a text file: chunk it and push
 *                       the chunks as episodes into the current project's graph
 *                       memory (or the global group when "global" is given)
 *   /graph clear        clear_graph for the configured group id (destructive)
 *   /graph spool        show the offline write queue (episodes captured while the
 *                       server was down); `drain` replays now, `clear` discards
 *   /graph setup        interactive wizard: set group id + project scoping,
 *                       and configure/start the graphiti backend (local Docker
 *                       stack or an external MCP server). Cross-platform.
 *   /graph uninstall    tear down the local Docker stack, but ONLY if setup
 *                       started it (run before `pi remove`).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { GraphitiBackend } from "./backend.js";
import { buildGraphitiBackend, sanitizeGroupId } from "./backend.js";
import { loadConfig, writeConfigPatch, envShadows } from "./config.js";
import { chunkText } from "./chunk.js";
import {
  stats as spoolStats,
  clear as spoolClear,
  drain as spoolDrain,
  limitsFromConfig as spoolLimits,
  spoolFile as spoolFilePath,
  deadLetterFile as spoolDeadLetterPath,
  type SpoolEntry,
} from "./spool.js";
import { agentRoot, detectProjectName } from "./project.js";
import {
  probeDocker,
  resolveComposeFile,
  stackStatus,
  startStack,
  stackLogs,
  stackDown,
  COMPOSE_FILENAME,
} from "./docker.js";

export function registerGraphitiCommand(
  pi: ExtensionAPI,
  backend: GraphitiBackend | null,
): void {
  pi.registerCommand("graph", {
    description: "Show graphiti graph-memory status, search/ingest memory, dump/load episodes, or clear",
    handler: async (args, ctx) => {
      const argText = typeof args === "string" ? args : "";
      const argv = argText.trim().split(/\s+/).filter(Boolean);
      const sub = (argv[0] || "").toLowerCase();

      // `setup` runs even when the backend is disabled/unconfigured: it is the
      // interactive wizard that (re)writes config to enable and wire a backend.
      if (sub === "setup") {
        await runSetup(ctx);
        return;
      }

      // `uninstall`/`teardown` runs regardless of backend state: it tears down
      // the local Docker stack, but ONLY if /graph setup started it.
      if (sub === "uninstall" || sub === "teardown") {
        await runUninstall(ctx);
        return;
      }

      if (!backend) {
        ctx.ui.notify(
          [
            "pi-graphiti is disabled.",
            "",
            "Run  /graph setup  for an interactive wizard, or enable manually via",
            "env (PI_GRAPHITI_ENABLED=1) or ~/.pi/agent/pi-graphiti-config.json:",
            "  {",
            "    \"enabled\": true,",
            "    \"url\": \"http://localhost:8000/mcp/\"",
            "  }",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (sub === "clear") {
        try {
          await backend.clearGraph();
          // The spool MUST be cleared too: pending episodes would replay on the
          // next healthy cycle and re-populate the graph the user just wiped.
          const dropped = spoolClear();
          ctx.ui.notify(
            [
              `Cleared graphiti group_id="${backend.options.groupId}".`,
              ...(dropped > 0 ? [`Also discarded ${dropped} spooled episode(s) that would have replayed into it.`] : []),
            ].join("\n"),
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`clear_graph failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      if (sub === "dump") {
        const status = await backend.getStatus(true);
        if (!status.available) {
          ctx.ui.notify(`Graphiti unavailable: ${status.message}`, "error");
          return;
        }
        // Optional explicit output path; otherwise timestamped file under the agent root.
        const explicit = argv.slice(1).join(" ").trim();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const outPath = explicit
          ? path.resolve(explicit.replace(/^~(?=$|\/)/, process.env.HOME || "~"))
          : path.join(agentRoot(), `graphiti-dump-${ts}.md`);
        try {
          const groups = await backend.dumpAllEpisodes();
          const lines: string[] = [];
          let total = 0;
          lines.push(`# Graphiti episode dump`);
          lines.push(`# generated: ${new Date().toISOString()}`);
          lines.push(`# url: ${backend.options.url}`);
          lines.push("");
          lines.push("These are the raw episodes (source text) the extension pushed to the");
          lines.push("knowledge graph. Entities/facts are LLM-derived from these, so episodes");
          lines.push("are the faithful export when reverting to flat-file memory only.");
          lines.push("");
          for (const g of groups) {
            lines.push(`## group_id: ${g.groupId}  (${g.episodes.length} episodes)`);
            lines.push("");
            if (g.error) {
              lines.push(`> **READ FAILED for this group: ${g.error}**`);
              lines.push("> This section is INCOMPLETE. Do not treat this dump as a full export.");
              lines.push("");
              continue;
            }
            if (g.episodes.length === 0) {
              lines.push("_(none)_");
              lines.push("");
              continue;
            }
            for (const ep of g.episodes) {
              total++;
              const when = pickField(ep.raw, ["created_at", "createdAt", "valid_at", "reference_time", "timestamp"]);
              lines.push(`### ${ep.label}${when ? `  (${when})` : ""}`);
              if (ep.uuid) lines.push(`<!-- uuid: ${ep.uuid} -->`);
              lines.push("");
              lines.push(ep.summary ? ep.summary.trim() : "_(empty body)_");
              lines.push("");
            }
          }
          // Spooled episodes exist NOWHERE else yet, so a pre-revert export that
          // omitted them would miss exactly the at-risk memory.
          const pendingSpool = readPendingSpoolEntries();
          if (pendingSpool.length > 0) {
            lines.push(`## spool (pending, not yet in the graph)  (${pendingSpool.length} episodes)`);
            lines.push("");
            for (const e of pendingSpool) {
              total++;
              lines.push(`### ${e.name}  (spooled ${new Date(e.ts).toISOString()}, group ${e.groupId})`);
              lines.push("");
              lines.push(e.body.trim() || "_(empty body)_");
              lines.push("");
            }
          }
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
          const failed = groups.filter((g) => g.error);
          ctx.ui.notify(
            [
              ...(failed.length > 0
                ? [
                  `WARNING: ${failed.length} of ${groups.length} group(s) FAILED to read - this dump is INCOMPLETE:`,
                  ...failed.map((g) => `  - ${g.groupId}: ${g.error}`),
                  "Do not revert to flat files based on this export.",
                  "",
                ]
                : []),
              `Dumped ${total} episode(s) across ${groups.length} group(s) to:`,
              `  ${outPath}`,
              "",
              "To revert to flat-file memory only:",
              "  1. Review/edit the dump and fold useful content into your flat memory.",
              '  2. Set "enabled": false in ~/.pi/agent/pi-graphiti-config.json (or PI_GRAPHITI_ENABLED=0).',
              "  3. (Optional) /graph clear to wipe the graph.",
            ].join("\n"),
            failed.length > 0 ? "warning" : "info",
          );
        } catch (err) {
          ctx.ui.notify(`dump failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      if (sub === "load") {
        const explicit = argv.slice(1).join(" ").trim();
        if (!explicit) {
          ctx.ui.notify("Usage: /graph load <path>", "warning");
          return;
        }
        const inPath = path.resolve(explicit.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
        if (!fs.existsSync(inPath)) {
          ctx.ui.notify(`load failed: file not found: ${inPath}`, "error");
          return;
        }
        const status = await backend.getStatus(true);
        if (!status.available) {
          ctx.ui.notify(`Graphiti unavailable: ${status.message}`, "error");
          return;
        }
        try {
          const text = fs.readFileSync(inPath, "utf-8");
          const parsed = parseDump(text);
          if (parsed.length === 0) {
            ctx.ui.notify(
              `No episodes found in ${inPath}. Expected a /graph dump markdown file.`,
              "warning",
            );
            return;
          }
          let ok = 0;
          let fail = 0;
          const groupCount = new Set<string>();
          for (const ep of parsed) {
            groupCount.add(ep.groupId);
            try {
              await backend.addEpisodeToGroup({
                name: ep.name,
                body: ep.body,
                groupId: ep.groupId,
                sourceDescription: `graph load from ${path.basename(inPath)}`,
              });
              ok++;
            } catch {
              fail++;
            }
          }
          ctx.ui.notify(
            [
              `Loaded ${ok} episode(s) across ${groupCount.size} group(s) from:`,
              `  ${inPath}`,
              fail > 0 ? `  (${fail} failed to import)` : "",
              "",
              "Episodes are re-queued for async entity/fact extraction; the graph",
              "may take 30-90s to reflect them. Note: re-loading a dump creates NEW",
              "episodes; clear the group first if you want a clean restore.",
            ].filter(Boolean).join("\n"),
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`load failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      if (sub === "ingest") {
        // /graph ingest <path> [global]  — trailing "global" targets the global group.
        const rest = argv.slice(1);
        const scope: "project" | "global" =
          rest.length && rest[rest.length - 1].toLowerCase() === "global" ? "global" : "project";
        const explicit = (scope === "global" ? rest.slice(0, -1) : rest).join(" ").trim();
        if (!explicit) {
          ctx.ui.notify("Usage: /graph ingest <path> [global]", "warning");
          return;
        }
        const inPath = path.resolve(explicit.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
        if (!fs.existsSync(inPath) || !fs.statSync(inPath).isFile()) {
          ctx.ui.notify(`ingest failed: not a file: ${inPath}`, "error");
          return;
        }
        const status = await backend.getStatus(true);
        if (!status.available) {
          ctx.ui.notify(`Graphiti unavailable: ${status.message}`, "error");
          return;
        }
        try {
          const text = fs.readFileSync(inPath, "utf-8");
          if (!text.trim()) {
            ctx.ui.notify(`ingest failed: file is empty: ${inPath}`, "warning");
            return;
          }
          const chunks = chunkText(text, 8000);
          const baseName = path.basename(inPath);
          const pad = String(chunks.length).length;
          let ok = 0;
          let fail = 0;
          for (let i = 0; i < chunks.length; i++) {
            const name =
              chunks.length === 1
                ? baseName
                : `${baseName} [${String(i + 1).padStart(pad, "0")}/${chunks.length}]`;
            try {
              await backend.addEpisode({
                name,
                body: chunks[i],
                scope,
                sourceDescription: `graph ingest from ${baseName}`,
              });
              ok++;
            } catch {
              fail++;
            }
          }
          ctx.ui.notify(
            [
              `Memorized ${ok} chunk(s) from:`,
              `  ${inPath}`,
              `  -> group ${backend.writeGroupId(scope)} (${scope})`,
              fail > 0 ? `  (${fail} chunk(s) failed)` : "",
              "",
              "Entities/facts extract asynchronously; allow ~30-90s before searching.",
            ].filter(Boolean).join("\n"),
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`ingest failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      // `spool` inspects / forces / discards the offline write queue.
      if (sub === "spool") {
        const op = (argv[1] || "").toLowerCase();
        const cfg = loadConfig();
        const before = spoolStats();

        if (op === "clear") {
          if (before.entries === 0) {
            ctx.ui.notify("Spool is already empty.", "info");
            return;
          }
          const confirmed = await ctx.ui.confirm(
            `Discard ${before.entries} spooled episode(s)?`,
            "These episodes were captured while graphiti was unreachable and are NOT in the graph yet. Discarding loses them permanently.",
          );
          if (!confirmed) {
            ctx.ui.notify("Cancelled; spool left intact.", "info");
            return;
          }
          const removed = spoolClear();
          ctx.ui.notify(`Discarded ${removed} spooled episode(s).`, "warning");
          return;
        }

        if (op === "drain") {
          if (before.entries === 0) {
            ctx.ui.notify("Spool is empty; nothing to replay.", "info");
            return;
          }
          const st = await backend.getStatus(true);
          if (!st.available) {
            ctx.ui.notify(
              `Graphiti still unavailable: ${st.message}\n${before.entries} episode(s) stay spooled.`,
              "error",
            );
            return;
          }
          // Force the full backlog, not the per-cycle batch.
          const res = await spoolDrain(backend, spoolLimits(cfg), before.entries);
          const out = [`Replayed ${res.replayed} of ${before.entries} spooled episode(s).`];
          if (res.recovered) out.push(`${res.recovered} recovered from an interrupted drain.`);
          if (res.expired) out.push(`${res.expired} discarded (older than ${cfg.spoolMaxAgeDays} days) - see ${spoolDeadLetterPath()}.`);
          if (res.abandoned) out.push(`${res.abandoned} abandoned (repeatedly rejected) - see ${spoolDeadLetterPath()}.`);
          if (res.requeueFailed) out.push(`WARNING: could not write pending episodes back to disk; they are held in a claim file for recovery.`);
          if (res.remaining) out.push(`${res.remaining} still pending${res.stoppedOn ? `: ${res.stoppedOn}` : ""}.`);
          out.push("Extraction is async; entities/facts appear in 30-90s.");
          ctx.ui.notify(out.join("\n"), res.remaining || res.requeueFailed ? "warning" : "info");
          return;
        }

        const out: string[] = [];
        out.push(`Spool:    ${spoolFilePath()}`);
        out.push(`Pending:  ${before.entries} episode(s), ${(before.bytes / 1024).toFixed(1)} kB`);
        if (before.stranded > 0) {
          out.push(`          (${before.stranded} held in a claim file: a drain in flight, or one that crashed)`);
        }
        if (before.oldestTs) out.push(`Oldest:   ${new Date(before.oldestTs).toISOString()}`);
        if (before.newestTs) out.push(`Newest:   ${new Date(before.newestTs).toISOString()}`);
        if (before.deadLettered > 0) {
          out.push(`Dropped:  ${before.deadLettered} episode(s) recorded in ${spoolDeadLetterPath()}`);
        }
        out.push(`Limits:   ${cfg.spoolMaxEntries} entries / ${(cfg.spoolMaxBytes / (1024 * 1024)).toFixed(0)} MB / ${cfg.spoolMaxAgeDays} days`);
        out.push(`Enabled:  ${cfg.spoolEnabled ? "yes" : "no"}`);
        out.push("");
        out.push("Spooled episodes replay automatically on the next healthy cycle.");
        out.push("/graph spool drain   replay now   |   /graph spool clear   discard");
        ctx.ui.notify(out.join("\n"), "info");
        return;
      }

      if (sub === "search") {
        const query = argv.slice(1).join(" ").trim();
        if (!query) {
          ctx.ui.notify("Usage: /graph search QUERY", "warning");
          return;
        }
        const status = await backend.getStatus(true);
        if (!status.available) {
          ctx.ui.notify(`Graphiti unavailable: ${status.message}`, "error");
          return;
        }
        try {
          const [nodes, facts] = await Promise.all([
            backend.searchNodes(query, 5),
            backend.searchFacts(query, 5),
          ]);
          const lines: string[] = [];
          lines.push(`Query: ${query}`);
          lines.push(`Group: ${backend.options.groupId}`);
          lines.push("");
          lines.push(`Entities (${nodes.length}):`);
          for (const n of nodes) lines.push(`  - ${n.label}${n.summary ? `: ${n.summary.slice(0, 200)}` : ""}`);
          if (nodes.length === 0) lines.push("  (none)");
          lines.push("");
          lines.push(`Facts (${facts.length}):`);
          for (const f of facts) lines.push(`  - ${(f.summary || f.label).slice(0, 240)}`);
          if (facts.length === 0) lines.push("  (none)");
          ctx.ui.notify(lines.join("\n"), "info");
        } catch (err) {
          ctx.ui.notify(`search failed: ${(err as Error).message}`, "error");
        }
        return;
      }

      // Default: status + episodes summary
      const status = await backend.getStatus(true);
      const lines: string[] = [];
      lines.push(`URL:      ${backend.options.url}`);
      lines.push(`Group:    ${backend.options.groupId}`);
      if (backend.options.projectScoping && backend.options.projectGroupId) {
        lines.push(`Project:  ${backend.options.projectGroupId}`);
      }
      lines.push(`Status:   ${status.available ? "ok" : "unavailable"}`);
      if (status.backend) lines.push(`Backend:  ${status.backend}`);
      const spool = spoolStats();
      if (spool.entries > 0) {
        const oldest = spool.oldestTs ? new Date(spool.oldestTs).toISOString() : "?";
        lines.push(`Spool:    ${spool.entries} pending episode(s), oldest ${oldest}`);
        lines.push(`          replayed automatically; "/graph spool drain" to force`);
      }
      if (spool.deadLettered > 0) {
        lines.push(`Dropped:  ${spool.deadLettered} episode(s) in ${spoolDeadLetterPath()} ("/graph spool" for detail)`);
      }
      if (!status.available) {
        lines.push(`Error:    ${status.message}`);
        if (typeof status.consecutiveFailures === "number" && status.consecutiveFailures > 0) {
          lines.push(
            `Breaker:  ${status.consecutiveFailures} consecutive failure(s), next probe allowed in ${Math.round((status.retryAfterMs ?? 0) / 1000)}s`,
          );
        }
        ctx.ui.notify(lines.join("\n"), "warning");
        return;
      }
      try {
        const eps = await backend.getEpisodes(5);
        lines.push("");
        lines.push(`Recent episodes (${eps.length}):`);
        if (eps.length === 0) {
          lines.push("  (none — episodes are extracted asynchronously; check back in 30-90s)");
        } else {
          for (const ep of eps) {
            lines.push(`  - ${ep.label}${ep.summary ? `\n      ${ep.summary.slice(0, 200)}` : ""}`);
          }
        }
      } catch (err) {
        lines.push(`get_episodes failed: ${(err as Error).message}`);
      }
      lines.push("");
      lines.push("Subcommands: /graph setup  |  /graph search QUERY  |  /graph ingest <path> [global]  |  /graph dump [path]  |  /graph load <path>  |  /graph clear  |  /graph uninstall");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

/**
 * Interactive `/graph setup` wizard. Captures group id + project scoping and
 * configures the backend (local Docker stack or external MCP server), then
 * writes ~/.pi/agent/pi-graphiti-config.json. Option A: changes take effect
 * after restarting pi (the backend is built once at extension init).
 *
 * Cross-platform: all Docker actions go through the `docker` CLI (see
 * docker.ts), so this works on macOS, Linux, and WSL/Windows.
 */
async function runSetup(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  const cfg = loadConfig();
  const projectName = detectProjectName();

  const LOCAL_DOCKER_URL = "http://localhost:8431/mcp/";
  const EXTERNAL_DEFAULT = cfg.url || "http://localhost:8000/mcp/";

  // --- 1. group id ---------------------------------------------------------
  const gidRaw = await ui.input(
    "Graphiti group id (top-level namespace for your memory)",
    cfg.groupId || "",
  );
  if (gidRaw === undefined) {
    ui.notify("Setup cancelled.", "info");
    return;
  }
  const groupId = sanitizeGroupId(gidRaw);
  if (gidRaw.trim() && groupId !== gidRaw.trim()) {
    ui.notify(
      `group id sanitized to "${groupId}" (FalkorDB search treats - and other`
        + ` symbols as operators; only [A-Za-z0-9_] is kept).`,
      "warning",
    );
  }

  // --- 2. project scoping --------------------------------------------------
  const SCOPE_PER_PROJECT = "Per-project + global (recommended)";
  const SCOPE_SINGLE = "Single shared bucket";
  const scopeChoice = await ui.select(
    "How should memory be scoped?",
    [SCOPE_PER_PROJECT, SCOPE_SINGLE],
  );
  if (scopeChoice === undefined) {
    ui.notify("Setup cancelled.", "info");
    return;
  }
  const projectScoping = scopeChoice === SCOPE_PER_PROJECT;

  // --- 3. backend ----------------------------------------------------------
  const BACKEND_DOCKER = "Set up a NEW local Docker stack (FalkorDB + Graphiti MCP)";
  const BACKEND_EXTERNAL = "Point at an EXISTING MCP server I manage (own docker/remote URL)";
  const BACKEND_KEEP = `Keep current URL (${cfg.url})`;
  const backendChoice = await ui.select(
    "Which graphiti backend?",
    [BACKEND_DOCKER, BACKEND_EXTERNAL, BACKEND_KEEP],
  );
  if (backendChoice === undefined) {
    ui.notify("Setup cancelled.", "info");
    return;
  }

  let url = cfg.url;
  let backendDir: string | undefined = cfg.backendDir;
  // Ownership marker: only true when THIS wizard starts the stack, so
  // /graph uninstall never tears down a pre-existing/foreign instance.
  let startedBySetup = cfg.startedBySetup ?? false;

  if (backendChoice === BACKEND_DOCKER) {
    const probe = await probeDocker();
    if (!probe.installed) {
      ui.notify(
        [
          "Docker was not found on PATH.",
          "Install Docker Desktop (macOS/Windows) or the Docker engine (Linux),",
          "then re-run /graph setup. Falling back to external-URL configuration.",
        ].join("\n"),
        "warning",
      );
      url = await promptExternalUrl(ui, EXTERNAL_DEFAULT) ?? url;
    } else {
      if (!probe.daemonRunning) {
        ui.notify(
          "Docker is installed but the daemon is not responding. Start Docker"
            + " Desktop / the docker engine, then continue.",
          "warning",
        );
      }
      // Ask for the backend directory holding the compose file.
      const dirRaw = await ui.input(
        `Path to graphiti backend dir (contains ${COMPOSE_FILENAME})`,
        cfg.backendDir || "",
      );
      if (dirRaw === undefined) {
        ui.notify("Setup cancelled.", "info");
        return;
      }
      const dir = expandHome(dirRaw.trim());
      const composeFile = dir ? resolveComposeFile(dir) : null;
      if (!composeFile) {
        ui.notify(
          [
            dir
              ? `No ${COMPOSE_FILENAME} found at: ${dir}`
              : "No backend directory provided.",
            "Skipping Docker control; configuring an external URL instead.",
          ].join("\n"),
          "warning",
        );
        url = await promptExternalUrl(ui, EXTERNAL_DEFAULT) ?? url;
      } else {
        backendDir = dir;
        // Local stack URL (backend defaults to host port 8431).
        const urlRaw = await ui.input(
          "Local MCP server URL",
          cfg.url && cfg.url.includes("localhost") ? cfg.url : LOCAL_DOCKER_URL,
        );
        url = (urlRaw && urlRaw.trim()) || LOCAL_DOCKER_URL;

        // URL-first check: if something is ALREADY answering at the chosen URL
        // (this stack, a foreign container, sandbox, etc.), never try to start —
        // a start would only race the existing port binding. Fall back to the
        // compose-project status check only when the URL is dead.
        const reachable = await isUrlReachable(
          { ...cfg, enabled: true, url, groupId, projectScoping },
          projectName,
        );

        if (reachable) {
          ui.notify(`An MCP server is already reachable at ${url}; skipping start.`, "info");
        } else {
          const status = await stackStatus(composeFile);
          ui.notify(`URL not reachable yet. Current stack:\n${status.detail}`, "info");

          if (!status.running) {
            const doStart = await ui.confirm(
              "Start the local graphiti stack now?",
              "Runs: docker compose -p graphiti up -d (may pull images on first run).",
            );
            if (doStart) {
              ui.notify("Starting stack (this can take a while on first run)...", "info");
              const res = await startStack(composeFile);
              if (res.ok) {
                startedBySetup = true;
                ui.notify("docker compose up -d completed.", "info");
              } else {
                ui.notify(
                  `Start failed:\n${(res.stderr || res.stdout).trim().slice(0, 1200)}`,
                  "error",
                );
              }
            }
          } else {
            // Compose says graphiti-mcp is up but the URL did not answer — likely
            // a wrong URL/port or the server is still warming up.
            ui.notify(
              "The graphiti-mcp container is running but the URL above did not"
                + " respond. Double-check the host/port, or wait ~30-90s for warmup.",
              "warning",
            );
          }
        }

        // Offer logs regardless (useful whether or not we just started it).
        const showLogs = await ui.confirm(
          "Show recent graphiti-mcp logs?",
          "Tails the last 60 log lines of the graphiti-mcp container.",
        );
        if (showLogs) {
          const logs = await stackLogs(composeFile, 60);
          const body = (logs.stdout || logs.stderr).trim();
          ui.notify(body ? body.slice(-4000) : "(no logs)", "info");
        }
      }
    }
  } else if (backendChoice === BACKEND_EXTERNAL) {
    url = await promptExternalUrl(ui, EXTERNAL_DEFAULT) ?? url;
  }
  // BACKEND_KEEP: leave url/backendDir as-is.

  // --- 4. validate ---------------------------------------------------------
  let available = false;
  try {
    const temp = buildGraphitiBackend(
      { ...cfg, enabled: true, url, groupId, projectScoping },
      projectName,
    );
    if (temp) {
      const st = await temp.getStatus(true);
      available = st.available;
      ui.notify(
        available
          ? `Backend reachable at ${url}${st.backend ? ` (${st.backend})` : ""}.`
          : `Backend NOT reachable at ${url}: ${st.message}`,
        available ? "info" : "warning",
      );
    }
  } catch (err) {
    ui.notify(`Validation error: ${(err as Error).message}`, "warning");
  }
  if (!available) {
    const saveAnyway = await ui.confirm(
      "Save this configuration anyway?",
      "The server may still be starting up (entity extraction warms up over ~30-90s).",
    );
    if (!saveAnyway) {
      ui.notify("Setup cancelled; nothing written.", "info");
      return;
    }
  }

  // --- 5. persist (Option A: restart to apply) -----------------------------
  let written: string;
  try {
    written = writeConfigPatch({
      enabled: true,
      url,
      groupId,
      projectScoping,
      backendDir,
      startedBySetup,
    });
  } catch (err) {
    ui.notify(`Failed to write config: ${(err as Error).message}`, "error");
    return;
  }

  const shadows = envShadows(["enabled", "url", "groupId", "projectScoping", "backendDir"]);
  const summary = [
    `Saved configuration to:`,
    `  ${written}`,
    "",
    `  group id        : ${groupId}`,
    `  project scoping : ${projectScoping ? "per-project + global" : "single bucket"}`,
    `  url             : ${url}`,
    backendDir ? `  backend dir     : ${backendDir}` : "",
    "",
    "Restart pi for these settings to take effect.",
  ].filter(Boolean);
  if (shadows.length) {
    summary.push(
      "",
      "WARNING: these environment variables override the config file and will",
      `shadow the saved values until unset: ${shadows.join(", ")}`,
    );
  }
  ui.notify(summary.join("\n"), "info");
}

/**
 * `/graph uninstall` (alias `teardown`). Tears down the local Docker stack, but
 * ONLY if `/graph setup` started it (config `startedBySetup === true`). A
 * pre-existing / externally started stack is left running, with a message.
 *
 * Intended to be run BEFORE `pi remove` (pi package removal only edits
 * settings; it does not run any extension teardown hook).
 */
async function runUninstall(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  const cfg = loadConfig();

  if (!cfg.startedBySetup) {
    ui.notify(
      [
        "Skipping Docker teardown: the graphiti stack was not started by",
        "/graph setup (it was already running or is external).",
        "",
        "Leaving it running. To stop it yourself:",
        "  docker compose -p graphiti down",
        "",
        "Then run  pi remove  to uninstall the package.",
      ].join("\n"),
      "info",
    );
    return;
  }

  const composeFile = cfg.backendDir ? resolveComposeFile(expandHome(cfg.backendDir)) : null;
  if (!composeFile) {
    ui.notify(
      [
        "startedBySetup is set, but no compose file could be resolved from",
        `backendDir=${cfg.backendDir ?? "(unset)"}.`,
        "Cannot tear down automatically. Stop it manually if needed:",
        "  docker compose -p graphiti down",
      ].join("\n"),
      "warning",
    );
    return;
  }

  const confirmed = await ui.confirm(
    "Tear down the local graphiti Docker stack?",
    "Runs: docker compose -p graphiti down (containers + network; graph data volume is kept).",
  );
  if (!confirmed) {
    ui.notify("Teardown cancelled; stack left running.", "info");
    return;
  }

  ui.notify("Stopping stack...", "info");
  const res = await stackDown(composeFile, false);
  if (!res.ok) {
    ui.notify(
      `Teardown failed:\n${(res.stderr || res.stdout).trim().slice(0, 1200)}`,
      "error",
    );
    return;
  }

  // Clear the ownership marker so a later re-run does not try to tear down again.
  try {
    writeConfigPatch({ startedBySetup: false });
  } catch {
    /* best-effort */
  }
  ui.notify(
    [
      "Stack torn down (docker compose -p graphiti down).",
      "",
      "Now run  pi remove  to uninstall the package.",
    ].join("\n"),
    "info",
  );
}

/** Prompt for an external MCP URL, returning undefined only on cancel. */
async function promptExternalUrl(
  ui: ExtensionCommandContext["ui"],
  fallback: string,
): Promise<string | undefined> {
  const raw = await ui.input("Existing Graphiti MCP server URL (e.g. http://localhost:8431/mcp/)", fallback);
  if (raw === undefined) return undefined;
  return (raw && raw.trim()) || fallback;
}

/**
 * True when a graphiti MCP server already answers at the config's URL.
 * Builds a throwaway backend and health-checks it; never throws.
 */
async function isUrlReachable(
  cfg: Parameters<typeof buildGraphitiBackend>[0],
  projectName: string | null,
): Promise<boolean> {
  try {
    const temp = buildGraphitiBackend(cfg, projectName);
    if (!temp) return false;
    const st = await temp.getStatus(true);
    return st.available;
  } catch {
    return false;
  }
}

/** Expand a leading ~ to the user's home directory. */
function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Best-effort string field lookup over a raw graphiti object. */
/**
 * Read pending spool entries for inclusion in `/graph dump`. These episodes are
 * not in the graph yet, so an export that omitted them would miss exactly the
 * memory that exists in only one place.
 */
function readPendingSpoolEntries(): SpoolEntry[] {
  const out: SpoolEntry[] = [];
  for (const file of [spoolFilePath(), spoolDeadLetterPath()]) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t) as SpoolEntry;
          if (e && typeof e.body === "string" && typeof e.name === "string") out.push(e);
        } catch { /* skip torn line */ }
      }
    } catch { /* unreadable; skip */ }
  }
  return out;
}

function pickField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

interface ParsedEpisode {
  groupId: string;
  name: string;
  body: string;
}

/**
 * Parse a `/graph dump` markdown file back into episodes. Mirrors the writer in
 * the dump handler:
 *   ## group_id: <id>  (N episodes)
 *   ### <label>  (<when>)
 *   <!-- uuid: <uuid> -->
 *   <body lines...>
 * The body runs until the next `### ` or `## group_id:` header (or EOF). The
 * uuid comment and the trailing `(<when>)` on the label are metadata we drop;
 * add_memory assigns fresh uuids/timestamps on import. Empty-body placeholders
 * emitted by the dumper are skipped.
 */
export function parseDump(text: string): ParsedEpisode[] {
  const lines = text.split(/\r?\n/);
  const episodes: ParsedEpisode[] = [];
  let groupId: string | null = null;
  let name: string | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (name !== null && groupId) {
      const body = bodyLines.join("\n").trim();
      if (body && body !== "_(empty body)_") {
        episodes.push({ groupId, name, body });
      }
    }
    name = null;
    bodyLines = [];
  };

  for (const line of lines) {
    const groupMatch = /^##\s+group_id:\s*(.+?)\s*(?:\(\d+\s+episodes?\))?\s*$/.exec(line);
    if (groupMatch) {
      flush();
      groupId = groupMatch[1].trim();
      continue;
    }
    const epMatch = /^###\s+(.*)$/.exec(line);
    if (epMatch) {
      flush();
      // Strip a trailing "  (timestamp)" suffix appended by the dumper.
      name = epMatch[1].replace(/\s+\([^()]*\)\s*$/, "").trim() || epMatch[1].trim();
      continue;
    }
    if (name === null) continue; // skip file header / preamble
    if (/^<!--\s*uuid:.*-->\s*$/.test(line)) continue; // drop uuid metadata
    bodyLines.push(line);
  }
  flush();
  return episodes;
}
