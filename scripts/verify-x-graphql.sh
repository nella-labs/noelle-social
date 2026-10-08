#!/usr/bin/env bash
# scripts/verify-x-graphql.sh
#
# Verifies that the pinned UserByScreenName queryId in
# apps/x-intern/src/lib/x-graphql-ids.ts works against live x.com with the
# production cookies stored in GCP Secret Manager.
#
# Pulls:
#   noelle-worker-x-cookies-ct0          (project noelle-agents)
#   noelle-worker-x-cookies-auth-token   (project noelle-agents)
#
# Calls /i/api/graphql/<queryId>/UserByScreenName for handle "twitter"
# (guaranteed to exist) and reports OK with the resolved rest_id, or the
# HTTP status + body snippet on failure.
#
# Run from anywhere; resolves the repo root via $BASH_SOURCE.
#   ./scripts/verify-x-graphql.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDS_FILE="$REPO_ROOT/apps/x-intern/src/lib/x-graphql-ids.ts"
PROJECT="${PROJECT:-noelle-agents}"
HANDLE="${HANDLE:-twitter}"

if [[ ! -f "$IDS_FILE" ]]; then
  echo "error: $IDS_FILE not found" >&2
  exit 1
fi

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: '$1' not on PATH" >&2
    exit 1
  fi
}
require_bin gcloud
require_bin curl
require_bin jq

# Extract the UserByScreenName queryId from the TS file. We find the
# `UserByScreenName: { … queryId: "<id>" … }` block and pluck out the id.
# Uses portable awk (works on BSD awk / macOS, no gawk-only features).
QUERY_ID=$(awk '
  /UserByScreenName:[[:space:]]*\{/ { armed = 1; next }
  armed == 1 && /queryId:/ { print; exit }
' "$IDS_FILE" | sed -E 's/.*queryId:[[:space:]]*"([^"]+)".*/\1/')

if [[ -z "${QUERY_ID:-}" ]]; then
  echo "error: could not parse UserByScreenName queryId from $IDS_FILE" >&2
  exit 1
fi

echo "Using UserByScreenName queryId: $QUERY_ID"
echo "Resolving handle: @$HANDLE"

CT0=$(gcloud --project="$PROJECT" secrets versions access latest \
  --secret=noelle-worker-x-cookies-ct0)
AUTH_TOKEN=$(gcloud --project="$PROJECT" secrets versions access latest \
  --secret=noelle-worker-x-cookies-auth-token)

if [[ -z "$CT0" || -z "$AUTH_TOKEN" ]]; then
  echo "error: empty cookie value(s) from Secret Manager" >&2
  exit 1
fi

# Same public web bearer that apps/x-intern/src/lib/x-client.ts uses.
WEB_BEARER="AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"

# Minimal variables blob — matches what the production X client sends. We
# do not bother with the giant features blob; UserByScreenName tolerates the
# small one below in the current X build.
VARIABLES='{"screen_name":"'"$HANDLE"'","withSafetyModeUserFields":true}'
FEATURES='{"hidden_profile_likes_enabled":true,"hidden_profile_subscriptions_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"subscriptions_verification_info_is_identity_verified_enabled":true,"subscriptions_verification_info_verified_since_enabled":true,"highlights_tweets_tab_ui_enabled":true,"responsive_web_twitter_article_notes_tab_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true}'

VARIABLES_ENC=$(jq -rn --arg v "$VARIABLES" '$v|@uri')
FEATURES_ENC=$(jq -rn --arg v "$FEATURES"  '$v|@uri')

URL="https://x.com/i/api/graphql/$QUERY_ID/UserByScreenName?variables=$VARIABLES_ENC&features=$FEATURES_ENC"

TMP_BODY=$(mktemp)
trap 'rm -f "$TMP_BODY"' EXIT

HTTP_CODE=$(curl -sS -o "$TMP_BODY" -w "%{http_code}" \
  -H "authorization: Bearer $WEB_BEARER" \
  -H "x-csrf-token: $CT0" \
  -H "cookie: ct0=$CT0; auth_token=$AUTH_TOKEN" \
  -H "user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
  -H "accept-language: en-US,en;q=0.9" \
  -H "content-type: application/json" \
  -H "x-twitter-active-user: yes" \
  -H "x-twitter-auth-type: OAuth2Session" \
  -H "x-twitter-client-language: en" \
  "$URL" || true)

echo "HTTP $HTTP_CODE"

if [[ "$HTTP_CODE" == "200" ]]; then
  REST_ID=$(jq -r '.data.user.result.rest_id // empty' "$TMP_BODY" 2>/dev/null || true)
  if [[ -n "$REST_ID" ]]; then
    echo "OK — @$HANDLE rest_id=$REST_ID"
    exit 0
  fi
  echo "warn: 200 but no rest_id in response. Body snippet:"
  head -c 400 "$TMP_BODY"; echo
  exit 1
fi

echo "FAIL — body snippet:"
head -c 600 "$TMP_BODY"; echo
case "$HTTP_CODE" in
  401|403) echo "hint: cookies look stale. Rotate noelle-worker-x-cookies-* per docs/runbook.md." ;;
  404)     echo "hint: queryId is stale. Re-capture per docs/x-graphql-capture.md and rerun update-x-graphql-ids.sh." ;;
  429)     echo "hint: rate-limited by X. Wait a few minutes and retry." ;;
esac
exit 1
