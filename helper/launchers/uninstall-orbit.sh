#!/bin/sh
# Uninstall Orbit: stops it and removes it from login. Your Orbit folder (settings) is kept;
# run with --delete-data to remove that too.
exec "$(dirname "$0")/start-orbit.sh" uninstall "$@"
