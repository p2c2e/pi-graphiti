/**
 * Ingest any text document into the graphiti backend as episode memory.
 *
 * Reuses the extension's config loader + backend, so it honors the same
 * PI_GRAPHITI_* env vars and ~/.pi/agent/pi-graphiti-config.json.
 *
 * Usage:
 *   npx tsx scripts/ingest-file.ts <file> [options]
 *
 * Options:
 *   --group <id>        Target group_id (overrides PI_GRAPHITI_GROUP_ID for
 *                       this run). Sanitized to [A-Za-z0-9_].
 *   --name <base>       Episode base name (default: file basename).
 *   --source <kind>     text | message | json  (default: text).
 *   --chunk-chars <n>   Split into ~n-char chunks on paragraph/line boundaries
 *                       (default: 8000). Use 0 to push the whole file as one
 *                       episode.
 *   --dry-run           Parse + chunk + print plan, but do NOT write.
 *   -h, --help          Show this help.
 *
 * Group selection precedence:
 *   --group  >  PI_GRAPHITI_GROUP_ID (via config.groupId)  >  default group id
 * The document is always written to that ONE explicit group (project scoping
 * does not remap it), so `PI_GRAPHITI_GROUP_ID=foo npx tsx scripts/ingest-file.ts doc.md`
 * lands exactly in group "foo".
 *
 * Run: npm run ingest -- <file> [options]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";
import {
  buildGraphitiBackend,
  sanitizeGroupId,
  defaultGroupId,
} from "../src/backend.js";

interface Args {
  file?: string;
  group?: string;
  name?: string;
  source: "text" | "message" | "json";
  chunkChars: number;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    source: "text",
    chunkChars: 8000,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "--group":
        out.group = argv[++i];
        break;
      case "--name":
        out.name = argv[++i];
        break;
      case "--source": {
        const v = (argv[++i] || "").toLowerCase();
        if (v !== "text" && v !== "message" && v !== "json") {
          fail(`--source must be text|message|json, got "${v}"`);
        }
        out.source = v;
        break;
      }
      case "--chunk-chars": {
        const n = Number.parseInt(argv[++i], 10);
        if (!Number.isFinite(n) || n < 0) fail(`--chunk-chars must be a non-negative integer`);
        out.chunkChars = n;
        break;
      }
      case "--dry-run":
        out.dryRun = true;
        break;
      default:
        if (a.startsWith("-")) fail(`unknown option: ${a}`);
        else if (out.file === undefined) out.file = a;
        else fail(`unexpected extra argument: ${a}`);
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const HELP = `Ingest a text document into graphiti episode memory.

Usage:
  npx tsx scripts/ingest-file.ts <file> [options]
  npm run ingest -- <file> [options]

Options:
  --group <id>        Target group_id (overrides PI_GRAPHITI_GROUP_ID).
  --name <base>       Episode base name (default: file basename).
  --source <kind>     text | message | json  (default: text).
  --chunk-chars <n>   ~n-char chunks on paragraph/line boundaries
                      (default: 8000; 0 = whole file as one episode).
  --dry-run           Show the plan without writing.
  -h, --help          Show this help.

Example:
  PI_GRAPHITI_GROUP_ID=myscratch npx tsx scripts/ingest-file.ts notes.md --chunk-chars 6000
`;

/**
 * Split text into chunks no larger than maxChars, preferring paragraph (blank
 * line) boundaries, then single-line boundaries, then a hard character cut for
 * pathological single lines. Returns the whole text as one chunk when
 * maxChars <= 0.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (maxChars <= 0 || trimmed.length <= maxChars) return [trimmed];

  const paras = trimmed.split(/\n\s*\n/);
  const chunks: string[] = [];
  let cur = "";

  const flush = () => {
    const c = cur.trim();
    if (c) chunks.push(c);
    cur = "";
  };

  for (const para of paras) {
    // A single paragraph bigger than the budget: split it further by lines,
    // then hard-cut any remaining oversized line.
    if (para.length > maxChars) {
      flush();
      for (const piece of splitOversized(para, maxChars)) chunks.push(piece);
      continue;
    }
    if (cur && cur.length + 2 + para.length > maxChars) flush();
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

function splitOversized(block: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of block.split("\n")) {
    if (line.length > maxChars) {
      if (cur.trim()) { out.push(cur.trim()); cur = ""; }
      for (let i = 0; i < line.length; i += maxChars) {
        out.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    if (cur && cur.length + 1 + line.length > maxChars) { out.push(cur.trim()); cur = ""; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const filePath = path.resolve(args.file.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`not a file: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, "utf-8");
  if (!text.trim()) fail(`file is empty: ${filePath}`);

  // Group selection: --group > config.groupId (from PI_GRAPHITI_GROUP_ID or
  // config file) > computed default. Always sanitized.
  const config = loadConfig();
  const rawGroup = args.group || config.groupId || defaultGroupId();
  const groupId = sanitizeGroupId(rawGroup);

  // Force scoping OFF for a deterministic single-bucket write to `groupId`.
  const backend = buildGraphitiBackend({ ...config, enabled: true, projectScoping: false }, null);
  if (!backend) fail("could not build graphiti backend (check config)");

  const baseName = args.name || path.basename(filePath);
  const chunks = chunkText(text, args.chunkChars);
  if (chunks.length === 0) fail("nothing to ingest after trimming");

  const pad = String(chunks.length).length;
  const names = chunks.map((_, i) =>
    chunks.length === 1 ? baseName : `${baseName} [${String(i + 1).padStart(pad, "0")}/${chunks.length}]`,
  );

  console.log(`File:    ${filePath}`);
  console.log(`Group:   ${groupId}${rawGroup !== groupId ? `  (sanitized from "${rawGroup}")` : ""}`);
  console.log(`URL:     ${backend!.options.url}`);
  console.log(`Source:  ${args.source}`);
  console.log(`Chunks:  ${chunks.length}${args.chunkChars > 0 ? ` (<= ${args.chunkChars} chars each)` : " (whole file)"}`);
  console.log(`Bytes:   ${text.length}`);

  if (args.dryRun) {
    console.log("\n[dry-run] would push:");
    names.forEach((n, i) => console.log(`  - ${n}  (${chunks[i].length} chars)`));
    return;
  }

  const status = await backend!.getStatus(true);
  if (!status.available) fail(`graphiti unavailable: ${status.message}`);

  let ok = 0;
  let failCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      await backend!.addEpisodeToGroup({
        name: names[i],
        body: chunks[i],
        groupId,
        source: args.source,
        sourceDescription: `ingest-file: ${path.basename(filePath)}`,
      });
      ok++;
      process.stdout.write(`\r  pushed ${ok}/${chunks.length}`);
    } catch (err) {
      failCount++;
      console.error(`\n  chunk ${i + 1} failed: ${(err as Error).message}`);
    }
  }
  process.stdout.write("\n");
  console.log(`\nDone: ${ok} episode(s) pushed to group "${groupId}"${failCount ? `, ${failCount} failed` : ""}.`);
  console.log("Entities/facts extract asynchronously; allow ~30-90s before searching.");
}

main().catch((err) => {
  console.error("\nFAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
