/**
 * Minimal MCP HTTP client (streamable HTTP transport).
 *
 * Implements only what we need to talk to a Graphiti MCP server:
 *   - initialize (capture Mcp-Session-Id)
 *   - notifications/initialized
 *   - tools/call
 *
 * Responses arrive as Server-Sent-Event frames (`data: { ...jsonrpc }`).
 * We parse the first `result` (or `error`) frame and return it.
 *
 * Verified against Graphiti Agent Memory v1.26.0 (FalkorDB-backed).
 */

const ACCEPT = "application/json, text/event-stream";
const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "pi-graphiti", version: "0.1.x" };

export interface McpClientOptions {
  url: string;
  timeoutMs?: number;
}

/**
 * Per-call overrides.
 *
 * `timeoutMs` narrows (or widens) the client default for a single HTTP request -
 * used to give cheap health probes a small budget while real writes/searches
 * keep a generous one.
 *
 * `signal` bounds the whole LOGICAL operation across every request a call makes
 * (handshake + tools/call). A per-request timeout alone cannot do that: a cold
 * client against a slow server can spend `budget` on `initialize` and `budget`
 * again on the call. Callers that need a hard ceiling pass one
 * `AbortSignal.timeout(...)` and get cancellation of the in-flight socket too,
 * which a wrapper deadline (Promise.race) cannot provide.
 *
 * See docs/design/outage-resilience.md.
 */
export interface McpCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface McpToolCallResult {
  /** Concatenated `text` blocks from `result.content[]`. Empty string if no text blocks. */
  text: string;
  /** Raw parsed JSON-RPC result object (if any). */
  raw?: Record<string, unknown>;
}

export class McpClientError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "McpClientError";
  }
}

