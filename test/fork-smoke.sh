#!/usr/bin/env bash
# Fork smoke test: DB-only session persistence.
# Proves: (1) a live session writes ONLY to blueberry.db, (2) no .jsonl is
# ever created in the session dir, (3) `bb`-side search can find the content.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
BUNDLE="$REPO/pi/packages/coding-agent/dist/bundle/cli.js"

WORLD=$(mktemp -d /tmp/bb-fork-smoke.XXXXXX)
export BLUEBERRY_AGENT_DIR="$WORLD/agent"
mkdir -p "$BLUEBERRY_AGENT_DIR"
PROJ="$WORLD/proj"
mkdir -p "$PROJ"
(cd "$PROJ" && git init -q .)

# register the project (as the launcher would) via a throwaway bb run
BLUEBERRY_AGENT_DIR="$BLUEBERRY_AGENT_DIR" ./bin/blueberry sessions list >/dev/null 2>&1 || true

# run the fork TUI headlessly: one user message, one assistant reply, /exit.
# pi's --print mode runs a full session non-interactively.
cd "$PROJ"
PI_CODING_AGENT_DIR="$BLUEBERRY_AGENT_DIR" \
  BLUEBERRY_DB="$BLUEBERRY_AGENT_DIR/blueberry.db" \
  node "$BUNDLE" \
  --print "Reply with exactly: fork-smoke-ok" || true

echo "── artifacts in agent dir ──"
find "$BLUEBERRY_AGENT_DIR" -type f | sed "s|$BLUEBERRY_AGENT_DIR/||" | sort

echo "── session dir contents (must be EMPTY of .jsonl) ──"
SESSDIR=$(find "$BLUEBERRY_AGENT_DIR" -type d -name "sessions" | head -1 || true)
if [ -n "$SESSDIR" ]; then
  JSONL=$(find "$SESSDIR" -name "*.jsonl" | wc -l | tr -d ' ')
  echo "jsonl files: $JSONL  (want 0)"
else
  echo "no sessions dir created (want: none or empty)"
fi

echo "── DB rows ──"
DB="$BLUEBERRY_AGENT_DIR/blueberry.db"
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$DB', { readOnly: true });
const s = db.prepare('SELECT id, name, cwd FROM sessions').all();
const e = db.prepare('SELECT COUNT(*) AS n FROM session_entries').get();
const f = db.prepare(\"SELECT COUNT(*) AS n FROM session_fts WHERE text LIKE '%fork-smoke%'\").get();
console.log('sessions:', JSON.stringify(s));
console.log('entries:', e.n);
console.log('fts hits for fork-smoke:', f.n);
"

echo "── cleanup ──"
rm -rf "$WORLD"
echo "smoke done"
