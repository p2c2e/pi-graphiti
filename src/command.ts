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
 *   /graph clear        clear_graph for the configured group id (destructive)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GraphitiBackend } from "./backend.js";
import { agentRoot } from "./project.js";

export function registerGraphitiCommand(
  pi: ExtensionAPI,
  backend: GraphitiBackend | null,
): void {
  pi.registerCommand("graph", {
    description: "Show graphiti graph-memory status, search memory, dump/load episodes, or clear",
    handler: async (args, ctx) => {
      if (!backend) {
        ctx.ui.notify(
          [
            "pi-graphiti is disabled.",
            "",
            "Re-enable via env (PI_GRAPHITI_ENABLED=1) or ~/.pi/agent/pi-graphiti-config.json:",
            "  {",
            "    \"enabled\": true,",
            "    \"url\": \"http://localhost:8000/mcp/\"",
            "  }",
          ].join("\n"),
          "info",
        );
        return;
      }

      const argText = typeof args === "string" ? args : "";
      const argv = argText.trim().split(/\s+/).filter(Boolean);
      const sub = (argv[0] || "").toLowerCase();

      if (sub === "clear") {
        try {
          await backend.clearGraph();
          ctx.ui.notify(`Cleared graphiti group_id="${backend.options.groupId}".`, "info");
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
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
          ctx.ui.notify(
            [
              `Dumped ${total} episode(s) across ${groups.length} group(s) to:`,
              `  ${outPath}`,
              "",
              "To revert to flat-file memory only:",
              "  1. Review/edit the dump and fold useful content into your flat memory.",
              '  2. Set "enabled": false in ~/.pi/agent/pi-graphiti-config.json (or PI_GRAPHITI_ENABLED=0).',
              "  3. (Optional) /graph clear to wipe the graph.",
            ].join("\n"),
            "info",
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
      if (!status.available) {
        lines.push(`Error:    ${status.message}`);
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
      lines.push("Subcommands: /graph search QUERY  |  /graph dump [path]  |  /graph load <path>  |  /graph clear");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

/** Best-effort string field lookup over a raw graphiti object. */
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
