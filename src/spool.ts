/**
 * Disk write spool — never lose an episode to an MCP outage.
 *
 * Problem (docs/design/outage-resilience.md item 9): the automatic write paths
 * (turn nudge, pre-compact flush, shutdown flush) and the `graph` tool's own
 * `add` previously SWALLOWED their failure when the graphiti server was
 * unreachable. The episode was gone permanently: an outage silently turned into
 * memory loss. Deferred is acceptable; dropped is not.
 *
 * NOTE: the LLM curation pass (review.ts, used when `reviewEnabled`) writes via
 * the `graph` tool, so its adds spool like any other. The correction detector
 * still SKIPS rather than spools when the server is down (tracked item 10).
 *
 * Design:
 *   - Append-only JSONL at <agentRoot>/pi-graphiti-spool/pending.jsonl. One line
 *     per episode, carrying the ALREADY-RESOLVED group id so replay is
 *     scope-faithful even if the project/scope config changed in between.
 *   - Mutations claim the whole file with a single atomic `rename`, so two pi
 *     sessions can never replay the same entry twice. Anything not replayed is
 *     appended back, and the claim file is removed ONLY once that append is
 *     known to have succeeded.
 *   - Crash safety: a claim orphaned by a killed process is recovered on the next
 *     drain. The sweep checks process liveness and the claim's heartbeat, so a
 *     slow-but-live drain is never swept out from under itself (which would
 *     double-write every episode in its batch).
 *   - Bounded three ways: entries, total bytes, age. A long outage degrades to
 *     "newest N kept", never to an unbounded disk eater.
 *   - Nothing is deleted silently: expired, abandoned, and evicted entries are
 *     moved to dead-letter.jsonl so a drop is always forensically visible.
 *
 * Every exported function is fail-quiet: spooling is a safety net, and a broken
 * safety net must never become the reason a turn fails. The one thing it must not
 * do is report success for data it did not persist.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { agentRoot } from "./project.js";
import type { GraphitiBackend } from "./backend.js";
import type { GraphitiConfig } from "./types.js";

/** Bump when the on-disk entry shape changes; unknown versions are dropped. */
const SPOOL_VERSION = 1;
const PENDING_FILE = "pending.jsonl";
const DEAD_LETTER_FILE = "dead-letter.jsonl";
const CLAIM_SUFFIX = ".claim";
/**
 * A claim whose owning process is gone (or whose heartbeat is this stale) is
 * assumed orphaned. A LIVE owner is never swept regardless of age: sweeping a
 * running drain re-queues entries it is still replaying, which double-writes
 * every one of them.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;
/** Give up on an entry the SERVER keeps rejecting (transport errors don't count). */
const MAX_ATTEMPTS = 5;
/** Hard cap per episode body. Truncation is reported, never silent. */
const MAX_BODY_CHARS = 20000;

/**
 * Errors that mean "the server/network is unavailable" rather than "this episode
 * is bad". Only the latter counts toward MAX_ATTEMPTS, so an outage or a flaky
 * link can never burn through a healthy episode's attempt budget.
 */
const TRANSPORT_ERROR_RE =
  /aborted|timed out|timeout|fetch .*failed|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|missing session id|HTTP 5\d\d|HTTP 429/i;

export interface SpoolLimits {
  maxEntries: number;
  maxBytes: number;
  maxAgeDays: number;
}

export const DEFAULT_SPOOL_LIMITS: SpoolLimits = {
  maxEntries: 200,
  maxBytes: 8 * 1024 * 1024,
  maxAgeDays: 14,
};

export interface SpoolEntry {
  v: number;
  /** Epoch ms when the write was first attempted. */
  ts: number;
  name: string;
  body: string;
  /** Resolved graphiti group id (NOT a scope): replay must not re-derive it. */
  groupId: string;
  source: "text" | "message" | "json";
  sourceDescription?: string;
  /** What produced it (nudge/compact/shutdown/tool) — diagnostics only. */
  origin?: string;
  /** Server-side rejections so far (transport failures excluded). */
  attempts?: number;
  /** Set when the body was cut to MAX_BODY_CHARS. */
  truncated?: boolean;
  /** Original body length, when truncated. */
  originalChars?: number;
}

