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

  console.log(`\nPASS: ${passed} scope-padding assertions held.`);
}

main().catch((err) => {
  console.error("\nFAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
