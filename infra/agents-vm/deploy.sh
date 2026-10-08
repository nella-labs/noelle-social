#!/usr/bin/env bash
# infra/agents-vm/deploy.sh
#
# Runs on noelle-vm-0 as the `noelle-api` user (the operator SSHes in and
# `sudo`s into pull-secrets / systemctl steps). Idempotent.
#
# Steps:
#   1. Update /opt/noelle/repo to the requested ref.
#   2. pnpm install (monorepo) + build apps/x-intern (workers run dist/).
#   3. Sync systemd unit files from infra/systemd/.
#   4. Run scripts/pull-secrets.sh to materialise /etc/noelle/{db,worker}.env.
#   5. Restart api-vm + worker pool, verify /health.
#
# Exit non-zero on any failure so the GitHub Action surfaces a red check.
#
# Layout note: deploys run *in place* against /opt/noelle/repo. The earlier
# version rsynced to a separate APP_DIR at /srv/noelle — that path was never
# created on this VM. The live api-vm.service was hand-installed to point at
# /opt/noelle/repo/apps/api-vm and worked; we've now codified that.

set -euo pipefail

REF="${1:-HEAD}"
REPO_DIR="${REPO_DIR:-/opt/noelle/repo}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:18791/health}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

log "deploy starting (ref=$REF, host=$(hostname))"

# ---- 1. Update repo checkout ----------------------------------------------
# Three cases:
#   (a) $REPO_DIR doesn't exist     → fresh clone
#   (b) $REPO_DIR exists, not a git repo (rsync-deployed legacy) → atomic swap
#   (c) $REPO_DIR is already a git repo → fetch + reset
# Resolve the path to the token-minting script before we cd anywhere.
# When the script doesn't exist yet (very first bootstrap, $REPO_DIR is empty
# or rsync'd without it), the caller must pass SKIP_FETCH=1 to opt out of
# the remote fetch — see below.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_SCRIPT="$SCRIPT_DIR/../../scripts/github-app-token.sh"

# Preserve an existing installation's source unless an override is configured.
REPOSITORY_URL="${NOELLE_REPOSITORY_URL:-}"
if [[ -z "$REPOSITORY_URL" ]]; then
  if [[ -e "$REPO_DIR/.git" ]]; then
    REPOSITORY_URL="$(sudo -u noelle-api git -C "$REPO_DIR" remote get-url origin 2>/dev/null && printf '.')" || {
      log "ERROR: cannot read the checkout's origin as noelle-api" >&2
      exit 1
    }
    # Strip only Git's terminator; embedded or trailing URL newlines are unsafe.
    REPOSITORY_URL="${REPOSITORY_URL%.}"
    REPOSITORY_URL="${REPOSITORY_URL%$'\n'}"
  else
    REPOSITORY_URL="https://github.com/nella-labs/noelle-social.git"
  fi
fi
GITHUB_REPOSITORY_PATTERN='^(https://github[.]com/|git@github[.]com:)[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*$'
if [[ ! "$REPOSITORY_URL" =~ $GITHUB_REPOSITORY_PATTERN ]]; then
  log "ERROR: repository must be a credential-free GitHub HTTPS or git@github.com URL" >&2
  exit 1
fi
# GitHub App authentication uses HTTPS; retain the selected origin's spelling.
REPOSITORY_FETCH_URL="${REPOSITORY_URL/#git@github.com:/https://github.com/}"

# Mint a short-lived GitHub App installation token for this repository.
mint_gh_token() {
  if [[ ! -x "$TOKEN_SCRIPT" ]]; then
    log "ERROR: $TOKEN_SCRIPT missing or not executable"
    log "       (re-run with SKIP_FETCH=1 to bootstrap without GitHub auth)"
    exit 1
  fi
  "$TOKEN_SCRIPT"
}

# Pass authentication through stdin and process-only Git configuration. The
# token stays out of command arguments, remote URLs and persisted Git config.
authenticated_git() {
  local token authorization
  token="$(mint_gh_token)"
  authorization="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
  printf 'AUTHORIZATION: basic %s\n' "$authorization" |
    sudo -u noelle-api bash -c '
      IFS= read -r GIT_CONFIG_VALUE_0
      export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0
      git "$@"
    ' bash "$@"
}

if [[ ! -d "$REPO_DIR" ]]; then
  log "first-time clone into $REPO_DIR"
  sudo install -d -o noelle-api -g noelle-api "$(dirname "$REPO_DIR")"
  if [[ "${SKIP_FETCH:-0}" == "1" ]]; then
    log "SKIP_FETCH=1 set but $REPO_DIR doesn't exist — cannot bootstrap without auth"
    exit 1
  fi
  authenticated_git clone --depth 50 "$REPOSITORY_FETCH_URL" "$REPO_DIR"
