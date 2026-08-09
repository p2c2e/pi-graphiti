/**
 * Regression test for MCP outage resilience (docs/design/outage-resilience.md).
 *
 * Asserts the three landed protections:
 *   1. health probes run on the small `statusTimeoutMs` budget, NOT `toolTimeoutMs`
 *   2. getStatus() is self-bounded (returns within its own deadline against a
 *      server that accepts the socket and never answers) and dedupes concurrent
 *      probes
 *   6. failed probes back off exponentially (5s/15s/60s/300s) instead of
 *      re-probing every 30s forever; a success resets the breaker; `force`
 *      bypasses the backoff window
 *
 * No graphiti server required: deterministic cases use a stubbed MCP client, the
 * timing case uses a local HTTP server that deliberately never responds.
 *
 * Run: npx tsx scripts/test-resilience.ts   (or: npm run test:resilience)
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { GraphitiBackend } from "../src/backend.js";
import { DEFAULT_STATUS_TIMEOUT_MS } from "../src/config.js";

const WORK_TIMEOUT_MS = 60000;
const PROBE_TIMEOUT_MS = 400;

type StubCall = { name: string; timeoutMs?: number };

/** Backend with a stubbed client whose `get_status` outcome is caller-controlled. */
function stubBackend(outcome: (callNo: number) => "ok" | "fail") {
  const backend = new GraphitiBackend({
    groupId: "pg",
    projectGroupId: null,
    projectScoping: false,
    url: "http://127.0.0.1:1/mcp/",
    timeoutMs: WORK_TIMEOUT_MS,
    statusTimeoutMs: PROBE_TIMEOUT_MS,
  });
  const calls: StubCall[] = [];
  let resets = 0;
  (backend as unknown as { client: unknown }).client = {
    async callTool(name: string, _args: unknown, opts?: { timeoutMs?: number }) {
      calls.push({ name, timeoutMs: opts?.timeoutMs });
      if (outcome(calls.length) === "fail") throw new Error("stub: connection refused");
      return { text: JSON.stringify({ status: "ok", message: "FalkorDB" }) };
    },
    reset() { resets++; },
  };
  return { backend, calls, resets: () => resets };
}

/** Pretend `ms` milliseconds have elapsed since the last probe. */
function ageCache(backend: GraphitiBackend, ms: number): void {
  const b = backend as unknown as { statusCheckedAt: number };
  b.statusCheckedAt = Date.now() - ms;
}

function failureCount(backend: GraphitiBackend): number {
  return (backend as unknown as { consecutiveFailures: number }).consecutiveFailures;
}

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`  ok: ${label}`);
}

// ---------------------------------------------------------------------------
// Item 1: probes use the probe budget, real work uses the work budget.
// ---------------------------------------------------------------------------
async function testProbeBudget() {
  const { backend, calls } = stubBackend(() => "ok");
  await backend.getStatus();
  assert.equal(calls.length, 1, "expected one get_status call");
  assert.equal(calls[0].name, "get_status");
  assert.equal(
    calls[0].timeoutMs,
    PROBE_TIMEOUT_MS,
    `get_status must run on the probe budget, got ${String(calls[0].timeoutMs)}`,
  );
  ok(`get_status uses statusTimeoutMs (${PROBE_TIMEOUT_MS}ms), not toolTimeoutMs (${WORK_TIMEOUT_MS}ms)`);

  await backend.addEpisode({ name: "n", body: "b" });
  const write = calls.find((c) => c.name === "add_memory");
  assert.ok(write, "expected an add_memory call");
  assert.equal(
    write!.timeoutMs,
    undefined,
    "real work must NOT be narrowed to the probe budget (no per-call override)",
  );
  ok("add_memory keeps the generous client default (no probe budget leak)");

  assert.equal(
    DEFAULT_STATUS_TIMEOUT_MS < WORK_TIMEOUT_MS,
    true,
    "default probe budget must be far below the work budget",
  );
  ok(`default probe budget ${DEFAULT_STATUS_TIMEOUT_MS}ms << work budget`);
}

