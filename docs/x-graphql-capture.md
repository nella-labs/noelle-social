# Capturing X GraphQL queryIds

The X intern workers talk to `x.com/i/api/graphql/<queryId>/<OperationName>` to
discover tweets, look up handles, and post replies. X rotates these `queryId`
hashes on every web-client release (roughly every few months). When discovery
or send starts logging `404` from graphql, the hashes in
`apps/x-intern/src/lib/x-graphql-ids.ts` need to be re-captured from a
logged-in x.com session and the workers redeployed.

Three operations have to be captured:

| Operation          | Used by                         | How to trigger                                              |
|--------------------|---------------------------------|-------------------------------------------------------------|
| `UserTweets`       | discovery worker                | visit any profile page (e.g. your own)                      |
| `UserByScreenName` | discovery + send (handle → id)  | type a handle into the X search bar and pick a result       |
| `CreateTweet`      | send worker                     | reply to any tweet and click **Send**                       |

## 1. Open a logged-in x.com session

1. Open `https://x.com` in Chrome (or any Chromium browser) and make sure you
   are signed in as the account the workers run on (the configured account).
2. Open DevTools (`Cmd+Opt+I` on macOS).
3. Switch to the **Network** tab.
4. In the filter box at the top of the Network panel, type `graphql`. This
   hides the noise from images, scripts, etc.
5. Tick **Preserve log** so requests stick around across page navigations.

Every request you care about will have a URL of the form:

```
https://x.com/i/api/graphql/<queryId>/<OperationName>?variables=…&features=…
```

The string between `/graphql/` and `/<OperationName>` is the `queryId`. It is
22 characters of `[A-Za-z0-9_-]` (base64url-ish), e.g.
`E3opETHurmVJflFsUBVuUQ`.

## 2. Capture `UserTweets`

1. With DevTools open and the `graphql` filter active, visit your own profile
   (`https://x.com/<your-handle>`).
2. Look in the Network panel for the request whose name starts with
   `UserTweets`.
3. Click it, copy the **Request URL**, and pull out the `queryId`:

   ```
   https://x.com/i/api/graphql/E3opETHurmVJflFsUBVuUQ/UserTweets?variables=…
                              ^^^^^^^^^^^^^^^^^^^^^^^
                              this is the queryId
   ```

Save that 22-char string somewhere; you'll paste it into the updater script
in a minute.

## 3. Capture `UserByScreenName`

1. Click the search box at the top of x.com and type any handle (e.g.
   `elonmusk`).
2. In the search dropdown, click the result for that account.
3. In the Network panel, find the `UserByScreenName` request.
4. Copy the `queryId` segment, same shape as before:

   ```
   https://x.com/i/api/graphql/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName?variables=…
                              ^^^^^^^^^^^^^^^^^^^^^^^
   ```

## 4. Capture `CreateTweet`

This one requires actually posting something, so use a throwaway reply.

1. Pick any tweet (your own, ideally) and click **Reply**.
2. Type something innocuous (`.` works).
3. Click **Reply** to send.
4. In the Network panel, find the `CreateTweet` request. It uses `POST`.
5. Copy the `queryId`:

   ```
   https://x.com/i/api/graphql/oB-5XsHNAbjvARJEc8CZFw/CreateTweet
                              ^^^^^^^^^^^^^^^^^^^^^^^
   ```

6. (Optional) Delete the throwaway reply from x.com once you've grabbed the ID.

## 5. Write the new IDs into the repo

You now have three 22-char strings. There are two ways to commit them.

### Option A, interactive updater (recommended)

From the repo root:

```bash
./scripts/update-x-graphql-ids.sh
```

It prompts for each queryId, validates the shape, rewrites
`apps/x-intern/src/lib/x-graphql-ids.ts` in place, and prints the next steps.

### Option B, edit by hand

Open `apps/x-intern/src/lib/x-graphql-ids.ts` and update each `queryId:` line
inside the `X_GRAPHQL` object. Leave `operationName` alone.

## 6. Verify against the live X API

Before redeploying, confirm the new `UserByScreenName` hash works against
x.com with the production cookies:

```bash
./scripts/verify-x-graphql.sh
```

The script pulls `noelle-worker-x-cookies-ct0` and
`noelle-worker-x-cookies-auth-token` from GCP Secret Manager (project
`noelle-agents`) and hits `UserByScreenName` for the `twitter` account
(guaranteed to exist). On success it prints `OK` and the resolved
`rest_id`. On failure it prints the HTTP status and the first few hundred
bytes of the body so you can see if it was 404 (stale queryId) or 401 (stale
cookies).

## 7. Ship it

Once the verifier passes:

```bash
git add apps/x-intern/src/lib/x-graphql-ids.ts
git commit -m "chore(x-intern): rotate X graphql queryIds"
git push -u origin HEAD
gh pr create
```

After review and publication, update the configured installation through
[the managed runtime](runbook.md). The optional legacy VM deploy script
requires an explicitly configured repository and infrastructure.

## Troubleshooting

- **The Network tab is empty.** Make sure the `graphql` filter is set on the
  Network panel filter row, not in the global address bar. Reload the page
  with DevTools already open.
- **`UserTweets` shows up but no `queryId` in the URL.** You probably clicked
  a `TweetDetail` or `HomeTimeline` request by mistake. Those are different
  operations. Look specifically for `/UserTweets?…`.
- **The verifier returns 401.** Cookies are stale. Re-capture `ct0` and
  `auth_token` from `https://x.com` (DevTools → Application → Cookies) and
  push them to GCP Secret Manager per `docs/runbook.md` §
  "Rotate X cookies".
- **The verifier returns 404 with a fresh hash.** Double-check you copied the
  segment **after** `/graphql/` and **before** `/UserByScreenName`. The
  22-char check in the updater script catches most paste errors.
