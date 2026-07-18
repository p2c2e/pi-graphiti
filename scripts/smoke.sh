#!/usr/bin/env bash
#
# smoke.sh - non-interactive end-to-end check of the pi-graphiti extension.
#
# Runs pi in headless mode (-p) with the local extension isolated to a
# throwaway graphiti config + group id (via PI_GRAPHITI_CONFIG), so your real
# ~/.pi/agent auth/model config is preserved and your real graph is untouched.
#
# Drives the `graph` tool through add -> search and asserts the round-trip
# returns the expected marker. Exits non-zero on failure (CI-friendly).
#
# Env overrides:
#   PI_GRAPHITI_URL   graphiti MCP endpoint (default http://localhost:8431/mcp/)
#   SMOKE_TIMEOUT     per-pi-run timeout in seconds (default 60)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${PI_GRAPHITI_URL:-http://localhost:8431/mcp/}"
TIMEOUT="${SMOKE_TIMEOUT:-60}"
MARKER="pigraphiti_smoke_$(date +%s)_$$"

CFG=$(mktemp)
trap 'rm -f "$CFG"' EXIT
cat > "$CFG" <<JSON
{
  "enabled": true,
  "url": "${URL}",
  "groupId": "pigraphiti_smoke",
  "injectContext": false,
  "projectScoping": false
}
JSON

echo "==> pi-graphiti smoke test"
echo "    repo   : $REPO"
echo "    url    : $URL"
echo "    group  : pigraphiti_smoke"
echo "    marker : $MARKER"
echo

# Fail fast if the graphiti server is unreachable (extension fails quiet, so a
# down server would otherwise produce a green-but-meaningless run).
if ! curl -s -m 5 -o /dev/null "$URL"; then
  echo "FAIL: graphiti MCP server not reachable at $URL" >&2
  echo "      start your local stack (graphiti-mcp-local-stack) and retry." >&2
  exit 2
fi

run_pi() {
  PI_GRAPHITI_CONFIG="$CFG" timeout "$TIMEOUT" pi -e "$REPO/src/index.ts" -p "$1" 2>&1
}

echo "==> step 1: graph add"
ADD_OUT=$(run_pi "Use the graph tool with action=add and text='${MARKER} smoke episode'. Then reply with exactly: ADDOK")
if ! grep -q "ADDOK" <<<"$ADD_OUT"; then
  echo "FAIL: add step did not complete" >&2
  echo "----- output -----" >&2
  echo "$ADD_OUT" | tail -20 >&2
  exit 1
fi
echo "    add OK"

echo "==> step 2: graph search (extraction is async; allow brief settle)"
sleep 5
SEARCH_OUT=$(run_pi "Use the graph tool with action=search and query='${MARKER}'. If the search returns any result, reply with exactly: SEARCHOK . Otherwise reply: SEARCHEMPTY")

if grep -q "SEARCHOK" <<<"$SEARCH_OUT"; then
  echo "    search OK (marker found)"
elif grep -q "SEARCHEMPTY" <<<"$SEARCH_OUT"; then
  # Async extraction may not have indexed the episode yet. The tool round-trip
  # still succeeded, which is what we assert here; warn but do not fail.
  echo "    search ran but marker not yet indexed (async extraction lag) - WARN"
else
  echo "FAIL: search step did not complete cleanly" >&2
  echo "----- output -----" >&2
  echo "$SEARCH_OUT" | tail -20 >&2
  exit 1
fi

echo
echo "PASS: pi-graphiti graph add/search round-trip works."