export class GraphitiMcpClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private initGeneration = 0;
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.timeoutMs = opts.timeoutMs ?? 60000;
  }

  /**
   * Lazy initialize. Safe to call repeatedly - only runs once.
   *
   * `opts.timeoutMs` bounds each handshake request and `opts.signal` bounds the
   * whole handshake. This matters for probes: a COLD client talking to a hung
   * server spends the entire hang inside `initialize`, so a 3s probe would
   * otherwise block for the 60s client default.
   *
   * Concurrency: callers joining an in-flight init inherit the FIRST caller's
   * budget and signal. A generation guard makes sure a late failure only clears
   * the promise it actually owns, so a slow rejecting init cannot cancel a newer
   * caller's successful one.
   */
  async ensureInitialized(opts: McpCallOptions = {}): Promise<void> {
    if (this.sessionId) return;
    if (!this.initPromise) {
      const generation = ++this.initGeneration;
      this.initPromise = this.doInitialize(opts).catch((err) => {
        if (this.initGeneration === generation) {
          this.initPromise = null; // allow retry next call
        }
        throw err;
      });
    }
    return this.initPromise;
  }

  /** Reset session - next call will re-initialize. */
  reset(): void {
    this.sessionId = null;
    this.initPromise = null;
    this.initGeneration++;
  }

  private async doInitialize(opts: McpCallOptions = {}): Promise<void> {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    };

    const { response, text } = await this.post(body, /*requireSession*/ false, opts);

    const sid = response.headers.get("mcp-session-id");
    if (!sid) {
      throw new McpClientError(
        `No Mcp-Session-Id header in initialize response (status=${response.status}). Server may be unreachable or not a graphiti MCP endpoint.`,
      );
    }
    this.sessionId = sid;

    // Parse the initialize result to surface server identity early (and detect errors).
    const result = parseSseJsonRpc(text, id);
    if (result.error) {
      this.sessionId = null;
      throw new McpClientError(`initialize failed: ${result.error}`);
    }

    // Fire-and-forget the initialized notification (no response expected).
    try {
      await this.post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        /*requireSession*/ true,
        opts,
      );
    } catch {
      // Some servers don't reply; that's fine.
    }
  }

  /**
   * Call a tool. Returns concatenated text blocks plus the raw result object.
   * Throws McpClientError on JSON-RPC error or transport failure.
   *
   * `opts.timeoutMs` bounds each HTTP request; `opts.signal` bounds the whole
   * logical call including the lazy handshake. Pass a signal when you need a
   * hard ceiling: timeoutMs alone allows up to 2x (initialize + the call).
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: McpCallOptions = {},
  ): Promise<McpToolCallResult> {
    await this.ensureInitialized(opts);
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };

    const { text } = await this.post(body, /*requireSession*/ true, opts);
    const parsed = parseSseJsonRpc(text, id);
    if (parsed.error) {
      throw new McpClientError(`tools/call '${name}' failed: ${parsed.error}`);
    }
    return {
      text: extractContentText(parsed.result),
      raw: parsed.result,
    };
  }

  private async post(
    body: unknown,
    requireSession: boolean,
    opts: McpCallOptions = {},
  ): Promise<{ response: Response; text: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: ACCEPT,
    };
    if (requireSession) {
      if (!this.sessionId) throw new McpClientError("Missing session id; initialize first");
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const budgetMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs).unref?.();
    // Per-request timeout OR the caller's logical-operation signal, whichever
    // fires first. Aborting cancels the socket, so a hung server does not keep a
    // connection alive past the caller's ceiling.
    const signal = combineSignals(controller.signal, opts.signal);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "follow",
        signal,
      });
      const text = await response.text();
      if (!response.ok && response.status !== 202) {
        // 202 = accepted (for notifications/responses without a body)
        throw new McpClientError(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
      }
      return { response, text };
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") {
        const cause = opts.signal?.aborted
          ? "caller deadline"
          : `${budgetMs}ms request timeout`;
        throw new McpClientError(`Request to ${this.url} aborted (${cause})`);
      }
      if (err instanceof McpClientError) throw err;
      throw new McpClientError(`fetch ${this.url} failed: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer as unknown as NodeJS.Timeout);
    }
  }
}

/**
 * Combine a per-request timeout signal with an optional caller signal.
 *
 * `AbortSignal.any` is Node 20.3+; the manual fallback keeps this working on
 * older runtimes rather than hard-failing at import time.
 */
function combineSignals(own: AbortSignal, caller?: AbortSignal): AbortSignal {
  if (!caller) return own;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([own, caller]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (own.aborted || caller.aborted) controller.abort();
  else {
    own.addEventListener("abort", abort, { once: true });
    caller.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

interface ParsedJsonRpc {
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Parse a (possibly multi-event) SSE response body. Returns the first matching
 * JSON-RPC frame (by id when provided, otherwise first `result`/`error`).
 * Also tolerates a bare JSON object (some servers don't wrap in SSE).
 */
export function parseSseJsonRpc(body: string, expectedId?: number): ParsedJsonRpc {
  if (!body || body.trim().length === 0) return {};

  // Try bare JSON first
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if ("result" in obj || "error" in obj) {
        return interpretFrame(obj);
      }
    } catch {
      // fall through to SSE parsing
    }
  }

  const frames: Record<string, unknown>[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      frames.push(obj);
    } catch {
      // skip non-JSON SSE data lines (heartbeats etc.)
    }
  }

  // Prefer the frame whose id matches expectedId
  if (expectedId !== undefined) {
    const match = frames.find((f) => f.id === expectedId);
    if (match) return interpretFrame(match);
  }
  const first = frames.find((f) => "result" in f || "error" in f);
  if (first) return interpretFrame(first);
  return {};
}

function interpretFrame(frame: Record<string, unknown>): ParsedJsonRpc {
  if (frame.error && typeof frame.error === "object") {
    const e = frame.error as Record<string, unknown>;
    const msg = typeof e.message === "string" ? e.message : JSON.stringify(e);
    return { error: msg };
  }
  if (frame.result && typeof frame.result === "object") {
    return { result: frame.result as Record<string, unknown> };
  }
  return {};
}

function extractContentText(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}
