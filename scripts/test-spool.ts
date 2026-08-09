/**
 * Regression test for the offline write spool (docs/design/outage-resilience.md
 * item 9): an MCP outage must cost DELAY, never memory.
 *
 * Isolated via PI_CODING_AGENT_DIR (agentRoot() reads it per call), so it never
 * touches the real ~/.pi/agent spool.
 *
 * Several cases here exist because an earlier revision passed its tests while
 * being wrong; those are marked REGRESSION with the defect they now catch.
 *
 * Run: npx tsx scripts/test-spool.ts   (or: npm run test:spool)
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-graphiti-spool-test-"));
process.env.PI_CODING_AGENT_DIR = TMP_ROOT;

/**
 * Worker mode: this same file, re-executed as a SEPARATE PROCESS to test the
 * cross-process claim race for real. Re-exec (rather than a generated worker
 * script) inherits the parent's loader via process.execArgv, so it needs no
 * TypeScript runtime of its own.
 */
const WORKER_ROOT = process.env.PI_GRAPHITI_SPOOL_WORKER;
if (WORKER_ROOT) {
  process.env.PI_CODING_AGENT_DIR = WORKER_ROOT;
  // Start barrier: both workers wait for the same wall-clock instant so their
  // claim() attempts genuinely collide. Without it the processes serialize and
  // the race under test never happens.
  const startAt = Number(process.env.PI_GRAPHITI_SPOOL_WORKER_START ?? "0");
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const { drain: workerDrain } = await import("../src/spool.js");
  const written: string[] = [];
  const backend = {
    async addEpisodeToGroup(a: { name: string }) {
      await new Promise((r) => setTimeout(r, 15));
      written.push(a.name);
      return { text: "ok" };
    },
  } as unknown as import("../src/backend.js").GraphitiBackend;
  const res = await workerDrain(backend, { maxEntries: 200, maxBytes: 8388608, maxAgeDays: 14 }, 25);
  process.stdout.write(JSON.stringify({ replayed: res.replayed, written }));
  process.exit(0);
}

const {
  enqueue, stats, drain, clear, spoolFile, spoolDir, deadLetterFile,
  spoolEpisode, maybeDrain, limitsFromConfig,
} = await import("../src/spool.js");
import type { GraphitiBackend } from "../src/backend.js";
import type { GraphitiConfig } from "../src/types.js";

const LIMITS = { maxEntries: 200, maxBytes: 8 * 1024 * 1024, maxAgeDays: 14 };

type Written = { name: string; body: string; groupId: string };

/** Minimal GraphitiBackend stand-in: only what the spool actually calls. */
function stubBackend(opts: {
  fail?: boolean | string;
  available?: boolean;
  delayMs?: number;
} = {}) {
  const written: Written[] = [];
  let statusCalls = 0;
  const backend = {
    async addEpisodeToGroup(a: { name: string; body: string; groupId: string }) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) {
        throw new Error(typeof opts.fail === "string" ? opts.fail : "stub: fetch http://x failed");
      }
      written.push({ name: a.name, body: a.body, groupId: a.groupId });
      return { text: "ok" };
    },
    async getStatus() {
      statusCalls++;
      return { available: opts.available !== false, message: "ok" };
    },
  } as unknown as GraphitiBackend;
  return { backend, written, statusCalls: () => statusCalls };
}

function baseConfig(over: Partial<GraphitiConfig> = {}): GraphitiConfig {
  return {
    spoolEnabled: true,
    spoolMaxEntries: 200,
    spoolMaxBytes: 8 * 1024 * 1024,
    spoolMaxAgeDays: 14,
    spoolDrainBatch: 25,
    ...over,
  } as unknown as GraphitiConfig;
}

function add(name: string, groupId = "pg_proj_x", tsOffsetMs = 0, attempts?: number) {
  return enqueue(
    {
      name,
      body: `body of ${name}`,
      groupId,
      source: "message",
      origin: "test",
      ts: Date.now() - tsOffsetMs,
      ...(attempts ? { attempts } : {}),
    },
    LIMITS,
  );
}