export interface EnqueueResult {
  /** True only when the entry is durably on disk. */
  ok: boolean;
  truncated: boolean;
  storedChars: number;
  originalChars: number;
}

export interface SpoolStats {
  /** Total actionable episodes: pending + stranded in orphaned claims. */
  entries: number;
  /** Episodes in pending.jsonl. */
  pending: number;
  /** Episodes sitting in claim files (a drain in flight, or a crashed one). */
  stranded: number;
  bytes: number;
  oldestTs: number | null;
  newestTs: number | null;
  /** Episodes dropped and recorded in dead-letter.jsonl. */
  deadLettered: number;
}

export interface DrainResult {
  replayed: number;
  remaining: number;
  expired: number;
  abandoned: number;
  recovered: number;
  /** Set when replay stopped early because the server failed again. */
  stoppedOn?: string;
  /** Set when entries could not be written back to disk (e.g. disk full). */
  requeueFailed?: boolean;
}

export function spoolDir(): string {
  return path.join(agentRoot(), "pi-graphiti-spool");
}

export function spoolFile(): string {
  return path.join(spoolDir(), PENDING_FILE);
}

export function deadLetterFile(): string {
  return path.join(spoolDir(), DEAD_LETTER_FILE);
}

/**
 * Append one episode to the spool.
 *
 * Returns whether it is durably on disk plus whether the body was truncated, so
 * callers never report "saved" for content they partially lost.
 */
export function enqueue(
  entry: Omit<SpoolEntry, "v" | "ts"> & { ts?: number },
  limits: SpoolLimits = DEFAULT_SPOOL_LIMITS,
): EnqueueResult {
  const originalChars = entry.body.length;
  const body = entry.body.slice(0, MAX_BODY_CHARS);
  const truncated = body.length < originalChars;
  const result: EnqueueResult = {
    ok: false,
    truncated,
    storedChars: body.length,
    originalChars,
  };
  try {
    const record: SpoolEntry = {
      v: SPOOL_VERSION,
      ts: entry.ts ?? Date.now(),
      name: entry.name.slice(0, 200),
      body,
      groupId: entry.groupId,
      source: entry.source,
      ...(entry.sourceDescription ? { sourceDescription: entry.sourceDescription } : {}),
      ...(entry.origin ? { origin: entry.origin } : {}),
      ...(entry.attempts ? { attempts: entry.attempts } : {}),
      ...(truncated ? { truncated: true, originalChars } : {}),
    };
    fs.mkdirSync(spoolDir(), { recursive: true });
    // O_APPEND single-line write: concurrent sessions interleave lines safely.
    fs.appendFileSync(spoolFile(), JSON.stringify(record) + "\n", "utf8");
    result.ok = true;
    enforceLimits(limits);
    return result;
  } catch {
    return result;
  }
}

/**
 * Depth/size/age summary for `/graph`. Never throws.
 *
 * Counts claim files too: entries stranded by a crashed drain are real pending
 * memory, and an earlier revision reported them as zero, which made both the UI
 * and the auto-drain gate blind to them.
 */
export function stats(): SpoolStats {
  const empty: SpoolStats = {
    entries: 0, pending: 0, stranded: 0, bytes: 0,
    oldestTs: null, newestTs: null, deadLettered: 0,
  };
  try {
    const dir = spoolDir();
    if (!fs.existsSync(dir)) return empty;

    let bytes = 0;
    const pending = readEntriesIfPresent(spoolFile(), (n) => { bytes += n; });
    let stranded: SpoolEntry[] = [];
    for (const f of claimFiles()) {
      stranded = stranded.concat(readEntriesIfPresent(f, (n) => { bytes += n; }));
    }
    const all = [...pending, ...stranded];
    const out: SpoolStats = {
      entries: all.length,
      pending: pending.length,
      stranded: stranded.length,
      bytes,
      oldestTs: null,
      newestTs: null,
      deadLettered: readEntriesIfPresent(deadLetterFile(), () => {}).length,
    };
    for (const e of all) {
      if (out.oldestTs === null || e.ts < out.oldestTs) out.oldestTs = e.ts;
      if (out.newestTs === null || e.ts > out.newestTs) out.newestTs = e.ts;
    }
    return out;
  } catch {
    return empty;
  }
}

