#!/usr/bin/env bash
#
# sandbox-scoped.sh - like sandbox.sh, but exercises the OPTIONAL project+global
# graph memory scoping (projectScoping: true).
#
# Launches pi from inside a throwaway PROJECT directory so the cwd basename
# resolves a project name. With scoping on, graph memory splits into:
#   - global group:  pigraphiti_sandbox
#   - project group: pigraphiti_sandbox_proj_<projectName>
#
# Try inside the session:
#   /graph                              -> shows the active group id
#   graph add   scope=project  "..."    -> writes to ..._proj_<name>
#   graph add   scope=global   "..."    -> writes to pigraphiti_sandbox
#   graph search scope=both    "..."    -> unions project + global
#
# Override the project name with the first arg (default: "demoproject").
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# No trailing slash: this graphiti image serves the MCP endpoint at /mcp and
# 307-redirects /mcp/ -> /mcp. Hitting /mcp directly skips the redirect round-trip.
URL="${PI_GRAPHITI_URL:-http://localhost:8431/mcp}"
PROJECT_NAME="${1:-demoproject}"

CFG=$(mktemp)
trap 'rm -f "$CFG"' EXIT
PROJECT_DIR=$(mktemp -d)/$PROJECT_NAME
mkdir -p "$PROJECT_DIR"

cat > "$CFG" <<JSON
{
  "enabled": true,
  "url": "${URL}",
  "groupId": "pigraphiti_sandbox",
  "projectScoping": true,
  "injectContext": true
}
JSON

echo "config file  : $CFG"
echo "project dir  : $PROJECT_DIR"
echo "graphiti url : $URL"
echo "global group : pigraphiti_sandbox"
echo "project group: pigraphiti_sandbox_proj_${PROJECT_NAME}"
echo

# cd into the project dir so the cwd basename resolves the project name.
cd "$PROJECT_DIR"
PI_GRAPHITI_CONFIG="$CFG" pi -e "$REPO/src/index.ts"
