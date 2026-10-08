#!/usr/bin/env bash
# Mirror the noelle browser actuator builds (LinkedIn/Lyra, X/Vega, Reddit/Orion)
# from the Mac mini onto this laptop, over Tailscale, so flatpak Chrome's
# load-unpacked dirs always match the Mac's last build. The Mac stays the backend
# + canonical build host; this pulls each actuator's `dist-unpacked` (the exact
# extension the Mac last shipped). Run by a systemd user timer on the laptop (see
# docs/linkedin-actuator-second-host.md).
#
# Each actuator's `build` script is `wxt build` followed by an ATOMIC swap into
# apps/<ext>/dist-unpacked, so a pull can never catch a half-written build — the
# dir is renamed into place in one step on the Mac.
#
# Read-only pull. It never posts, never touches the Mac. Safe to run on a timer.
#
# Env overrides:
#   NOELLE_MAC_HOST       Tailscale MagicDNS name or IP of the Mac (default: macmini)
#   NOELLE_MAC_USER       SSH user on the build host               (required)
#   NOELLE_REMOTE_REPO    absolute checkout path on the build host (required)
#   NOELLE_ACTUATORS_DIR  local dir holding the per-actuator load dirs
#                                                                  (default: ~/noelle-actuators)
#   NOELLE_ACTUATORS      space-separated actuator list to sync
#                                       (default: "linkedin-actuator x-actuator reddit-actuator")
set -euo pipefail

MAC_HOST="${NOELLE_MAC_HOST:-macmini}"
MAC_USER="${NOELLE_MAC_USER:?Set NOELLE_MAC_USER to the build host SSH user}"
REMOTE_REPO="${NOELLE_REMOTE_REPO:?Set NOELLE_REMOTE_REPO to the build host checkout path}"
LOCAL_ROOT="${NOELLE_ACTUATORS_DIR:-$HOME/noelle-actuators}"
read -r -a ACTUATORS <<< "${NOELLE_ACTUATORS:-linkedin-actuator x-actuator reddit-actuator}"

SSH_CMD="ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

synced=0
skipped=0
for ext in "${ACTUATORS[@]}"; do
  remote_dir="${REMOTE_REPO}/apps/${ext}/dist-unpacked"
  local_dir="${LOCAL_ROOT}/${ext}"
  mkdir -p "$local_dir"

  # Guard against a MISSING or EMPTY remote build (e.g. a fresh checkout before
  # its first actuator build, or the brief window mid-atomic-swap). Without this,
  # rsync --delete would blank a working load dir and break the extension on next
  # reload. A present-but-manifest-less remote => skip and keep the local copy.
  if ! $SSH_CMD "${MAC_USER}@${MAC_HOST}" "test -f '${remote_dir}/manifest.json'" 2>/dev/null; then
    echo "$(date -Is) actuator-sync: SKIP ${ext} (no manifest on Mac — unbuilt or mid-swap)"
    skipped=$((skipped + 1))
    continue
  fi

  # --delete => byte-faithful mirror (a file removed on the Mac is removed here).
  rsync -az --delete --timeout=30 -e "$SSH_CMD" \
    "${MAC_USER}@${MAC_HOST}:${remote_dir}/" "${local_dir}/"
  n=$(find "$local_dir" -type f | wc -l | tr -d ' ')
  echo "$(date -Is) actuator-sync: mirrored ${ext} (${n} files) from ${MAC_USER}@${MAC_HOST}"
  synced=$((synced + 1))
done

# Legacy single-dir load path (pre-thin-client setup). If a Chrome profile still
# loads ~/noelle-actuator/dist-unpacked, keep it fresh from the plural copy so it
# never runs stale bits. Drop this block once every profile loads the plural dir.
LEGACY_DIR="$HOME/noelle-actuator/dist-unpacked"
if [ -d "$LEGACY_DIR" ] && [ -f "${LOCAL_ROOT}/linkedin-actuator/manifest.json" ]; then
  rsync -a --delete "${LOCAL_ROOT}/linkedin-actuator/" "${LEGACY_DIR}/"
  echo "$(date -Is) actuator-sync: refreshed legacy linkedin dir"
fi

echo "$(date -Is) actuator-sync: done (${synced} synced, ${skipped} skipped)"
# Nonzero exit if NOTHING synced makes the systemd service log a clear failure
# instead of a silent green run, so a broken build host is visible in the journal.
[ "$synced" -gt 0 ] || exit 1

# NOTE: a load-unpacked extension does NOT hot-reload when its files change on
# disk. After a sync that changed content, reload the extension in
# chrome://extensions and reload its target tab to pick it up (the content-script
# locator only re-injects on page load). The extensions also self-reload when the
# api-vm serves a newer build stamp; the manual reload is the reliable step.
