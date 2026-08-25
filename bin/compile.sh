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
  --include pi/packages/coding-agent/src/modes/interactive/assets
  --include pi/packages/coding-agent/src/core/export-html
)
PLATFORM="$(deno eval 'console.log(`${Deno.build.os}-${Deno.build.arch}`)')"
# Windows: deno compile appends .exe to --output; every artifact path must match
EXT="$(deno eval 'console.log(Deno.build.os === "windows" ? ".exe" : "")')"
ARTIFACT="$OUT_DIR/blueberry-$PLATFORM$EXT"

# portable tooling: sha256sum (linux) / shasum (macos), timeout/gtimeout (macos
# ships neither timeout nor System32's broken one in git-bash; git-bash HAS
# coreutils timeout, plain cmd does not)
SHA_TOOL=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_TOOL="shasum -a 256"
else
  echo "no sha256 tool" >&2
  exit 1
fi
TIMEOUT_BIN=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_BIN=timeout
[ -z "$TIMEOUT_BIN" ] && command -v gtimeout >/dev/null 2>&1 && TIMEOUT_BIN=gtimeout
run_to() {
  # $1 is always the seconds budget; without a timeout binary we drop it
  # (running bare beats not running — the smoke is fast either way)
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$@"; else shift; "$@"; fi
}

say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# ── 1. gates ────────────────────────────────────────────────────────────────
if [ "${SKIP_GATES:-0}" != "1" ]; then
  say "gate: typecheck (src + test + extensions + fork graph)"
  deno check src/ test/ extensions/ smoke/ >/tmp/bb-check.log 2>&1 || {
    tail -20 /tmp/bb-check.log
    die "typecheck failed"
  }
  ok "typecheck clean"

  say "gate: full test suite"
  deno test -A test/ >/tmp/bb-test.log 2>&1 || {
    tail -20 /tmp/bb-test.log
    die "tests failed"
  }
  ok "tests: $(grep -oE '[0-9]+ passed' /tmp/bb-test.log | tail -1)"
fi

# ── 2. build ────────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
BUILD_MODE=""

try_compile() {
  local extra_flags="$1" out="$2"
  # shellcheck disable=SC2086
  deno compile -A ${extra_flags} "${ASSETS[@]}" --output "$out" "$ENTRY" >/tmp/bb-compile.log 2>&1
}

say "build: compile (plain)"
# Experimental --bundle/--minify is SHELVED (2025-08-25): the fork's theme
# loader reads dark.json via an import.meta.url-relative path that lands in
# esbuild's temp dist/ layout at runtime — the binary fails smoke. Plain
# compile embeds the module graph verbatim and passes everything.
try_compile "" "$OUT_DIR/blueberry" || {
  cat /tmp/bb-compile.log
  die "compile failed"
}
BIN="$OUT_DIR/blueberry$EXT"
BUILD_MODE="plain"
ok "built [$BUILD_MODE] → $BIN"

# ── 3. smoke ────────────────────────────────────────────────────────────────
# The smoke must run against the EXPERIMENTAL binary as-built; if it fails
# there but passes plain, rebuild plain — never ship an unproven artifact.
smoke() {
  local bin="$1"
  [ -x "$bin" ] || { echo "smoke diag: binary not executable" >&2; return 1; }
  "$bin" --version >/dev/null 2>&1 || { echo "smoke diag: --version failed" >&2; return 1; }

  # DB-only persistence proof: a full session through the compiled fork using
  # the deterministic faux provider (scripted reply, no network, no auth) —
  # hermetic on CI. Loading the extension via --extension also proves jiti
  # extension loading works inside deno-compile binaries.
  local W rc jsonl rows
  W="$(mktemp -d "${TMPDIR:-/tmp}/bb-compile-smoke.XXXXXX")"
  mkdir -p "$W/agent"
  rc=0
  PI_OFFLINE=1 PI_CODING_AGENT_DIR="$W/agent" BLUEBERRY_DB="$W/agent/blueberry.db" \
    run_to 90 "$bin" --extension "$REPO_ROOT/smoke/faux-provider.ts" --model faux/faux-1 -p "reply: compile-smoke-ok" >"$W/out.log" 2>"$W/err.log" || rc=$?
  jsonl="$(find "$W/agent" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  rows="$(deno eval "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync('$W/agent/blueberry.db',{readOnly:true});console.log(db.prepare('SELECT COUNT(*) n FROM sessions').get().n)" 2>/dev/null || echo 0)"
  if [ "$jsonl" != "0" ] || [ "$rows" -lt 1 ]; then
    echo "smoke diag: rc=$rc jsonl=$jsonl rows=$rows" >&2
    echo "smoke diag: stderr tail:" >&2
    tail -5 "$W/err.log" >&2 2>/dev/null || true
    echo "smoke diag: agent dir:" >&2
    ls -la "$W/agent" >&2 2>/dev/null || true
    rm -rf "$W"
    return 1
  fi
  rm -rf "$W"
  return 0
}

say "smoke: boot + DB-only persistence (the single-binary proof)"
smoke "$BIN" || die "binary failed smoke (boot or DB-only persistence)"
ok "smoke passed"

# ── 4. release artifact ─────────────────────────────────────────────────────
say "release: tag + checksum"
cp "$BIN" "$ARTIFACT"
(cd "$OUT_DIR" && $SHA_TOOL "blueberry-$PLATFORM$EXT" >"blueberry-$PLATFORM$EXT.sha256")
ok "artifact: $ARTIFACT"
du -h "$BIN" "$ARTIFACT" | awk '{printf "  %8s  %s\n", $1, $2}'
cat "$OUT_DIR/blueberry-$PLATFORM.sha256"
echo
ok "done [$BUILD_MODE] — $(deno eval 'console.log(`${Deno.build.os}/${Deno.build.arch}`)') · $(date -u +%Y-%m-%dT%H:%MZ)"
