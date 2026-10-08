#!/usr/bin/env bash
# pm2 wrapper for the actuator-doctor loop. Picks a Node binary then execs the
# compiled entry. No args.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENTRY="$HERE/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "run.sh: entrypoint not found: $ENTRY (build first)" >&2
  exit 78
fi
if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then :
elif [ -x /opt/homebrew/bin/node ]; then NODE_BIN=/opt/homebrew/bin/node
else NODE_BIN="$(command -v node || true)"; fi
if [ -z "$NODE_BIN" ]; then echo "run.sh: no node binary found" >&2; exit 78; fi
exec "$NODE_BIN" "$ENTRY" "$@"
