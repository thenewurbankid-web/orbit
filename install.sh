#!/bin/sh
# Orbit helper, the one-line way (macOS and Linux). The usual way is the Download button on
# https://thenewurbankid-web.github.io/orbit/ ; this does the same thing from a terminal:
#
#   curl -fsSL https://thenewurbankid-web.github.io/orbit/install.sh | sh
#
# It finds Node.js, downloads the Orbit download for this system, checks its SHA-256 against the list
# below, and runs its setup: everything goes in your user folders (no sudo), Orbit starts at login.
set -eu

# Written by helper/build.mjs. ORBIT_REF pins a commit of github.com/thenewurbankid-web/orbit; without
# one, files come from the website itself.
ORBIT_REF="f59f4b91f2dbc2dd91fb93484e62c863cdcb44c4"
SUM_MAC="309515db4c4d4eba0100b16d9cf0457ad7ec45736e84e180422a0931b90a812f"
SUM_LINUX="d6293c371bf07e10de496ed10f36ec7efa6ab06e0369c1691b51db9d2816ce57"
ORBIT_BASE="${ORBIT_BASE:-https://thenewurbankid-web.github.io/orbit}"

say() { printf '%s\n' "$*"; }
stop() { say ""; say "$*"; exit 1; }
[ "$(id -u)" != "0" ] || stop "Please run the line without sudo."

ok_node() { [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' >/dev/null 2>&1; }
find_node() {
  {
    command -v node 2>/dev/null
    for shim in "$HOME/.local/bin/paperclipai" "$HOME/.paperclip/bin/paperclipai"; do
      [ -f "$shim" ] && sed -n "s/^exec '\([^']*node\)'.*/\1/p" "$shim"
    done
    echo /opt/homebrew/bin/node; echo /usr/local/bin/node; echo /usr/bin/node
    echo "$HOME/.volta/bin/node"; echo "$HOME/.asdf/shims/node"
    ls -1d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -r
  } | while IFS= read -r c; do
    if [ -n "$c" ] && ok_node "$c"; then echo "$c"; break; fi
  done
}
NODE="$(find_node)"
[ -n "$NODE" ] || stop "Orbit needs Node.js 20 or newer, and it isn't on this computer yet. Install it from https://nodejs.org (the LTS button), then run the line again."

case "$(uname -s)" in
  Darwin) FILE="Orbit-mac.zip"; SUM="$SUM_MAC" ;;
  Linux) FILE="Orbit-linux.tar.gz"; SUM="$SUM_LINUX" ;;
  *) stop "This line is for macOS and Linux. On Windows, use the Download button on the Orbit page." ;;
esac
[ -n "$SUM" ] || stop "This installer isn't ready yet. Please use the Download button on the Orbit page."
if [ -n "$ORBIT_REF" ] && [ -z "${ORBIT_BASE_FORCE:-}" ]; then SRC="https://raw.githubusercontent.com/thenewurbankid-web/orbit/$ORBIT_REF"; else SRC="$ORBIT_BASE"; fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/orbit.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM
say "… downloading Orbit"
curl -fsSL --retry 2 -m 120 -o "$TMP/$FILE" "$SRC/download/$FILE" || stop "Couldn't download Orbit. Check the internet connection and run the line again."
if command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$TMP/$FILE" | cut -d ' ' -f 1)"; else got="$(sha256sum "$TMP/$FILE" | cut -d ' ' -f 1)"; fi
[ "$got" = "$SUM" ] || stop "The download didn't match what we expected, so nothing was installed. Please try again in a few minutes."
say "✓ Downloaded and checked"
cd "$TMP"
case "$FILE" in *.zip) unzip -q "$FILE" ;; *) tar -xzf "$FILE" ;; esac
DIR="$(ls -d "$TMP"/Orbit "$TMP"/orbit 2>/dev/null | head -n 1)"
"$NODE" "$DIR/helper/setup.mjs"
