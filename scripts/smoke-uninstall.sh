#!/usr/bin/env bash
#
# smoke-uninstall.sh - non-interactive check of the owned-vs-unowned teardown
# gate shared by `/graph uninstall` and the `preuninstall` npm script.
#
# It drives scripts/preuninstall.mjs (plain node, no TUI/LLM/server needed)
# against a throwaway PI_GRAPHITI_CONFIG, with a STUBBED `docker` on PATH that
# records its arguments instead of touching a real daemon. Asserts:
#   1. startedBySetup=false          -> skip, no docker call
#   2. startedBySetup=true, bad dir  -> skip (no compose file), no docker call
#   3. startedBySetup=true, valid    -> `docker compose ... down` + marker cleared
#
# Exits non-zero on failure (CI-friendly). Cross-platform-agnostic logic; the
# harness itself is bash (matches scripts/smoke.sh).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/scripts/preuninstall.mjs"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- stub docker: records argv to $WORK/docker.log, exits 0 -----------------
BIN="$WORK/bin"
mkdir -p "$BIN"
cat > "$BIN/docker" <<STUB
#!/usr/bin/env bash
echo "\$@" >> "$WORK/docker.log"
exit 0
STUB
chmod +x "$BIN/docker"
export PATH="$BIN:$PATH"

CFG="$WORK/config.json"
export PI_GRAPHITI_CONFIG="$CFG"

run() { node "$SCRIPT" 2>&1; }
docker_called() { [ -s "$WORK/docker.log" ]; }
reset_log() { : > "$WORK/docker.log"; }

fail() { echo "FAIL: $1" >&2; echo "----- output -----" >&2; echo "$2" >&2; exit 1; }

echo "==> pi-graphiti uninstall-gate smoke test"
echo "    script : $SCRIPT"
echo "    workdir: $WORK"
echo

# --- 1. unowned: startedBySetup=false --------------------------------------
reset_log
cat > "$CFG" <<JSON
{ "enabled": true, "url": "http://localhost:8431/mcp/", "startedBySetup": false }
JSON
OUT="$(run)"
if ! grep -qi "not started by /graph setup" <<<"$OUT"; then
  fail "case 1 (unowned) expected skip message" "$OUT"
fi
if docker_called; then
  fail "case 1 (unowned) must NOT invoke docker" "$(cat "$WORK/docker.log")"
fi
echo "    case 1 (unowned)        OK - skipped, no docker call"

# --- 2. owned but no compose file ------------------------------------------
reset_log
cat > "$CFG" <<JSON
{ "enabled": true, "startedBySetup": true, "backendDir": "$WORK/does-not-exist" }
JSON
OUT="$(run)"
if ! grep -qi "no compose file" <<<"$OUT"; then
  fail "case 2 (owned/no-compose) expected skip message" "$OUT"
fi
if docker_called; then
  fail "case 2 (owned/no-compose) must NOT invoke docker" "$(cat "$WORK/docker.log")"
fi
echo "    case 2 (owned/no dir)   OK - skipped, no docker call"

# --- 3. owned with a valid compose file ------------------------------------
reset_log
BACKEND="$WORK/backend"
mkdir -p "$BACKEND"
echo "services: {}" > "$BACKEND/docker-compose-falkordb.yml"
cat > "$CFG" <<JSON
{ "enabled": true, "startedBySetup": true, "backendDir": "$BACKEND" }
JSON
OUT="$(run)"
if ! docker_called; then
  fail "case 3 (owned/valid) expected a docker call" "$OUT"
fi
if ! grep -q "compose -p graphiti" "$WORK/docker.log"; then
  fail "case 3 (owned/valid) docker args missing 'compose -p graphiti'" "$(cat "$WORK/docker.log")"
fi
if ! grep -qw "down" "$WORK/docker.log"; then
  fail "case 3 (owned/valid) docker args missing 'down'" "$(cat "$WORK/docker.log")"
fi
# marker must be cleared after a successful teardown
if ! grep -q '"startedBySetup": false' "$CFG"; then
  fail "case 3 (owned/valid) expected startedBySetup cleared to false" "$(cat "$CFG")"
fi
echo "    case 3 (owned/valid)    OK - docker compose down + marker cleared"

echo
echo "PASS: uninstall ownership gate behaves correctly (owned tears down, unowned/foreign skipped)."