/**
 * Replay spooled episodes into graphiti.
 *
 * Failure-tolerant by construction: the first write error stops the drain and
 * requeues everything not yet replayed, so a server that dies mid-drain costs at
 * most one wasted request. The claim file is deleted only after the requeue is
 * confirmed on disk.
 */
export async function drain(
  backend: GraphitiBackend,
  limits: SpoolLimits = DEFAULT_SPOOL_LIMITS,
  batchLimit = 25,
): Promise<DrainResult> {
  const result: DrainResult = {
    replayed: 0, remaining: 0, expired: 0, abandoned: 0, recovered: 0,
  };
  const batch = Math.max(1, Math.floor(batchLimit));
  try {
    result.recovered = recoverStaleClaims();
    const claimed = claim();
    if (!claimed) return result;

    const { file, entries } = claimed;
    const cutoff = Date.now() - limits.maxAgeDays * 24 * 60 * 60 * 1000;
    const live: SpoolEntry[] = [];
    const dropped: { entry: SpoolEntry; reason: string }[] = [];
    for (const e of entries) {
      if (e.ts < cutoff) {
        dropped.push({ entry: e, reason: `expired (older than ${limits.maxAgeDays}d)` });
        result.expired++;
        continue;
      }
      if ((e.attempts ?? 0) >= MAX_ATTEMPTS) {
        dropped.push({ entry: e, reason: `abandoned after ${MAX_ATTEMPTS} server rejections` });
        result.abandoned++;
        continue;
      }
      live.push(e);
    }
    if (dropped.length > 0) appendDeadLetter(dropped);

    const leftover: SpoolEntry[] = [];
    /**
     * The entry that failed goes to the TAIL, not back at the head. Requeued at
     * its original position it would be retried first on every subsequent cycle
     * and, combined with stop-on-first-failure, would block every healthy entry
     * behind it for MAX_ATTEMPTS cycles.
     */
    let failed: SpoolEntry | null = null;
    let stopped = false;
    for (const e of live) {
      if (stopped || result.replayed >= batch) { leftover.push(e); continue; }
      try {
        await backend.addEpisodeToGroup({
          name: e.name,
          body: e.body,
          groupId: e.groupId,
          source: e.source,
          sourceDescription: e.sourceDescription ?? "pi-graphiti spool replay",
        });
        result.replayed++;
        // Heartbeat: proves to other sessions' stale sweep that this claim is
        // being actively worked, so a long backlog is never swept and replayed twice.
        touch(file);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.stoppedOn = message;
        // Transport failures are the server's fault, not the episode's: do not
        // spend one of its MAX_ATTEMPTS on an outage.
        const serverRejected = !TRANSPORT_ERROR_RE.test(message);
        failed = serverRejected ? { ...e, attempts: (e.attempts ?? 0) + 1 } : e;
        stopped = true;
      }
    }
    if (failed) leftover.push(failed);

    if (leftover.length > 0) {
      const requeued = requeue(leftover);
      if (!requeued) {
        // Could not write them back (disk full, permissions). Do NOT delete the
        // claim: leaving it lets the stale sweep recover the batch later. This is
        // the one path where deleting would silently destroy the whole batch.
        result.requeueFailed = true;
        result.remaining = leftover.length;
        return result;
      }
      result.remaining = leftover.length;
    }
    try { fs.unlinkSync(file); } catch { /* already gone */ }
    if (leftover.length > 0) enforceLimits(limits);
    return result;
  } catch {
    return result;
  }
}

