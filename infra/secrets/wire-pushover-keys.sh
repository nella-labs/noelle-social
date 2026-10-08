#!/usr/bin/env bash
# Provision configured Pushover credentials from macOS Keychain into the
# selected GCP project's notifier secrets. Values are piped through stdin.
# See infra/secrets/README.md before running this state-changing helper.

set -euo pipefail

PROJECT="${NOELLE_GCP_PROJECT:-}"
KEYCHAIN_SERVICE="${NOELLE_KEYCHAIN_SERVICE:-nervous-system}"
ORG_ID=""

usage() {
  cat <<EOF
Usage: $0 [--org-id <uuid>] [--project <gcp-project>]

  --org-id <uuid>     If set, also write per-org Secret Manager entries
                      (noelle--org--<uuid>--pushover-user-key + -pushover-token)
                      alongside the global fallback. Optional.
  --project <name>    Target GCP project; required unless NOELLE_GCP_PROJECT is set.

Reads PUSHOVER_USER_KEY and PUSHOVER_APP_TOKEN from macOS Keychain
(the configured Keychain service) and writes new versions to Secret Manager.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org-id)   ORG_ID="${2:-}"; shift 2 ;;
    --project)  PROJECT="${2:-}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$PROJECT" ]] || { echo "ERROR: configure --project or NOELLE_GCP_PROJECT." >&2; exit 2; }

# ---- 1. Pull values from Keychain -----------------------------------------

read_keychain() {
  local account="$1"
  local out
  if ! out=$(security find-generic-password \
                -s "$KEYCHAIN_SERVICE" -a "$account" -w 2>/dev/null); then
    echo "ERROR: keychain item $KEYCHAIN_SERVICE / $account not found." >&2
    echo "       Set it with:" >&2
    echo "         security add-generic-password -s \"$KEYCHAIN_SERVICE\" -a $account -w <value>" >&2
    exit 3
  fi
  printf '%s' "$out"
}

# Stored once in variables; passed via stdin only. Never echoed.
USER_KEY="$(read_keychain PUSHOVER_USER_KEY)"
APP_TOKEN="$(read_keychain PUSHOVER_APP_TOKEN)"

if [[ -z "$USER_KEY" || -z "$APP_TOKEN" ]]; then
  echo "ERROR: empty keychain values for PUSHOVER_USER_KEY / PUSHOVER_APP_TOKEN." >&2
  exit 4
fi

# ---- 2. Sanity-check gcloud auth ------------------------------------------

if ! gcloud auth print-access-token --quiet >/dev/null 2>&1; then
  echo "ERROR: gcloud auth tokens are stale. Run \`gcloud auth login\` first." >&2
  exit 5
fi

# ---- 3. Helpers -----------------------------------------------------------

ensure_secret() {
  local name="$1"
  if gcloud secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    return 0
  fi
  echo "  + creating secret $name"
  gcloud secrets create "$name" --project="$PROJECT" --replication-policy=automatic >/dev/null
}

add_version() {
  local name="$1"
  local value="$2"
  ensure_secret "$name"
  # `--data-file=-` reads stdin. Never put a secret on argv.
  printf '%s' "$value" \
    | gcloud secrets versions add "$name" --project="$PROJECT" --data-file=- >/dev/null
  echo "  ✓ wrote new version of $name"
}

# ---- 4. Write global fallback (always) ------------------------------------

echo "→ Writing global fallback secrets in project $PROJECT"
add_version "noelle-worker-pushover-user-key" "$USER_KEY"
add_version "noelle-worker-pushover-token"    "$APP_TOKEN"

# ---- 5. Write per-org overrides (optional) --------------------------------

if [[ -n "$ORG_ID" ]]; then
  echo "→ Writing per-org overrides for org $ORG_ID"
  add_version "noelle--org--${ORG_ID}--pushover-user-key" "$USER_KEY"
  add_version "noelle--org--${ORG_ID}--pushover-token"    "$APP_TOKEN"
fi

# ---- 6. Verify -----------------------------------------------------------

echo
echo "→ Done. Reachable secrets:"
for fragment in pushover-user-key pushover-token; do
  printf "    noelle-worker-%-22s " "$fragment"
  gcloud secrets versions list "noelle-worker-$fragment" \
    --project="$PROJECT" --limit=1 --format="value(name)" 2>/dev/null \
    | sed 's/^/version=/'
done
if [[ -n "$ORG_ID" ]]; then
  for fragment in pushover-user-key pushover-token; do
    name="noelle--org--${ORG_ID}--${fragment}"
    printf "    %s " "$name"
    gcloud secrets versions list "$name" \
      --project="$PROJECT" --limit=1 --format="value(name)" 2>/dev/null \
      | sed 's/^/version=/'
  done
fi

# Unset so the values don't linger in the parent shell.
unset USER_KEY APP_TOKEN