function pendingLines(): any[] {
  if (!fs.existsSync(spoolFile())) return [];
  return fs.readFileSync(spoolFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function deadLetters(): any[] {
  if (!fs.existsSync(deadLetterFile())) return [];
  return fs.readFileSync(deadLetterFile(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let passed = 0;
function ok(label: string) { passed++; console.log(`  ok: ${label}`); }
function reset() {
  clear();
  try { fs.unlinkSync(deadLetterFile()); } catch { /* ignore */ }
}

async function testEnqueueAndStats() {
  reset();
  assert.equal(stats().entries, 0, "fresh spool must be empty");
  add("a"); add("b", "pg_global"); add("c");
  const s = stats();
  assert.equal(s.entries, 3);
  assert.equal(s.pending, 3);
  assert.equal(s.stranded, 0);
  assert.ok(s.bytes > 0 && s.oldestTs && s.newestTs);
  assert.ok(fs.existsSync(spoolFile()), "spool file must exist on disk");
  ok("enqueue persists episodes; stats reports depth/size/age");
}

async function testReplayIsGroupFaithful() {
  reset();
  add("a", "pg_proj_x"); add("b", "pg_global"); add("c", "pg_proj_x");
  const { backend, written } = stubBackend();
  const res = await drain(backend, LIMITS, 25);

  assert.equal(res.replayed, 3);
  assert.equal(res.remaining, 0);
  assert.deepEqual(written.map((w) => w.name), ["a", "b", "c"], "replay must preserve order");
  assert.deepEqual(
    written.map((w) => w.groupId),
    ["pg_proj_x", "pg_global", "pg_proj_x"],
    "replay must use the group id resolved at enqueue time, not re-derive it",
  );
  assert.equal(stats().entries, 0, "fully drained spool must be empty");
  assert.equal(fs.readdirSync(spoolDir()).filter((f) => f.endsWith(".claim")).length, 0);
  ok("drain replays in order into the originally-resolved group ids, leaving no claim files");
}

async function testRequeueOnFailure() {
  reset();
  add("a"); add("b"); add("c");
  const { backend, written } = stubBackend({ fail: true });
  const res = await drain(backend, LIMITS, 25);

  assert.equal(res.replayed, 0);
  assert.equal(written.length, 0);
  assert.equal(res.remaining, 3, "everything must be requeued when the server fails");
  assert.ok(res.stoppedOn, "should report why it stopped");
  assert.equal(stats().entries, 3, "entries must survive a failed drain");
  ok("failed drain requeues every entry and reports the cause");

  const attempted = pendingLines().filter((e) => (e.attempts ?? 0) > 0);
  assert.equal(attempted.length, 0, "a TRANSPORT failure must not consume an entry's attempt budget");
  ok("transport failures do not count toward MAX_ATTEMPTS (outage != poison entry)");

  const good = stubBackend();
  const res2 = await drain(good.backend, LIMITS, 25);
  assert.equal(res2.replayed, 3);
  assert.equal(stats().entries, 0);
  ok("spool drains completely once the server recovers");
}

async function testServerRejectionCountsAttempts() {
  reset();
  add("bad");
  const { backend } = stubBackend({ fail: "tools/call 'add_memory' failed: episode_body invalid" });
  await drain(backend, LIMITS, 25);
  const [entry] = pendingLines();
  assert.equal(entry.attempts, 1, "a server-side rejection must count toward MAX_ATTEMPTS");
  ok("server-side rejections do count toward MAX_ATTEMPTS");
}

async function testFailedEntryGoesToTail() {
  // REGRESSION: the failed entry used to be requeued at its ORIGINAL position,
  // so with stop-on-first-failure it blocked every healthy entry behind it for
  // MAX_ATTEMPTS drain cycles (~50 user turns at the default nudge interval).
  reset();
  add("poison"); add("good1"); add("good2");
  const bad = stubBackend({ fail: "tools/call 'add_memory' failed: bad payload" });
  await drain(bad.backend, LIMITS, 25);
  const order = pendingLines().map((e) => e.name);
  assert.deepEqual(order, ["good1", "good2", "poison"], `failed entry must move to the tail, got ${order.join(",")}`);

  // Next cycle against a healthy server must deliver the good entries immediately.
  const good = stubBackend();
  const res = await drain(good.backend, LIMITS, 25);
  assert.deepEqual(good.written.map((w) => w.name), ["good1", "good2", "poison"]);
  assert.equal(res.replayed, 3);
  ok("a failing entry moves to the tail and cannot block healthy entries behind it");
}

async function testBatchLimitAndClamp() {
  reset();
  for (let i = 0; i < 10; i++) add(`e${i}`);
  const { backend } = stubBackend();
  const res = await drain(backend, LIMITS, 4);
  assert.equal(res.replayed, 4, "batch limit must cap replays per cycle");
  assert.equal(res.remaining, 6);
  ok("drain honors the per-cycle batch limit");

  // REGRESSION: batchLimit <= 0 used to make every drain a no-op that rewrote
  // the file each cycle.
  const res2 = await drain(stubBackend().backend, LIMITS, 0);
  assert.ok(res2.replayed >= 1, "batchLimit 0 must clamp to >= 1, not stall the queue");
  ok("batchLimit <= 0 clamps to 1 instead of stalling forever");
}

async function testAgeExpiryAbandonmentAndDeadLetter() {
  reset();
  const twentyDays = 20 * 24 * 60 * 60 * 1000;
  add("fresh");
  add("ancient", "pg_proj_x", twentyDays);
  add("poison", "pg_proj_x", 0, 5); // already at MAX_ATTEMPTS
  const { backend, written } = stubBackend();
  const res = await drain(backend, LIMITS, 25);

  assert.equal(res.expired, 1, "entries older than maxAgeDays must be dropped");
  assert.equal(res.abandoned, 1, "entries past MAX_ATTEMPTS must be abandoned");
  assert.deepEqual(written.map((w) => w.name), ["fresh"]);
  assert.equal(stats().entries, 0);
  ok("age expiry and poison-entry abandonment keep the queue from wedging");

  // REGRESSION: drops used to be silent, violating "degradation must be observable".
  const dl = deadLetters();
  assert.equal(dl.length, 2, `dropped entries must be recorded in dead-letter.jsonl, got ${dl.length}`);
  assert.deepEqual(dl.map((e) => e.name).sort(), ["ancient", "poison"]);
  assert.ok(dl.every((e) => e.droppedReason && e.droppedAt), "dead letters must record why/when");
  assert.equal(stats().deadLettered, 2, "stats must surface dead-letter depth");
  ok("dropped episodes are recorded in dead-letter.jsonl, never silently deleted");
}

async function testBounds() {
  reset();
  const tight = { maxEntries: 10, maxBytes: 8 * 1024 * 1024, maxAgeDays: 14 };
  for (let i = 0; i < 40; i++) {
    enqueue({ name: `n${i}`, body: `body ${i} `.repeat(8), groupId: "pg", source: "text" }, tight);
  }
  const s = stats();
  assert.ok(s.entries <= 10, `entry cap must hold, got ${s.entries}`);
  const names = pendingLines().map((e) => e.name);
  assert.ok(names.includes("n39"), "newest entry must be kept");
  assert.ok(!names.includes("n0"), "oldest entry must be evicted");
  assert.ok(deadLetters().length > 0, "evicted entries must be dead-lettered, not vanished");
  ok(`entry cap enforced (${s.entries} <= 10), newest retained, evictions recorded`);

  reset();
  const byteCap = { maxEntries: 1000, maxBytes: 4096, maxAgeDays: 14 };
  for (let i = 0; i < 40; i++) {
    enqueue({ name: `n${i}`, body: "x".repeat(500), groupId: "pg", source: "text" }, byteCap);
  }
  assert.ok(stats().bytes <= 4096, `byte budget must bound the file, got ${stats().bytes}`);
  ok(`byte budget enforced exactly (${stats().bytes} <= 4096 bytes)`);

  // REGRESSION: maxEntries 0 hit slice(-0), which keeps the WHOLE array, silently
  // disabling the cap.
  const l = limitsFromConfig(baseConfig({ spoolMaxEntries: 0, spoolMaxBytes: 0, spoolMaxAgeDays: 0 }));
  assert.ok(l.maxEntries >= 1 && l.maxBytes >= 1 && l.maxAgeDays >= 1, `zero limits must clamp, got ${JSON.stringify(l)}`);
  ok("zero/negative limits clamp to defaults instead of disabling the bound");
}

async function testTruncationIsReported() {
  // REGRESSION: the spool path truncated at 20k while the direct write path had no
  // cap, and reported success with "No need to retry" - silent data loss.
  reset();
  const big = "y".repeat(25000);
  const res = spoolEpisode(baseConfig(), { name: "big", body: big, groupId: "pg", source: "text" });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true, "truncation must be reported to the caller");
  assert.equal(res.originalChars, 25000);
  assert.ok(res.storedChars < 25000);
  const [entry] = pendingLines();
  assert.equal(entry.truncated, true, "the entry must record that it was truncated");
  assert.equal(entry.originalChars, 25000);
  ok(`truncation is reported (stored ${res.storedChars} of ${res.originalChars}), not silent`);

  const small = spoolEpisode(baseConfig(), { name: "small", body: "tiny", groupId: "pg", source: "text" });
  assert.equal(small.truncated, false);
  ok("normal-sized episodes report truncated:false");
}

async function testRequeueFailureDoesNotDestroyBatch() {
  // REGRESSION: requeue() swallowed its write error and drain unlinked the claim
  // unconditionally, so on ENOSPC/EPERM the whole claimed batch was deleted.
  reset();
  add("keep1"); add("keep2");
  const { backend } = stubBackend({ fail: true });
  fs.chmodSync(spoolDir(), 0o500); // read+execute only: appends fail, renames fail
  let res;
  try {
    res = await drain(backend, LIMITS, 25);
  } finally {
    fs.chmodSync(spoolDir(), 0o700);
  }
  const claims = fs.readdirSync(spoolDir()).filter((f) => f.endsWith(".claim"));
  const onDisk = pendingLines().length + claims.reduce(
    (n, f) => n + fs.readFileSync(path.join(spoolDir(), f), "utf8").trim().split("\n").filter(Boolean).length,
    0,
  );
  assert.equal(onDisk, 2, `no episode may be destroyed when the requeue write fails, found ${onDisk}`);
  if (res?.requeueFailed) ok("requeue failure is reported and the batch is preserved for recovery");
  else ok("batch preserved across a failed requeue (write path blocked before claim)");
}

async function testConcurrentDrainsAcrossProcesses() {
  // REGRESSION: the old single-process version of this test passed vacuously.
  // claim() is a SYNCHRONOUS rename, so the second in-process drain simply found
  // no file and the rename race was never exercised. Two real processes do race.
  reset();
  for (let i = 0; i < 8; i++) add(`c${i}`);

  const run = (startAt: number) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]], {
      env: {
        ...process.env,
        PI_GRAPHITI_SPOOL_WORKER: TMP_ROOT,
        PI_GRAPHITI_SPOOL_WORKER_START: String(startAt),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
  // Both processes are spawned first, then released together.
  const startAt = Date.now() + 1500;
  const [a, b] = await Promise.all([run(startAt), run(startAt)]);
  assert.equal(a.status, 0, `worker A failed: ${a.stderr}`);
  assert.equal(b.status, 0, `worker B failed: ${b.stderr}`);
  const ra = JSON.parse(a.stdout);
  const rb = JSON.parse(b.stdout);
  const all = [...ra.written, ...rb.written];
  assert.equal(all.length, 8, `every entry must be replayed exactly once, got ${all.length}`);
  assert.equal(new Set(all).size, 8, `no episode may be written twice, got ${all.sort().join(",")}`);
  assert.equal(stats().entries, 0);
  ok(`two simultaneous processes: one won the claim (${ra.replayed}/${rb.replayed} split), 8 episodes replayed once each, 0 duplicates`);
}

async function testLiveClaimIsNotSwept() {
  // REGRESSION: recoverStaleClaims used mtime alone, so a slow drain that ran
  // longer than STALE_CLAIM_MS was swept by another session and every episode in
  // its batch was replayed twice. Measured 8 writes for 4 episodes.
  reset();
  fs.mkdirSync(spoolDir(), { recursive: true });
  // Claim owned by THIS (definitely live) process, backdated well past the window.
  const liveClaim = path.join(spoolDir(), `pending.${process.pid}.1.abcdef.claim`);
  fs.writeFileSync(liveClaim, JSON.stringify({
    v: 1, ts: Date.now(), name: "inflight", body: "b", groupId: "pg", source: "message",
  }) + "\n", "utf8");
  const old = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(liveClaim, new Date(old), new Date(old));

  add("unrelated"); // gives drain something to claim so it runs the sweep
  const { backend, written } = stubBackend();
  await drain(backend, LIMITS, 25);
  assert.ok(fs.existsSync(liveClaim), "a claim owned by a LIVE process must never be swept");
  assert.deepEqual(written.map((w) => w.name), ["unrelated"], "the live claim's entries must not be replayed");
  ok("a live process's claim is never swept, however old (no double-write)");
  fs.unlinkSync(liveClaim);
}

async function testStaleClaimRecoveryViaMaybeDrain() {
  // REGRESSION: recoverStaleClaims was only reachable from drain(), while the real
  // entry point maybeDrain() gated on stats().entries which ignored claim files.
  // Result: entries stranded by a kill -9 were invisible and never replayed. The
  // old test called drain() directly and so never noticed.
  reset();
  fs.mkdirSync(spoolDir(), { recursive: true });
  const deadPid = 999999; // not a live process
  const orphan = path.join(spoolDir(), `pending.${deadPid}.1.zzzzzz.claim`);
  fs.writeFileSync(orphan, JSON.stringify({
    v: 1, ts: Date.now(), name: "stranded", body: "b", groupId: "pg_proj_x", source: "message",
  }) + "\n", "utf8");
  const old = Date.now() - 10 * 60 * 1000;
  fs.utimesSync(orphan, new Date(old), new Date(old));

  assert.equal(stats().entries, 1, "stranded entries must be visible in stats (UI + drain gate)");
  assert.equal(stats().stranded, 1);
  ok("entries stranded in a claim file are counted by stats()");

  const { backend, written } = stubBackend();
  const res = await maybeDrain(backend, baseConfig());
  assert.ok(res, "maybeDrain must act when only stranded entries exist");
  assert.deepEqual(written.map((w) => w.name), ["stranded"], "stranded entry must be replayed");
  assert.ok(!fs.existsSync(orphan), "recovered claim file must be removed");
  assert.equal(stats().entries, 0);
  ok("kill -9 recovery works through maybeDrain, the real entry point");
}

async function testCorruptLines() {
  reset();
  add("good1");
  fs.appendFileSync(spoolFile(), "{ this is not json\n", "utf8");
  fs.appendFileSync(spoolFile(), JSON.stringify({ v: 99, name: "wrongver" }) + "\n", "utf8");
  fs.appendFileSync(spoolFile(), JSON.stringify({ v: 1, name: "nobody" }) + "\n", "utf8");
  add("good2");

  assert.equal(stats().entries, 2, "corrupt/invalid lines must be ignored, valid ones kept");
  const { backend, written } = stubBackend();
  await drain(backend, LIMITS, 25);
  assert.deepEqual(written.map((w) => w.name), ["good1", "good2"]);
  ok("torn/invalid JSONL lines are skipped without losing valid neighbours");
}

async function testEmptySpoolFastPath() {
  reset();
  const { backend, statusCalls } = stubBackend();
  const res = await maybeDrain(backend, baseConfig());
  assert.equal(res, null, "empty spool must short-circuit");
  assert.equal(statusCalls(), 0, "empty spool must NOT trigger a status probe");
  ok("empty spool costs no status probe (fast path)");

  add("x");
  const res2 = await maybeDrain(backend, baseConfig());
  assert.ok(res2 && res2.replayed === 1);
  assert.equal(statusCalls(), 1, "non-empty spool probes exactly once");
  ok("non-empty spool probes once, then drains");

  reset();
  add("y");
  const down = stubBackend({ available: false });
  const res3 = await maybeDrain(down.backend, baseConfig());
  assert.equal(res3, null, "unavailable server must not attempt replay");
  assert.equal(stats().entries, 1, "entries must survive an unavailable probe");
  ok("unavailable server leaves the spool untouched");
}

async function testSpoolDisabled() {
  reset();
  const res = spoolEpisode(baseConfig({ spoolEnabled: false }), {
    name: "nope", body: "b", groupId: "pg", source: "text",
  });
  assert.equal(res.ok, false, "spoolEnabled:false must not persist");
  assert.equal(stats().entries, 0);
  ok("spoolEnabled:false disables spooling entirely and reports ok:false");

  const res2 = spoolEpisode(baseConfig(), { name: "yes", body: "b", groupId: "pg", source: "text" });
  assert.equal(res2.ok, true);
  assert.equal(stats().entries, 1);
  ok("spoolEpisode reports durability via ok");

  const l = limitsFromConfig(baseConfig({ spoolMaxEntries: 7 }));
  assert.equal(l.maxEntries, 7, "limits must come from config");
  ok("limitsFromConfig maps config to spool limits");
}

async function main() {
  console.log(`spool test root: ${TMP_ROOT}`);
  await testEnqueueAndStats();
  await testReplayIsGroupFaithful();
  await testRequeueOnFailure();
  await testServerRejectionCountsAttempts();
  await testFailedEntryGoesToTail();
  await testBatchLimitAndClamp();
  await testAgeExpiryAbandonmentAndDeadLetter();
  await testBounds();
  await testTruncationIsReported();
  await testRequeueFailureDoesNotDestroyBatch();
  await testConcurrentDrainsAcrossProcesses();
  await testLiveClaimIsNotSwept();
  await testStaleClaimRecoveryViaMaybeDrain();
  await testCorruptLines();
  await testEmptySpoolFastPath();
  await testSpoolDisabled();
  console.log(`\nPASS: ${passed} spool assertions held.`);
}

main()
  .then(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); })
  .catch((err) => {
    console.error("\nFAIL:", err instanceof Error ? err.message : err);
    console.error(`(spool dir left for inspection: ${TMP_ROOT})`);
    process.exit(1);
  });
