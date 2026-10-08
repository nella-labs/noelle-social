#!/usr/bin/env bash
# Wrapper invoked by every systemd unit. Picks a Node binary, then execs the
# requested worker. Worker kind comes as the first arg: discovery|classifier|drafter|send|profiler|ideation|content-publish|account-feeder.
# The Account Feeder entry is workers/account-feeder.ts (clean kind "account-feeder",
# so KIND maps straight to dist/workers/account-feeder.js — no alias needed).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KIND="${1:?usage: run.sh <discovery|classifier|drafter|send|profiler|ideation|content-publish|account-feeder>}"
shift || true

ENTRY="$HERE/dist/workers/${KIND}.js"
if [ ! -f "$ENTRY" ]; then
  echo "run.sh: entrypoint not found: $ENTRY" >&2
  exit 78
fi

if [ -n "${NODE_BIN:-}" ] && [ -x "$NODE_BIN" ]; then
  :
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
else
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "run.sh: no node binary found" >&2
  exit 78
fi

export NOELLE_WORKER_KIND="$KIND"
exec "$NODE_BIN" "$ENTRY" "$@"
