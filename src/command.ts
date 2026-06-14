/**
 * `/memory-graph` command — inspect & manage the graphiti backend.
 *
 * Usage (typed at the pi prompt):
 *   /memory-graph              status + recent episodes + group_id
 *   /memory-graph search QUERY search_nodes + search_memory_facts
 *   /memory-graph clear        clear_graph for the configured group id (destructive)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GraphitiBackend } from "./backend.js";

export function registerGraphitiCommand(
  pi: ExtensionAPI,
  backend: GraphitiBackend | null,
): void {
  pi.registerCommand("graph", {
    description: "Show graphiti backend status, recent episodes, or search the graph",
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
      lines.push("Subcommands: /graph search QUERY  |  /graph clear");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
