#!/usr/bin/env bash
# One-time setup for the blueberry distribution.
#
# Creates ~/.blueberry (isolated PI_CODING_AGENT_DIR), writes settings.json
# pointing at this repo as a local pi package, carries over auth from
# ~/.pi/agent if present, and installs the carried package list.
#
# Safe to re-run: settings.json is only written when missing or with --force.
set -euo pipefail

AGENT_DIR="${BLUEBERRY_AGENT_DIR:-$HOME/.blueberry}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE="${1:-}"

# Packages carried over from the old setup. Remove lines you don't want;
# blueberry itself is a local path package and is always written to settings.
# (Plan-mode/todo/search get rewritten inside blueberry; pi-lens is replaced
# by blueberry's own native tooling later — neither is carried.)
CARRIED_PACKAGES=(
  "npm:pi-subagents"
  "npm:pi-web-access"
  "npm:pi-mcp-adapter"
)

mkdir -p "$AGENT_DIR"

if [ -f "$AGENT_DIR/settings.json" ] && [ "$FORCE" != "--force" ]; then
  echo "blueberry: $AGENT_DIR/settings.json exists (use --force to overwrite)"
else
  CARRIED_JSON="$(printf '%s\n' "${CARRIED_PACKAGES[@]}" | python3 -c 'import json,sys; print(",\n".join(json.dumps(l.strip()) for l in sys.stdin if l.strip()))')" \
    python3 - "$AGENT_DIR/settings.json" "$REPO_ROOT" <<'PY'
import json, os, sys

settings_path, repo_root = sys.argv[1], sys.argv[2]
carried = os.environ["CARRIED_JSON"]
packages = [repo_root] + ([l.strip() for l in carried.split(",")] if carried else [])
# normalize: strip JSON quoting from carried entries
packages = [packages[0]] + [json.loads(p) for p in packages[1:]]

settings = {
    "theme": "blueberry",
    "defaultProvider": "zai",
    "defaultModel": "glm-5.3",
    "defaultThinkingLevel": "high",
    "packages": packages,
}
with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print(f"blueberry: wrote {settings_path}")
PY
fi

# Claim shift+tab for the mode ring: rebalance thinking to ctrl+shift+t
# (§Design mode ring — a distribution's prerogative via stock pi rebinding)
if [ ! -f "$AGENT_DIR/keybindings.json" ]; then
  cat >"$AGENT_DIR/keybindings.json" <<'KBEOF'
{
  "app.thinking.cycle": "ctrl+shift+t",
  "app.model.cycleForward": "ctrl+m"
}
KBEOF
  echo "blueberry: wrote keybindings.json (thinking → ctrl+shift+t, model cycle → ctrl+m; shift+tab + ctrl+p freed)"
fi

# Carry auth from the old setup if blueberry has none yet.
if [ ! -f "$AGENT_DIR/auth.json" ] && [ -f "$HOME/.pi/agent/auth.json" ]; then
  cp "$HOME/.pi/agent/auth.json" "$AGENT_DIR/auth.json"
  echo "blueberry: carried auth.json from ~/.pi/agent (run /login inside blueberry if stale)"
fi

# Install carried packages into the isolated agent dir.
if command -v pi >/dev/null 2>&1; then
  export PI_CODING_AGENT_DIR="$AGENT_DIR"
  for pkg in ${CARRIED_PACKAGES[@]+"${CARRIED_PACKAGES[@]}"}; do
    echo "blueberry: installing $pkg"
    pi install "$pkg" >/dev/null 2>&1 || echo "  (install failed — run 'pi install $pkg' manually)"
  done
  # Local path package needs no install; the settings entry is enough.
else
  echo "blueberry: 'pi' not on PATH — skip package installs" >&2
fi

echo "blueberry: setup complete — launch with $REPO_ROOT/bin/blueberry"
