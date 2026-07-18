#!/usr/bin/env bash
#
# sandbox.sh - launch pi with the local pi-graphiti extension, isolated to a
# throwaway graphiti config + group id via PI_GRAPHITI_CONFIG. Your real
# ~/.pi/agent (model + auth config) is left untouched, so pi still has
# credentials -- unlike a full HOME override.
#
# Points at the already-running local Graphiti MCP server on :8431
# (the FalkorDB stack from the graphiti-mcp-local-stack skill). Override with
# PI_GRAPHITI_URL before invoking if your server lives elsewhere.
#
# Try inside the session:
#   /graph                 -> status + recent episodes + active group
#   graph add "..."        -> write an episode
#   graph search "..."     -> search_nodes + search_memory_facts
#   /graph dump /tmp/x.md  -> export all episodes
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# No trailing slash: this graphiti image serves the MCP endpoint at /mcp and
# 307-redirects /mcp/ -> /mcp. Hitting /mcp directly skips the redirect round-trip.
URL="${PI_GRAPHITI_URL:-http://localhost:8431/mcp}"

CFG=$(mktemp)
trap 'rm -f "$CFG"' EXIT

cat > "$CFG" <<JSON
{
  "enabled": true,
  "url": "${URL}",
  "groupId": "pigraphiti_sandbox",
  "injectContext": true,
  "projectScoping": false
}
JSON

echo "config file  : $CFG"
echo "graphiti url : $URL"
echo "group id     : pigraphiti_sandbox"
echo

PI_GRAPHITI_CONFIG="$CFG" pi -e "$REPO/src/index.ts"
