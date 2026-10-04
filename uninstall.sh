#!/bin/sh
# Uninstall Orbit (macOS and Linux): stops it and removes it from login. Your Orbit folder with its
# settings is kept; add "-s -- --delete-data" to the line to remove it as well.
#   curl -fsSL https://thenewurbankid-web.github.io/orbit/uninstall.sh | sh
set -eu
case "$(uname -s)" in
  Darwin) BASE="$HOME/Library/Application Support/Orbit" ;;
  *) BASE="${XDG_DATA_HOME:-$HOME/.local/share}/orbit" ;;
esac
NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || NODE="$(sed -n "s/^exec '\([^']*node\)'.*/\1/p" "$HOME/.local/bin/paperclipai" 2>/dev/null || true)"
[ -n "$NODE" ] || for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do [ -x "$c" ] && NODE="$c" && break; done
if [ ! -f "$BASE/app/setup.mjs" ]; then echo "Orbit isn't installed on this computer. Nothing to do."; exit 0; fi
[ -n "$NODE" ] || { echo "Couldn't find Node.js to run the uninstaller."; exit 1; }
"$NODE" "$BASE/app/setup.mjs" uninstall "$@"
