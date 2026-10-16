#!/usr/bin/env bash
set -euo pipefail

# Index all projects defined in config.json and start the MCP server.
# Usage:
#   ./scripts/index.sh                # Index all + start server on port 8000
#   ./scripts/index.sh --index-only   # Index only, don't start server
#   ./scripts/index.sh my-app my-lib  # Index specific projects + start server
#   ./scripts/index.sh --port 9000    # Use custom port
#   MCP_PORT=9000 ./scripts/index.sh  # Use custom port (env var)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$MCP_DIR/config.json"
DB_DIR="${DB_DIR:-$MCP_DIR/.codemogger}"

mkdir -p "$DB_DIR"

# Separate flags from project name arguments
INDEX_ONLY=false
SERVER_PORT=""
PROJECT_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --index-only) INDEX_ONLY=true; shift ;;
    --port|-port) SERVER_PORT="$2"; shift 2 ;;
    *) PROJECT_ARGS+=("$1"); shift ;;
  esac
done

# Install dependencies if needed (the indexer uses them too)
if [[ ! -d "$MCP_DIR/node_modules" ]]; then
  echo ""
  echo "=== Installing MCP server dependencies ==="
  (cd "$MCP_DIR" && npm install)   # postinstall applies patches/ via patch-package
fi

# Index through codemogger's patched library (NOT the codemogger CLI, which
# lacks our chunker patches). Exit codes: 0 ok, 1 a project failed,
# 2 bad config / unknown project, 3 the MCP server is already running,
# 4 codemogger not patched (run `npx patch-package`).
export DB_DIR
set +e
node "$MCP_DIR/indexer.js" "${PROJECT_ARGS[@]+${PROJECT_ARGS[@]}}"
INDEX_RC=$?
set -e
if [[ $INDEX_RC -ge 2 ]]; then
  exit $INDEX_RC
elif [[ $INDEX_RC -ne 0 ]]; then
  echo "WARNING: indexing reported failures (exit $INDEX_RC); see output above."
fi

if [[ "$INDEX_ONLY" == true ]]; then
  exit $INDEX_RC
fi

echo ""
echo "=== Starting MCP server ==="
NODE_OPTS=(--max-old-space-size=8192 --heapsnapshot-near-heap-limit=2)
if [[ -n "$SERVER_PORT" ]]; then
  exec node "${NODE_OPTS[@]}" "$MCP_DIR/server.js" --port "$SERVER_PORT"
else
  exec node "${NODE_OPTS[@]}" "$MCP_DIR/server.js"
fi