elif [[ ! -e "$REPO_DIR/.git" ]]; then
  log "$REPO_DIR exists but isn't a git repo — bootstrapping via atomic swap"
  NEW_DIR="${REPO_DIR}.new"
  sudo rm -rf "$NEW_DIR"
  authenticated_git clone --depth 50 "$REPOSITORY_FETCH_URL" "$NEW_DIR"
  log "stopping noelle-api-vm to swap directories"
  sudo systemctl stop noelle-api-vm
  sudo mv "$REPO_DIR" "${REPO_DIR}.legacy.$(date +%s)"
  sudo mv "$NEW_DIR" "$REPO_DIR"
  # api-vm will be restarted in step 5 after deps + units are in place.
fi
cd "$REPO_DIR"
sudo -u noelle-api git -C "$REPO_DIR" remote set-url origin "$REPOSITORY_URL"
# SKIP_FETCH=1 keeps an existing local checkout without remote authentication.
if [[ "${SKIP_FETCH:-0}" == "1" ]]; then
  HEAD_SHA="$(sudo -u noelle-api git rev-parse --short HEAD)"
  log "SKIP_FETCH=1 — using local checkout @ $HEAD_SHA (no remote fetch)"
else
  authenticated_git fetch --depth 50 "$REPOSITORY_FETCH_URL" "$REF"
  sudo -u noelle-api git reset --hard FETCH_HEAD
  HEAD_SHA="$(sudo -u noelle-api git rev-parse --short HEAD)"
  log "checked out $REF @ $HEAD_SHA"
fi

# ---- 2. Install + build (as the repo owner) -------------------------------
# pnpm MUST run as noelle-api: it owns $REPO_DIR, while the deploy is invoked by
# a sudo-capable user (CI's OS Login account, or an operator) that does NOT own
# the tree — running pnpm as that user EACCES'd on dist/ and produced
# root/foreign-owned artifacts. `sudo -iu` gives noelle-api a login env
# (HOME, PATH, pnpm store) so the store + node_modules + dist stay consistent.
log "pnpm install --frozen-lockfile (as noelle-api)"
sudo -iu noelle-api bash -c "cd '$REPO_DIR' && pnpm install --frozen-lockfile --prod=false"

log "building workspace packages for the worker pool (as noelle-api)"
# Each deployed app includes its workspace dependency closure. Recursive builds
# follow dependency order, with one active build to fit the VM's memory.
# The dashboard is outside these selections.
sudo -iu noelle-api bash -c "cd '$REPO_DIR' && pnpm -r --workspace-concurrency=1 \
  --filter @noelle/x-intern... \
  --filter @noelle/reddit-intern... \
  --filter @noelle/api-vm... \
  build"

# api-vm runs off tsx against TS sources, no build step needed.

# ---- 3. Sync systemd units -------------------------------------------------
UNITS_CHANGED=""
sync_unit() {
  local name="$1"
  local src="$REPO_DIR/infra/systemd/$name"
  local dst="/etc/systemd/system/$name"
  if ! sudo cmp -s "$src" "$dst" 2>/dev/null; then
    log "installing/refreshing $name"
    sudo install -m 0644 -o root -g root "$src" "$dst"
    UNITS_CHANGED=1
  fi
}

sync_unit noelle-api-vm.service
sync_unit noelle-discovery@.service
sync_unit noelle-classifier@.service
sync_unit noelle-drafter@.service
sync_unit noelle-send@.service
sync_unit noelle-profiler@.service
sync_unit noelle-reddit-discovery@.service
sync_unit noelle-reddit-classifier@.service
sync_unit noelle-reddit-drafter@.service

# Remove a legacy unit if it lingered from a prior layout.
if [[ -f /etc/systemd/system/noelle-vm-0-drafter@.service ]]; then
  log "removing legacy noelle-vm-0-drafter@ unit"
  sudo systemctl disable --now 'noelle-vm-0-drafter@*' 2>/dev/null || true
  sudo rm -f /etc/systemd/system/noelle-vm-0-drafter@.service
  UNITS_CHANGED=1
fi

if [[ -n "$UNITS_CHANGED" ]]; then
  sudo systemctl daemon-reload
fi

# ---- 4. Refresh /etc/noelle/{db,worker}.env --------------------------------
log "pulling secrets from GCP Secret Manager"
sudo "$REPO_DIR/scripts/pull-secrets.sh"

# ---- 5. Restart services + health check ------------------------------------
log "restarting noelle-api-vm"
sudo systemctl restart noelle-api-vm

log "enabling + restarting worker pool"
sudo systemctl enable --now \
  noelle-discovery@0 \
  noelle-classifier@0 \
  noelle-send@0 \
  noelle-profiler@0 \
  noelle-drafter@0 noelle-drafter@1 noelle-drafter@2 noelle-drafter@3 \
  noelle-reddit-discovery@0 \
  noelle-reddit-classifier@0 \
  noelle-reddit-drafter@0

# Best-effort restart so picked-up unit changes apply to already-running ones.
sudo systemctl restart \
  'noelle-discovery@*' \
  'noelle-classifier@*' \
