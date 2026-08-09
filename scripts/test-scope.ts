/**
 * Regression test for FalkorDB #1161 scope padding.
 *
 * Asserts that on-the-wire READ group_ids (search_nodes / search_memory_facts /
 * clear_graph) are NEVER a single-element array, while the logical/display
 * group ids (readGroupIds) stay unpadded. Stubs the MCP client so no server is
 * needed.
 *
 * Run: npx tsx scripts/test-scope.ts   (or: npm run test:scope)
 */

import assert from "node:assert/strict";
import { GraphitiBackend } from "../src/backend.js";

type Call = { name: string; args: Record<string, unknown> };

function makeBackend(opts: {
  groupId: string;
  projectGroupId: string | null;
  projectScoping: boolean;
}) {
  const backend = new GraphitiBackend({
    groupId: opts.groupId,
    projectGroupId: opts.projectGroupId,
    projectScoping: opts.projectScoping,
    url: "http://localhost:0/mcp/",
    timeoutMs: 1000,
  });
  const calls: Call[] = [];
  // Stub the private client so nothing hits the network.
  (backend as unknown as { client: { callTool: unknown } }).client = {
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { text: "[]" };
    },
  };
  return { backend, calls };
}

function groupIdsOf(calls: Call[], toolName: string): string[] {
  const call = calls.find((c) => c.name === toolName);
  assert.ok(call, `expected a ${toolName} call`);
  return call!.args.group_ids as string[];
}

function assertPadded(ids: string[], mustContain: string[], label: string) {
  assert.ok(ids.length >= 2, `${label}: group_ids must be padded to >= 2, got ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, `${label}: group_ids must be distinct (no doubled hits), got ${JSON.stringify(ids)}`);
  for (const id of mustContain) {
    assert.ok(ids.includes(id), `${label}: group_ids must include real id "${id}", got ${JSON.stringify(ids)}`);
  }
}

let passed = 0;
async function scenario(
  label: string,
  opts: { groupId: string; projectGroupId: string | null; projectScoping: boolean },
  scope: "project" | "global" | "both",
  expectReal: string[],
) {
  const { backend, calls } = makeBackend(opts);
  await backend.searchNodes("q", 5, scope);
  await backend.searchFacts("q", 5, scope);
  await backend.clearGraph(scope as never);
  for (const tool of ["search_nodes", "search_memory_facts", "clear_graph"]) {
    assertPadded(groupIdsOf(calls.filter((c) => c.name === tool), tool), expectReal, `${label} / ${tool}`);
  }
  passed++;
  console.log(`  ok: ${label} (scope=${scope}) -> real ids ${JSON.stringify(expectReal)} padded`);
}

async function main() {
  // 1. Standalone (scoping OFF) — single bucket would hit the bug.
  await scenario("standalone scoping-off", { groupId: "pg", projectGroupId: null, projectScoping: false }, "both", ["pg"]);

  // 2. Scoping ON, project active, narrowed to project (1 logical id -> bug).
  await scenario("scoped project", { groupId: "pg", projectGroupId: "pg_proj_x", projectScoping: true }, "project", ["pg_proj_x"]);

  // 3. Scoping ON, narrowed to global (1 logical id -> bug).
  await scenario("scoped global", { groupId: "pg", projectGroupId: "pg_proj_x", projectScoping: true }, "global", ["pg"]);

  // 4. Scoping ON, "both", NO project active -> dedupes to 1 -> bug.
  await scenario("scoped both no-project", { groupId: "pg", projectGroupId: null, projectScoping: true }, "both", ["pg"]);

  // 5. Scoping ON, "both", project active -> already 2 distinct, must pass through unchanged.
  {
    const { backend, calls } = makeBackend({ groupId: "pg", projectGroupId: "pg_proj_x", projectScoping: true });
    await backend.searchNodes("q", 5, "both");
    const ids = groupIdsOf(calls, "search_nodes");
    assert.deepEqual([...ids].sort(), ["pg", "pg_proj_x"], `both/project should be exactly the 2 real ids, got ${JSON.stringify(ids)}`);
    passed++;
    console.log(`  ok: scoped both project-active -> 2 real ids unchanged ${JSON.stringify(ids)}`);
  }

  // 6. Logical/display group ids stay UNPADDED (no sentinel leaks to the LLM).
  {
    const { backend } = makeBackend({ groupId: "pg", projectGroupId: null, projectScoping: false });
    assert.deepEqual(backend.readGroupIds("both"), ["pg"], "readGroupIds must stay logical/unpadded for display");
    passed++;
    console.log(`  ok: readGroupIds stays unpadded for display`);
  }

  // 7. get_episodes must use the MODERN arg shape (group_ids[] + max_episodes),
  //    padded for #1161. Sending the legacy {group_id, last_n} made FastMCP
  //    default group_ids to null, query the empty default_db graph, and return
  //    zero episodes for every read - including /graph dump, which then wrote an
  //    empty "safe to revert" export while reporting success.
  {
    const { backend, calls } = makeBackend({ groupId: "pg", projectGroupId: "pg_proj_x", projectScoping: true });
    await backend.getEpisodes(7, "project");
    const call = calls.find((c) => c.name === "get_episodes");
    assert.ok(call, "expected a get_episodes call");
    const ids = call!.args.group_ids as string[];
    assert.ok(Array.isArray(ids), "get_episodes must send group_ids as an array");
    assert.ok(ids.length >= 2, `get_episodes group_ids must be padded for #1161, got ${JSON.stringify(ids)}`);
    assert.ok(ids.includes("pg_proj_x"), "get_episodes must target the real group");
    assert.equal(call!.args.max_episodes, 7, "get_episodes must send max_episodes");
    assert.equal(call!.args.last_n, undefined, "legacy last_n must not be sent on the modern path");
    passed++;
    console.log(`  ok: get_episodes uses group_ids[]+max_episodes (padded) ${JSON.stringify(ids)}`);
  }

  // 8. Legacy-server fallback: if the modern shape is rejected, retry the old one.
  {
    const backend = new GraphitiBackend({
      groupId: "pg", projectGroupId: null, projectScoping: false,
      url: "http://localhost:0/mcp/", timeoutMs: 1000,
    });
    const seen: Call[] = [];
    (backend as unknown as { client: { callTool: unknown } }).client = {
      async callTool(name: string, args: Record<string, unknown>) {
        seen.push({ name, args });
        if ("group_ids" in args) throw new Error("legacy server: unexpected keyword argument 'group_ids'");
        return { text: "[]" };
      },
    };
    await backend.getEpisodes(3, "project");
    assert.equal(seen.length, 2, "expected a modern attempt then a legacy retry");
    assert.equal(seen[1].args.group_id, "pg", "fallback must send singular group_id");
    assert.equal(seen[1].args.last_n, 3, "fallback must send last_n");
    passed++;
    console.log(`  ok: get_episodes falls back to {group_id,last_n} on older servers`);
  }

  console.log(`\nPASS: ${passed} scope-padding assertions held.`);
}

main().catch((err) => {
  console.error("\nFAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