/** Delete pending + claimed episodes (`/graph spool clear`). Dead letters are kept. */
export function clear(): number {
  try {
    const before = stats().entries;
    const dir = spoolDir();
    if (!fs.existsSync(dir)) return 0;
    for (const f of fs.readdirSync(dir)) {
      if (f === PENDING_FILE || f.endsWith(CLAIM_SUFFIX)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
    return before;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Atomically take ownership of the pending file.
 *
 * `rename` is the whole concurrency story: exactly one caller can win, so two pi
 * sessions mutating simultaneously cannot double-process an episode. A caller
 * that appends between the rename and our read simply lands in a fresh pending
 * file and is handled next cycle.
 */
function claim(): { file: string; entries: SpoolEntry[] } | null {
  const pending = spoolFile();
  if (!fs.existsSync(pending)) return null;
  // pid + ms + random: pid drives the liveness check, random prevents two claims
  // in the same process and millisecond from colliding.
  const unique = Math.random().toString(36).slice(2, 8);
  const target = path.join(
    spoolDir(),
    `pending.${process.pid}.${Date.now()}.${unique}${CLAIM_SUFFIX}`,
  );
  try {
    fs.renameSync(pending, target);
  } catch {
    return null; // lost the race, or it vanished
  }
  try {
    return { file: target, entries: parseLines(fs.readFileSync(target, "utf8")) };
  } catch {
    return null; // leave the file for the stale sweep rather than dropping it
  }
}

/**
 * Append entries back onto the pending file.
 * Returns false when nothing reached disk, so callers can avoid destroying the
 * claim they were holding.
 */
function requeue(entries: SpoolEntry[]): boolean {
  if (entries.length === 0) return true;
  try {
    fs.mkdirSync(spoolDir(), { recursive: true });
    fs.appendFileSync(
      spoolFile(),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim claims orphaned by a process that died mid-drain, and ONLY those.
 *
 * A live owner is never swept: re-queueing entries a running drain is still
 * replaying makes both copies get written. Liveness beats age, and the heartbeat
 * `touch` in `drain` keeps a slow-but-progressing drain visibly alive.
 *
 * Returns the number of episodes recovered.
 */
function recoverStaleClaims(): number {
  let recovered = 0;
  try {
    const now = Date.now();
    for (const full of claimFiles()) {
      const owner = pidFromClaim(path.basename(full));
      if (owner !== null && isProcessAlive(owner)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
      if (now - mtime < STALE_CLAIM_MS) continue;
      try {
        const entries = parseLines(fs.readFileSync(full, "utf8"));
        if (entries.length > 0 && !requeue(entries)) continue; // keep for next sweep
        fs.unlinkSync(full);
        recovered += entries.length;
      } catch {
        // leave it; next sweep retries
      }
    }
  } catch {
    // ignore
  }
  return recovered;
}

/**
 * Keep the spool bounded: newest-first by entry count and total bytes. Runs under
 * the same atomic claim as drain so a concurrent append is not lost to a
 * read-modify-write race. Evicted entries go to the dead-letter file.
 */
function enforceLimits(limits: SpoolLimits): void {
  try {
    const file = spoolFile();
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    // Cheap pre-check: only pay a full read+parse when a bound could actually bind.
    if (size <= limits.maxBytes && size <= limits.maxEntries * 64) return;

    const claimed = claim();
    if (!claimed) return;
    const all = claimed.entries;
    let kept = all.slice(Math.max(0, all.length - limits.maxEntries));
    // Drop oldest until under the byte budget. Sizes computed once, not per pass.
    const sizes = kept.map((e) => Buffer.byteLength(JSON.stringify(e), "utf8") + 1);
    let total = sizes.reduce((a, b) => a + b, 0);
    let cut = 0;
    while (kept.length - cut > 1 && total > limits.maxBytes) {
      total -= sizes[cut];
      cut++;
    }
    if (cut > 0) kept = kept.slice(cut);

    const evicted = all.slice(0, all.length - kept.length);
    if (evicted.length > 0) {
      appendDeadLetter(evicted.map((entry) => ({ entry, reason: "evicted (spool bound exceeded)" })));
    }
    if (!requeue(kept)) return; // keep the claim for the stale sweep
    try { fs.unlinkSync(claimed.file); } catch { /* ignore */ }
  } catch {
    // ignore
  }
}

/** Record dropped episodes so a loss is never invisible. */
function appendDeadLetter(items: { entry: SpoolEntry; reason: string }[]): void {
  if (items.length === 0) return;
  try {
    fs.mkdirSync(spoolDir(), { recursive: true });
    const lines = items.map((i) =>
      JSON.stringify({ ...i.entry, droppedAt: Date.now(), droppedReason: i.reason }),
    );
    fs.appendFileSync(deadLetterFile(), lines.join("\n") + "\n", "utf8");
  } catch {
    // ignore
  }
}

function claimFiles(): string[] {
  try {
    const dir = spoolDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(CLAIM_SUFFIX))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** `pending.<pid>.<ts>.<rand>.claim` -> pid, or null when unparseable. */
function pidFromClaim(basename: string): number | null {
  const m = /^pending\.(\d+)\./.exec(basename);
  if (!m) return null;
  const pid = Number.parseInt(m[1], 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but owned by another user; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function touch(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // ignore
  }
}

function readEntriesIfPresent(file: string, onBytes: (n: number) => void): SpoolEntry[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    onBytes(Buffer.byteLength(raw, "utf8"));
    return parseLines(raw);
  } catch {
    return [];
  }
}

/** Parse JSONL, skipping blank/corrupt/unknown-version lines. */
function parseLines(raw: string): SpoolEntry[] {
  const out: SpoolEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as SpoolEntry;
      if (!obj || typeof obj !== "object") continue;
      if (obj.v !== SPOOL_VERSION) continue;
      if (typeof obj.body !== "string" || typeof obj.groupId !== "string") continue;
      if (typeof obj.name !== "string" || typeof obj.ts !== "number") continue;
      if (obj.source !== "text" && obj.source !== "message" && obj.source !== "json") continue;
      out.push(obj);
    } catch {
      // Torn write or hand-edit: skip the line, keep the rest.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// config-aware convenience wrappers (used by sync.ts / tool.ts / index.ts)
// ---------------------------------------------------------------------------

/** Map config to limits, clamping to >= 1 so a 0 can never disable a bound. */
export function limitsFromConfig(config: GraphitiConfig): SpoolLimits {
  return {
    maxEntries: clampPositive(config.spoolMaxEntries, DEFAULT_SPOOL_LIMITS.maxEntries),
    maxBytes: clampPositive(config.spoolMaxBytes, DEFAULT_SPOOL_LIMITS.maxBytes),
    maxAgeDays: clampPositive(config.spoolMaxAgeDays, DEFAULT_SPOOL_LIMITS.maxAgeDays),
  };
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/**
 * Spool an episode that could not be written, honoring `spoolEnabled`.
 * The result reports durability and truncation so callers do not claim success
 * for content they lost.
 */
export function spoolEpisode(
  config: GraphitiConfig,
  entry: Omit<SpoolEntry, "v" | "ts">,
): EnqueueResult {
  if (!config.spoolEnabled) {
    return { ok: false, truncated: false, storedChars: 0, originalChars: entry.body.length };
  }
  return enqueue(entry, limitsFromConfig(config));
}

/**
 * Replay the spool if there is anything in it and the server looks reachable.
 *
 * Order matters: the cheap on-disk depth check comes FIRST so a healthy session
 * with an empty spool (the overwhelmingly common case) does no status probe. That
 * check counts claim files as well as pending, otherwise entries stranded by a
 * crashed drain are invisible here and never recovered.
 */
export async function maybeDrain(
  backend: GraphitiBackend,
  config: GraphitiConfig,
): Promise<DrainResult | null> {
  try {
    if (!config.spoolEnabled) return null;
    if (stats().entries === 0) return null;
    const status = await backend.getStatus();
    if (!status.available) return null;
    return await drain(backend, limitsFromConfig(config), config.spoolDrainBatch);
  } catch {
    return null;
  }
}
