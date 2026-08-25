#!/usr/bin/env bash
# compile.sh — the authoritative blueberry release build.
#
# Everything we care about for a release artifact, in one place:
#   1. GATES   — typecheck (whole graph incl. the fork) + full test suite
#   2. BUILD   — single-binary compile (experimental --bundle --minify path
#                first: esbuild-embedded, smaller + faster startup; falls
#                back to plain compile if the experimental binary fails smoke)
#   3. SMOKE   — binary boots (fork main linked in), reports its version, and
#                PROVES DB-only persistence end-to-end (0 .jsonl, rows in db)
#   4. RELEASE — platform-tagged artifact (self-update naming contract:
#                dist/blueberry-<os>-<arch>) + SHA256 + size report
#
# Usage: bash compile.sh          (full pipeline)
#        SKIP_GATES=1 bash compile.sh   (iterate on build/smoke only)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
OUT_DIR="$REPO_ROOT/dist"
ENTRY="src/cli/entry.ts"
ASSETS=(
  --include pi/packages/coding-agent/src/modes/interactive/theme
  --include pi/packages/coding-agent/src/modes/interactive/assets
  --include pi/packages/coding-agent/src/core/export-html
)
PLATFORM="$(deno eval 'console.log(`${Deno.build.os}-${Deno.build.arch}`)')"
ARTIFACT="$OUT_DIR/blueberry-$PLATFORM"

say()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. gates ────────────────────────────────────────────────────────────────
if [ "${SKIP_GATES:-0}" != "1" ]; then
  say "gate: typecheck (src + test + extensions + fork graph)"
  deno check src/ test/ extensions/ > /tmp/bb-check.log 2>&1 || { tail -20 /tmp/bb-check.log; die "typecheck failed"; }
  ok "typecheck clean"

  say "gate: full test suite"
  deno test -A test/ > /tmp/bb-test.log 2>&1 || { tail -20 /tmp/bb-test.log; die "tests failed"; }
  ok "tests: $(grep -oE '[0-9]+ passed' /tmp/bb-test.log | tail -1)"
fi

# ── 2. build ────────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
BUILD_MODE=""

try_compile() {
  local extra_flags="$1" out="$2"
  # shellcheck disable=SC2086
  deno compile -A ${extra_flags} "${ASSETS[@]}" --output "$out" "$ENTRY" > /tmp/bb-compile.log 2>&1
}

say "build: compile (plain)"
# Experimental --bundle/--minify is SHELVED (2025-08-25): the fork's theme
# loader reads dark.json via an import.meta.url-relative path that lands in
# esbuild's temp dist/ layout at runtime — the binary fails smoke. Plain
# compile embeds the module graph verbatim and passes everything.
try_compile "" "$OUT_DIR/blueberry" || { cat /tmp/bb-compile.log; die "compile failed"; }
BUILD_MODE="plain"
ok "built [$BUILD_MODE] → $OUT_DIR/blueberry"

# ── 3. smoke ────────────────────────────────────────────────────────────────
# The smoke must run against the EXPERIMENTAL binary as-built; if it fails
# there but passes plain, rebuild plain — never ship an unproven artifact.
smoke() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  "$bin" --version > /dev/null 2>&1 || return 1

  # DB-only persistence proof: full session through the compiled fork.
  local W; W="$(mktemp -d /tmp/bb-compile-smoke.XXXXXX)"
  mkdir -p "$W/agent"
  if ! PI_OFFLINE=1 PI_CODING_AGENT_DIR="$W/agent" BLUEBERRY_DB="$W/agent/blueberry.db" \
      timeout 90 "$bin" -p "reply: compile-smoke-ok" > /dev/null 2>&1; then
    # the model call may legitimately fail (no sandbox auth); persistence
    # surviving that IS the property under test — verify rows below either way
    true
  fi
  local jsonl rows
  jsonl="$(find "$W/agent" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  rows="$(deno eval "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync('$W/agent/blueberry.db',{readOnly:true});console.log(db.prepare('SELECT COUNT(*) n FROM sessions').get().n)" 2>/dev/null || echo 0)"
  rm -rf "$W"
  [ "$jsonl" = "0" ] && [ "$rows" -ge 1 ]
}

say "smoke: boot + DB-only persistence (the single-binary proof)"
smoke "$OUT_DIR/blueberry" || die "binary failed smoke (boot or DB-only persistence)"
ok "smoke passed"

# ── 4. release artifact ─────────────────────────────────────────────────────
say "release: tag + checksum"
cp "$OUT_DIR/blueberry" "$ARTIFACT"
( cd "$OUT_DIR" && shasum -a 256 "blueberry-$PLATFORM" > "blueberry-$PLATFORM.sha256" )
ok "artifact: $ARTIFACT"
du -h "$OUT_DIR/blueberry" "$ARTIFACT" | awk '{printf "  %8s  %s\n", $1, $2}'
cat "$OUT_DIR/blueberry-$PLATFORM.sha256"
echo
ok "done [$BUILD_MODE] — $(deno eval 'console.log(`${Deno.build.os}/${Deno.build.arch}`)') · $(date -u +%Y-%m-%dT%H:%MZ)"
