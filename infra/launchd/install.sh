#!/usr/bin/env bash
# Install + load the vault-daemon LaunchAgent for the current user.
# Usage: VAULT_DIR=/path/to/context NOELLE_VAULT_PREFIX=workspace/ ./infra/launchd/install.sh
set -euo pipefail

LABEL="com.noelle.vault-daemon"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
VAULT_DIR="${VAULT_DIR:?Set VAULT_DIR to the Markdown context folder}"
VAULT_PREFIX="${NOELLE_VAULT_PREFIX:?Set NOELLE_VAULT_PREFIX to the workspace storage prefix}"
RUN_SCRIPT="$SCRIPT_DIR/run-vault-daemon.sh"
LOG_DIR="$HOME/Library/Logs"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Render XML without treating path characters as replacement syntax.
node --input-type=module - "$SRC" "$DEST" "$RUN_SCRIPT" "$LOG_DIR" "$VAULT_DIR" "$VAULT_PREFIX" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [source, destination, runScript, logDir, vaultDir, prefix] = process.argv.slice(2);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
let xml = readFileSync(source, 'utf8');
for (const [token, value] of Object.entries({ __RUN_SCRIPT__: runScript, __LOG_DIR__: logDir,
  __VAULT_DIR__: vaultDir, __VAULT_PREFIX__: prefix })) xml = xml.replaceAll(token, escape(value));
writeFileSync(destination, xml, { mode: 0o600 });
NODE

# Reload if already loaded.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl enable "gui/$(id -u)/$LABEL"

if launchctl list | grep -q "$LABEL"; then
  echo "Loaded $LABEL (VAULT_DIR=$VAULT_DIR)."
  echo "Logs: $LOG_DIR/noelle-vault-daemon.{out,err}.log"
  echo "Stop: launchctl bootout gui/$(id -u)/$LABEL"
else
  echo "ERROR: $LABEL did not load. Inspect: launchctl print gui/$(id -u)/$LABEL" >&2
  exit 1
fi
