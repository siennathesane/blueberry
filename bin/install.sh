#!/bin/sh
# blueberry installer — curl-able, POSIX sh (runs in dash/git-bash alike).
#
#   curl -fsSL https://raw.githubusercontent.com/siennathesane/blueberry/mainline/bin/install.sh | sh
#
# What it does:
#   1. detects os/arch (the release asset naming contract: blueberry-<os>-<arch>)
#   2. fetches the latest release metadata from the GitHub API
#   3. downloads the binary + its .sha256 sidecar, VERIFIES, then installs
#   4. installs to ~/.blueberry/bin unless BB_INSTALL_DIR is set
#   5. prints the PATH line to add (doesn't touch rc files uninvited)
#
# Env overrides: VERSION (a release tag, default: latest), BB_INSTALL_DIR,
# GITHUB_TOKEN (private repos), REPO (default siennathesane/blueberry).
set -eu

REPO="${REPO:-siennathesane/blueberry}"
VERSION="${VERSION:-latest}"
INSTALL_DIR="${BB_INSTALL_DIR:-$HOME/.blueberry/bin}"
TOKEN="${GITHUB_TOKEN:-}"

say() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die() {
  printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# ── platform detect (must match compile.sh's <os>-<arch> tags) ───────────────
os() {
  case "$(uname -s)" in
  Darwin) echo "darwin" ;;
  Linux) echo "linux" ;;
  MINGW* | MSYS* | CYGWIN*) echo "windows" ;;
  *) die "unsupported OS: $(uname -s)" ;;
  esac
}
arch() {
  case "$(uname -m)" in
  arm64 | aarch64) echo "aarch64" ;;
  x86_64 | amd64) echo "x86_64" ;;
  *) die "unsupported arch: $(uname -m)" ;;
  esac
}
OS="$(os)"
ARCH="$(arch)"
PLATFORM="$OS-$ARCH"
EXT=""
[ "$OS" = "windows" ] && EXT=".exe"
ASSET="blueberry-$PLATFORM$EXT"

# ── tools ────────────────────────────────────────────────────────────────────
fetch() { # fetch <url> → stdout (follows redirects; token if set)
  if [ -n "$TOKEN" ]; then
    curl -fsSL -H "Authorization: Bearer $TOKEN" "$1"
  else
    curl -fsSL "$1"
  fi
}

API="https://api.github.com/repos/$REPO/releases"

# ── resolve release ──────────────────────────────────────────────────────────
say "finding release for $PLATFORM"
if [ "$VERSION" = "latest" ]; then
  RELEASE_JSON="$(fetch "$API/latest")" || die "no releases found (is the repo public? or set GITHUB_TOKEN)"
else
  RELEASE_JSON="$(fetch "$API/tags/$VERSION")" || die "release $VERSION not found"
fi

TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$TAG" ] || die "could not parse tag_name from release payload"

# find the browser_download_url for our asset (first match wins)
URL="$(printf '%s' "$RELEASE_JSON" |
  tr ',' '\n' |
  grep -B0 "browser_download_url" |
  sed -n "s/.*browser_download_url\": *\"\\([^\"]*\\)\".*/\\1/p" |
  grep "/$ASSET\$" |
  head -1)"
[ -n "$URL" ] || die "release $TAG has no asset named $ASSET"
ok "release $TAG · $ASSET"

# ── download + verify ────────────────────────────────────────────────────────
TMP="$(mktemp -d "${TMPDIR:-/tmp}/bb-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

say "downloading"
fetch "$URL" >"$TMP/$ASSET" || die "download failed"
fetch "$URL.sha256" >"$TMP/$ASSET.sha256" 2>/dev/null || die "no .sha256 sidecar on the release — refusing to install unverified"

say "verifying sha256"
if command -v sha256sum >/dev/null 2>&1; then
  SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA="shasum -a 256"
else die "no sha256 tool found (need sha256sum or shasum)"; fi
(cd "$TMP" && $SHA -c "$ASSET.sha256" >/dev/null 2>&1) || die "checksum mismatch — download corrupted or tampered; refusing to install"
ok "checksum verified"

# ── install ──────────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
BIN="$INSTALL_DIR/blueberry$EXT"
chmod 755 "$TMP/$ASSET"
# atomic-ish: install to temp name in the target dir, then rename over
cp "$TMP/$ASSET" "$INSTALL_DIR/.blueberry-install.tmp"
mv -f "$INSTALL_DIR/.blueberry-install.tmp" "$BIN"
ok "installed $BIN"

"$BIN" --version 2>/dev/null || true

# ── PATH advice ──────────────────────────────────────────────────────────────
case ":$PATH:" in
*":$INSTALL_DIR:"*)
  ok "on PATH already — run: blueberry"
  ;;
*)
  printf '\n'
  printf '\033[1;33madd to PATH (in your shell rc):\033[0m\n'
  printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
  printf 'then run: blueberry\n'
  ;;
esac
printf '\n'
ok "done — first run will create ~/.blueberry (run /login once if auth.json wasn't carried over)"
