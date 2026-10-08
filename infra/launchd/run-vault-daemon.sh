#!/usr/bin/env bash
# Wrapper so the launchd plist doesn't hardcode a Node path that breaks on
# upgrade. Resolves the repo from this script's own location (no assumption
# about the installation path), then runs the daemon via pnpm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${NOELLE_REPO:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$REPO"

# Prefer pnpm (resolves the workspace + tsx); fall back to a built dist.
if command -v pnpm >/dev/null 2>&1; then
  exec pnpm --filter @noelle/vault-daemon watch
else
  exec node "$REPO/apps/vault-daemon/dist/index.js"
fi
