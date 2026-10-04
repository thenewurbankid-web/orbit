#!/bin/sh
# Start Orbit (macOS and Linux). Double-click it, or run it in a terminal.
# Finds Node.js (Paperclip runs on it, so it is on this computer), then sets Orbit up:
# copies it to your app-data folder, starts it at login, starts it now and opens the Orbit page.
# Run with "uninstall" to remove it again.
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"

ok_node() { [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' >/dev/null 2>&1; }
find_node() {
  {
    command -v node 2>/dev/null
    # The Node that Paperclip itself uses (its launcher names it).
    for shim in "$HOME/.local/bin/paperclipai" "$HOME/.paperclip/bin/paperclipai"; do
      [ -f "$shim" ] && sed -n "s/^exec '\([^']*node\)'.*/\1/p" "$shim"
    done
    echo /opt/homebrew/bin/node; echo /usr/local/bin/node; echo /usr/bin/node
    echo "$HOME/.volta/bin/node"; echo "$HOME/.asdf/shims/node"; echo "$HOME/.local/share/mise/shims/node"
    ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -r
    ls -1d "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -r
    ls -1d "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node 2>/dev/null | sort -r
    ls -1d "$HOME"/.local/share/mise/installs/node/*/bin/node 2>/dev/null | sort -r
  } | while IFS= read -r c; do
    if [ -n "$c" ] && ok_node "$c"; then echo "$c"; break; fi
  done
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  echo ""
  echo "Orbit needs Node.js 20 or newer, and it isn't on this computer yet."
  echo "Install it from https://nodejs.org (the LTS button), then open Start Orbit again."
  echo ""
  exit 1
fi
"$NODE" "$HERE/helper/setup.mjs" "$@"
code=$?
echo ""
exit $code