// ---------------------------------------------------------------------------
// Item 2: getStatus is self-bounded and dedupes concurrent probes.
// ---------------------------------------------------------------------------
async function testSelfBoundedAgainstHang() {
  const sockets: Socket[] = [];
  let connections = 0;
  const server = http.createServer(() => {
    // Deliberately never respond: this is the "hung server" failure mode that
    // used to cost the full 60s work timeout on an awaited turn_end.
  });
  server.on("connection", (s) => { connections++; sockets.push(s); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const backend = new GraphitiBackend({
      groupId: "pg",
      projectGroupId: null,
      projectScoping: false,
      url: `http://127.0.0.1:${port}/mcp/`,
      timeoutMs: WORK_TIMEOUT_MS,
      statusTimeoutMs: PROBE_TIMEOUT_MS,
    });

    const started = Date.now();
    const [a, b, c] = await Promise.all([
      backend.getStatus(),
      backend.getStatus(),
      backend.getStatus(),
    ]);
    const elapsed = Date.now() - started;

    for (const st of [a, b, c]) {
      assert.equal(st.available, false, "a hung server must report unavailable");
    }
    assert.ok(
      elapsed < 5000,
      `getStatus must be bounded by its own deadline, took ${elapsed}ms (work timeout is ${WORK_TIMEOUT_MS}ms)`,
    );
    ok(`hung server: 3 concurrent getStatus resolved unavailable in ${elapsed}ms (< 5s, not 60s)`);

    assert.equal(
      connections,
      1,
      `concurrent callers must share one in-flight probe, opened ${connections} connections`,
    );
    ok("concurrent callers shared a single in-flight probe");

    // The provisional/authoritative cache entry must be populated, so a caller
    // arriving right after does not open another socket.
    await backend.getStatus();
    assert.equal(connections, 1, "post-deadline caller must hit the cache, not re-probe");
    ok("post-deadline caller short-circuited on the cached failure (no probe pileup)");
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testRefusedIsFast() {
  const backend = new GraphitiBackend({
    groupId: "pg",
    projectGroupId: null,
    projectScoping: false,
    url: "http://127.0.0.1:1/mcp/",
    timeoutMs: WORK_TIMEOUT_MS,
    statusTimeoutMs: PROBE_TIMEOUT_MS,
  });
  const started = Date.now();
  const st = await backend.getStatus();
  const elapsed = Date.now() - started;
  assert.equal(st.available, false);
  assert.ok(elapsed < 2000, `refused connection should fail fast, took ${elapsed}ms`);
  ok(`closed port: unavailable in ${elapsed}ms`);
}

// ---------------------------------------------------------------------------
// Item 6: exponential failure backoff, breaker reset, force bypass.
// ---------------------------------------------------------------------------
async function testFailureBackoff() {
  const { backend, calls, resets } = stubBackend(() => "fail");

  const first = await backend.getStatus();
  assert.equal(first.available, false);
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.retryAfterMs, 5000, "first failure should retry after 5s");
  ok("failure 1 -> retryAfterMs 5000");

  // Inside the 5s window: cached, no new probe.
  ageCache(backend, 4000);
  await backend.getStatus();
  assert.equal(calls.length, 1, "probe inside the backoff window must be suppressed");
  ok("probe suppressed inside the 5s backoff window");

  // Past the 5s window: re-probe, escalate.
  ageCache(backend, 6000);
  const second = await backend.getStatus();
  assert.equal(calls.length, 2, "probe past the backoff window must run");
  assert.equal(second.retryAfterMs, 15000, "second failure should retry after 15s");
  ok("failure 2 -> retryAfterMs 15000 (window elapsed, escalated)");

  ageCache(backend, 20000);
  const third = await backend.getStatus();
  assert.equal(third.retryAfterMs, 60000);
  ok("failure 3 -> retryAfterMs 60000");

  // Regression: the OLD flat 30s TTL would have re-probed here. It must not.
  const callsBefore = calls.length;
  ageCache(backend, 31000);
  await backend.getStatus();
  assert.equal(
    calls.length,
    callsBefore,
    "at failure 3 the backoff is 60s; a 31s-old cache entry must NOT trigger a probe (flat-30s-TTL regression)",
  );
  ok("31s-old failure cache no longer re-probes (flat 30s TTL regression guarded)");

  ageCache(backend, 61000);
  const fourth = await backend.getStatus();
  assert.equal(fourth.retryAfterMs, 300000);
  ageCache(backend, 301000);
  const fifth = await backend.getStatus();
  assert.equal(fifth.retryAfterMs, 300000, "backoff must cap, not grow unbounded");
  ok("failure 4+ -> retryAfterMs capped at 300000");

  assert.ok(resets() > 0, "a failed probe must reset the MCP session for a restarted server");
  ok(`failed probes reset the client session (${resets()} resets)`);

  // force must bypass the backoff window entirely (/graph subcommands).
  const callsBeforeForce = calls.length;
  await backend.getStatus(true);
  assert.equal(calls.length, callsBeforeForce + 1, "force must bypass the backoff window");
  ok("getStatus(true) bypasses the backoff window");
}

async function testSuccessResetsBreaker() {
  // Fail the first 3 probes, then succeed.
  const { backend, calls } = stubBackend((n) => (n <= 3 ? "fail" : "ok"));

  await backend.getStatus();
  ageCache(backend, 6000);
  await backend.getStatus();
  ageCache(backend, 20000);
  await backend.getStatus();
  assert.equal(failureCount(backend), 3, "expected a 3-failure streak");

  ageCache(backend, 61000);
  const healthy = await backend.getStatus();
  assert.equal(healthy.available, true, "expected recovery");
  assert.equal(healthy.consecutiveFailures, 0, "success must reset the breaker");
  assert.equal(failureCount(backend), 0);
  ok("success resets the failure streak to 0");

  // Healthy status is trusted for the fixed 30s TTL, not a backoff window.
  const callsBefore = calls.length;
  ageCache(backend, 29000);
  await backend.getStatus();
  assert.equal(calls.length, callsBefore, "healthy status must be cached for 30s");
  ageCache(backend, 31000);
  await backend.getStatus();
  assert.equal(calls.length, callsBefore + 1, "healthy status must expire after 30s");
  ok("healthy status keeps the fixed 30s TTL");
}

async function main() {
  await testProbeBudget();
  await testSelfBoundedAgainstHang();
  await testRefusedIsFast();
  await testFailureBackoff();
  await testSuccessResetsBreaker();
  console.log(`\nPASS: ${passed} outage-resilience assertions held.`);
}

main().catch((err) => {
  console.error("\nFAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
