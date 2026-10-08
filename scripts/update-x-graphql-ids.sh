#!/usr/bin/env bash
# scripts/update-x-graphql-ids.sh
#
# Interactive helper that rewrites the pinned X GraphQL queryIds in
# apps/x-intern/src/lib/x-graphql-ids.ts.
#
# X rotates these hashes every UI release. When discovery / send start
# logging 404s from /i/api/graphql, capture fresh queryIds from a logged-in
# x.com session (see docs/x-graphql-capture.md) and run this script.
#
# Run from the repo root.
#   ./scripts/update-x-graphql-ids.sh
#
# The script prompts for three queryIds (UserTweets, UserByScreenName,
# CreateTweet), validates each is a 22-char base64url-ish string, and patches
# them into the TS file in place. It does not touch the SearchTimeline entry
# or the X_FEATURES blob.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$REPO_ROOT/apps/x-intern/src/lib/x-graphql-ids.ts"

if [[ ! -f "$TARGET" ]]; then
  echo "error: $TARGET not found — are you running from the noelle repo root?" >&2
  exit 1
fi

# X queryIds are 22 chars of [A-Za-z0-9_-] (base64url with no padding).
QUERYID_RE='^[A-Za-z0-9_-]{22}$'

prompt_id() {
  local op="$1"
  local value=""
  while true; do
    read -r -p "  $op queryId: " value
    if [[ "$value" =~ $QUERYID_RE ]]; then
      printf '%s' "$value"
      return 0
    fi
    echo "    not a 22-char base64url string (got ${#value} chars). try again." >&2
  done
}

# Patch a single queryId in the TS file. The expected structure is:
#
#   <OperationName>: {
#     queryId: "<22 chars>",
#     operationName: "<OperationName>",
#   },
#
# We use awk to find the `<OperationName>:` line and rewrite the next
# `queryId: "..."` line. This is safer than a global sed since multiple ops
# share the same shape.
patch_id() {
  local op="$1"
  local new="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v op="$op" -v new="$new" '
    BEGIN { armed = 0 }
    {
      line = $0
      if (line ~ ("^[[:space:]]*" op ":[[:space:]]*\\{")) {
        armed = 1
        print line
        next
      }
      if (armed == 1 && line ~ /queryId:[[:space:]]*"[^"]*"/) {
        sub(/queryId:[[:space:]]*"[^"]*"/, "queryId: \"" new "\"", line)
        armed = 0
        print line
        next
      }
      print line
    }
  ' "$TARGET" > "$tmp"

  # Sanity: refuse to write if the new id is not present in the result.
  if ! grep -q "queryId: \"$new\"" "$tmp"; then
    rm -f "$tmp"
    echo "error: failed to patch $op — pattern not found in $TARGET" >&2
    exit 1
  fi

  mv "$tmp" "$TARGET"
}

echo "Updating X GraphQL queryIds in:"
echo "  $TARGET"
echo
echo "Paste the queryId you captured from x.com (22 chars, between /graphql/"
echo "and the operation name). See docs/x-graphql-capture.md for how to grab"
echo "them from DevTools."
echo

USER_TWEETS_ID=$(prompt_id "UserTweets")
USER_BY_SCREEN_NAME_ID=$(prompt_id "UserByScreenName")
CREATE_TWEET_ID=$(prompt_id "CreateTweet")

patch_id "UserTweets"       "$USER_TWEETS_ID"
patch_id "UserByScreenName" "$USER_BY_SCREEN_NAME_ID"
patch_id "CreateTweet"      "$CREATE_TWEET_ID"

echo
echo "Patched. New values:"
grep -E '(UserTweets|UserByScreenName|CreateTweet):|queryId:' "$TARGET" \
  | sed 's/^/  /'

echo
echo "Next steps:"
echo "  1. ./scripts/verify-x-graphql.sh        # confirm cookies + ids work"
echo "  2. git diff apps/x-intern/src/lib/x-graphql-ids.ts"
echo "  3. git add apps/x-intern/src/lib/x-graphql-ids.ts \\"
echo "       && git commit -m 'chore(x-intern): rotate X graphql queryIds' \\"
echo "       && git push -u origin HEAD"
echo "  4. Open a pull request: gh pr create"
echo "  5. After publication, use the managed update path in docs/runbook.md"
