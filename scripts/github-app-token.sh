#!/usr/bin/env bash
# scripts/github-app-token.sh
#
# Mint a short-lived (~1h) GitHub App installation access token for the
# `Noelle VM Deployer` GitHub App and print it to stdout (single line, no
# trailing newline). Used by infra/agents-vm/deploy.sh to authenticate
# `git fetch` against the configured repository without persisting a PAT
# on the VM.
#
# Reads three GCP secrets from project `noelle-agents`:
#   - noelle-github-app-private-key      (PEM contents)
#   - noelle-github-app-id               (numeric App ID)
#   - noelle-github-app-installation-id  (numeric Installation ID)
#
# The caller's environment (or the attached GCE SA on noelle-vm-0) must
# have `roles/secretmanager.secretAccessor` on each of those three secrets.
#
# Dependencies: bash, openssl, curl, base64, gcloud. No Node, no Python.
#
# Exit codes:
#   0  success — installation token printed to stdout
#   1  any failure — message on stderr, nothing on stdout

set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-noelle-agents}"

die() {
  printf 'github-app-token: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"
}

require_cmd openssl
require_cmd curl
require_cmd base64
require_cmd gcloud

# Portable URL-safe base64 (no padding, no newlines).
b64url() {
  # `base64 -w0` is GNU-specific; fall back to `tr -d '\n'` for BSD/macOS.
  if base64 --help 2>&1 | grep -q -- '-w'; then
    base64 -w0 | tr '+/' '-_' | tr -d '='
  else
    base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='
  fi
}

fetch_secret() {
  local name="$1"
  gcloud secrets versions access latest \
    --secret="$name" \
    --project="$GCP_PROJECT" 2>/dev/null \
    || die "failed to read secret: $name (check IAM / project=$GCP_PROJECT)"
}

APP_ID="$(fetch_secret noelle-github-app-id | tr -d '[:space:]')"
INSTALLATION_ID="$(fetch_secret noelle-github-app-installation-id | tr -d '[:space:]')"
PRIVATE_KEY="$(fetch_secret noelle-github-app-private-key)"

[[ -n "$APP_ID" ]] || die "noelle-github-app-id is empty"
[[ -n "$INSTALLATION_ID" ]] || die "noelle-github-app-installation-id is empty"
[[ -n "$PRIVATE_KEY" ]] || die "noelle-github-app-private-key is empty"

# Write the PEM to a 0600 tmpfile because `openssl dgst -sign` wants a path,
# and feeding via /dev/stdin breaks on some openssl builds. Clean up on exit.
KEY_FILE="$(mktemp -t noelle-gh-app-key.XXXXXX)"
chmod 600 "$KEY_FILE"
trap 'rm -f "$KEY_FILE"' EXIT
printf '%s' "$PRIVATE_KEY" > "$KEY_FILE"

# JWT: 9-min expiry (under GitHub's 10-min ceiling), iat backdated 60s to
# absorb clock skew.
NOW="$(date +%s)"
IAT="$((NOW - 60))"
EXP="$((NOW + 540))"

HEADER='{"alg":"RS256","typ":"JWT"}'
PAYLOAD="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID")"

HEADER_B64="$(printf '%s' "$HEADER" | b64url)"
PAYLOAD_B64="$(printf '%s' "$PAYLOAD" | b64url)"
SIGNING_INPUT="${HEADER_B64}.${PAYLOAD_B64}"

SIGNATURE_B64="$(printf '%s' "$SIGNING_INPUT" \
  | openssl dgst -sha256 -sign "$KEY_FILE" \
  | b64url)" || die "openssl JWT signing failed"

JWT="${SIGNING_INPUT}.${SIGNATURE_B64}"

# Exchange the JWT for an installation token.
RESPONSE="$(curl -sS -X POST \
  -H "Authorization: Bearer ${JWT}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens")" \
  || die "curl to GitHub failed"

# Minimal JSON parse — the token field is a flat string. Avoid a jq dependency.
TOKEN="$(printf '%s' "$RESPONSE" \
  | tr -d '\n' \
  | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\(ghs_[^"]*\)".*/\1/p')"

if [[ -z "$TOKEN" ]]; then
  # Surface the GitHub error to stderr so the operator can see what broke.
  printf 'github-app-token: no token in GitHub response:\n%s\n' "$RESPONSE" >&2
  exit 1
fi

# stdout: token only, no trailing newline — easy to capture with $(...).
printf '%s' "$TOKEN"
