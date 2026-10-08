#!/usr/bin/env bash
# Wrapper invoked by every pm2 entry. Picks a Node binary, then execs the
# requested worker. Worker kind comes as the first arg:
# discovery|classifier|profiler|drafter|ideation|post-drafter|feeder.
# NOTE: there is intentionally NO send worker — Lyra never posts to LinkedIn.
#
# Also runs on-demand one-shots (not pm2 apps), which take extra args after the
# kind and exit when done:
#   followup --person <url|/in/slug|slug> [--posts N] [--comments N] [--json]
#     Connection follow-up: scrape a new connection's posts + authored comments
#     and print a brief (common ground, talking points, questions, a follow-up DM).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KIND="${1:?usage: run.sh <discovery|classifier|profiler|drafter|ideation|post-drafter|feeder|followup>}"
shift || true

# The Account Feeder's entry file is account-feeder.ts (account-feeder.js built),
# but pm2 registers it under the clean kind "feeder". Map the kind to its module.
ENTRY_MODULE="$KIND"
if [ "$KIND" = "feeder" ]; then
  ENTRY_MODULE="account-feeder"
fi

ENTRY="$HERE/dist/workers/${ENTRY_MODULE}.js"
if [ ! -f "$ENTRY" ]; then
  echo "run.sh: entrypoint not found: $ENTRY" >&2
  exit 78
fi

# NOTE: one-shot commands (e.g. `followup`) are NOT launched by pm2, so nothing
# injects ~/.noelle/.env for them. The one-shot loads that file itself, in
# TypeScript, with the canonical quote-aware parser (src/lib/dotenv.ts) — pm2
# workers already carry their env, so run.sh does nothing here.

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

# pm2 workers `exec` (the shell is replaced by node, one PID). One-shots run node
# as a CHILD instead, so a signal death (e.g. OOM SIGKILL) surfaces as a real
# 128+N exit code the caller (`noelle lyra followup`) can see, rather than the
# exec'd shell being replaced and the signal collapsing to a null/0 exit.
case "$KIND" in
  followup)
    set +e
    "$NODE_BIN" "$ENTRY" "$@"
    __code=$?
    set -e
    exit "$__code"
    ;;
  *)
    exec "$NODE_BIN" "$ENTRY" "$@"
    ;;
esac
