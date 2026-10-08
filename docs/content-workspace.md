# Content workspace

The **Content** workspace (`/app/[orgSlug]/content`) is noelle's home for
*original* posts — distinct from the reply/DM approval lanes. It is
cross-platform (LinkedIn/Lyra · X/Vega · Reddit/Orion) with four sections:

| Tab | What it is |
|---|---|
| **Overview** | Cross-platform glance — the weekly tracker today; fuller KPIs land in a later pass. |
| **Ideas** | Research-backed hooks. Generate on demand, Write your own, or push from a skill. |
| **Posts** | Generated drafts to review / edit / Mark ready (copy out by hand — nothing auto-publishes). |
| **Media** | Cross-platform asset library — upload images/video, attach to posts. |

A platform switcher (All · LinkedIn · X · Reddit) scopes the view; **All**
aggregates. The legacy `/approvals/posts` route redirects here.

This replaces content-pipeline's local-JSON + iCloud store with a
**prod-scalable** design: one ingestion contract writing to `noelle.*`, fed by
two producers, surfaced on every device by the existing deploy (Tailscale on
self-host, Vercel in prod).

## Cross-platform fan-out (the core model)

An **idea is the cross-platform source concept**, not a single-platform row.
Generating from one idea fans it out across platforms — by default **3 X versions
and 1 LinkedIn version** ("the three posts for X, and the linkedin post") — each
written in that platform's own voice, prompt, and length limit (X ≤280; LinkedIn
hook-first). This mirrors content-pipeline's `GeneratorRun` → many `Post`s. The
per-platform version count lives in `FRESH_VERSIONS` in `post-drafter-tick.ts`; a
per-platform **+ Version** always adds exactly one.

The post-set **detail view** (`/content/[ideaId]`) shows the variants **side by
side** — an X column and a LinkedIn column — each with its own **versions**
(Prev / Next / **+ Version**) you edit independently (body, char counter, Mark
ready / posted, posted URL). Regenerating one column re-drafts only that
platform; regenerating from the chat re-drafts the whole set. Nothing publishes.

Reddit stays on Orion's *reply* pipeline — it is **not** part of the post-set
fan-out (Orion has no original-post drafter), so the Reddit board is view-only.

## Data model

- `noelle.post_ideas` (0045) — idea cards. `platform` is the **home** platform
  (owning instance). `target_platforms text[]` (0059) is the fan-out set, e.g.
  `{linkedin,x}`; `pending_platforms text[]` (0059) is the subset to (re)draft on
  the next tick (a per-platform "+ Version"; null ⇒ all targets).
- `noelle.post_drafts` (0046) — generated posts (one row per platform per idea;
  multiple rows of the same platform under one idea = its **versions**, no
  longer superseded). `posted_url` (0059) holds the live-post URL.
- `noelle.ideation_requests` (0050) — the operator-triggered ideation queue.
- `noelle.content_edits` (0056) — the edits ledger: a before/after pair per
  operator correction at Mark ready, the highest-quality voice signal.
- `noelle.content_media` (0057) — uploaded images/video, optionally linked to an
  idea/draft; `platform` nullable (a cross-platform asset).
- `noelle.own_post_metrics` (0079) — the **learn loop**: engagement snapshots on
  the operator's OWN published posts, attributed to the `idea_id` that produced
  them (soft ref; `slot_id` reserved). Append-only time-series; latest-per-tweet is
  `distinct on (external_id) order by captured_at desc`. `content_schedule_slots.
  posted_tweet_id` (0079) stores the returned tweet id so a post can be re-read.

## The learn loop (ideas → publish → measure → ideas)

Vega (X) is the only intern that actually publishes, so it's the only one that
can close the loop. Two workers do it:

1. **Capture** — two sweeps append `own_post_metrics` snapshots for the same
   posts (append-only; the readers below decide which snapshot wins):
   - **Apify self-track** — the `ideation` worker runs an interval sweep
     (`NOELLE_X_SELF_TRACK`, default on, every `NOELLE_X_SELF_TRACK_MS` ≈ 6h;
     hosted here because ideation is always alive and already resolves Apify). It
     lists the operator's published X posts from BOTH paths — autonomous
     (`content_schedule_slots.posted_tweet_id`) and **manual** (`post_drafts`
     marked published, where the operator pastes `posted_url`; the tweet id +
     handle are parsed from the URL, so no connected X account is needed). Manual
     is how Vega posts today. It groups by handle, pulls that handle's recent
     tweets via Apify (`userTweets` — no X login, no ban risk), and appends a
     snapshot (likes/reposts/replies; **views is null** — Apify can't see reach).
   - **X-API metrics sweep** — a throttled sweep inside the `content-publish`
     worker (`NOELLE_X_METRICS`, default on, every `NOELLE_X_METRICS_MS` ≈ 3h)
     re-reads those same posts through the **official X API** (`GET /2/tweets`,
     `public_metrics`) using the write-token client already built there (a read
     costs no write budget). This path DOES carry real **impressions** (`views`)
     plus the `slot_id` attribution, so it's the source of the reach number.
     `runContentMetricsTick` keys purely on the tweet id (no handle needed) and
     appends the full snapshot. It's the X-API twin of self-track — same table,
     same latest-per-tweet model. (`packages/x-client` `getTweetMetrics(ids)`
     wraps the batched, OAuth1a/2-signed lookup.)
2. **Feed back** — the X `ideation` worker reads `getOwnPostPerformance` (latest
   snapshot per tweet, joined to `post_ideas` for pillar/angle), rolls it up into
   the operator's best-performing pillars + angles + top posts, and injects a
   "What's already working for YOU" block into the ideation prompt. New ideas
   skew toward the pillars/angles that already perform — as a *pattern* signal,
   never "rewrite this post". `X_IDEATION_OWN_PERF_POSTS=0` disables it.

Non-X agents (Lyra/Orion/Nova-video) never set `posted_tweet_id`, so the
loop is naturally X-only; everything fails open (a read/Apify error just drops
the bias block, ideation still runs on its other sources).

### The Performance tab reads the same table

`PerformancePanel` (the Compose **Performance** section) surfaces this measured
engagement directly: for Vega it LEADS with real per-post numbers — impressions
(from the X-API sweep), likes, reposts, replies, and a top-posts-by-engagement
table linking each post — then shows the pipeline/activity context (drafted,
scheduled, published counts) below. The data comes from
`getPublishedPostPerformance` (`schedule-queries.ts`), which takes the freshest
engagement snapshot per tweet AND the freshest snapshot that carried impressions
(so a newer Apify row never blanks out a known reach number). Draft-only agents,
which never publish, keep the activity-only view.

## Vega auto-curate (grade-gated auto-schedule)

Approving every generated post by hand is the operator's biggest Compose chore:
in the review-first flow you approve each **idea** (→ it drafts) and then mark
each **draft** ready before it can be scheduled. **Auto-curate** collapses both
manual steps for Vega (X): the operator clicks *Generate* once, Vega drafts +
**grades** each post, and the grade decides its fate — no per-post clicking.

It reuses the grounded-drafting **verifier** (`docs/grounded-drafting.md`): the
post-drafter already scores every draft on voice/grounding/relevance/format and
writes the 0..1 mean to `post_drafts.quality_score` (+ `quality_passed`). Two
hooks in the api-vm, both **X/Vega-only**, both **fail-open**, both **off by
default**, read that score:

1. **Auto-approve** — `POST /api/post-ideas`: when the switch is on, freshly
   ideated **X** ideas land `approved` (not `proposed`), so the post-drafter
   drafts them without idea review. (The bulk-Compose path already inserts
   `approved` ideas the same way.) Non-X ideas, and every idea when the switch
   is off, keep landing `proposed` — the review-first flow is byte-identical.
2. **Grade-gate** — `POST /api/post-drafts`: right after a draft is stored, an
   x_intern-owned **X** draft is judged by `decideAutoCurate`:
   - **score ≥ threshold** (and not verifier-failed) → auto-scheduled into a
     **paced** `content_schedule_slots` row bound to the draft (`window_source
     'auto'`, `status 'ready'`, `auto_publish` per config), and the draft/idea
     flip to `ready`/`scheduled`.
   - **below threshold, or verifier-FAILED** (a hard-rule violation like an em
     dash or a banned slop phrase — vetoed even if the mean cleared the bar) →
     the draft is **dismissed** (drops off the board).
   - **no score** (the drafter's `NOELLE_POST_VERIFY` is off) → **skip** to
     manual review; auto-curate never blind-schedules an ungraded post.

**One scheduled post per idea.** The X lane fans each idea into 3 community-framed
variants; auto-curate schedules the **first** variant that clears the bar and
**dismisses that idea's other variants** — mirroring the human review flow, where
the operator marks exactly one variant ready. If the operator already scheduled
the idea by hand (a `batch`/`manual` slot exists), auto-curate leaves it alone.

**Pacing ("don't burst").** Each qualifying draft is slotted `SPACING_MIN`
minutes after the instance's last active future slot (never before `now +
LEAD_MIN`), so a Generate round fans out over time instead of firing at once.
Actual posting stays gated downstream by the content-publish worker's
`x_api_write_enabled` + `send_enabled` and the daily write cap — so even
`auto_publish=true` slots don't post until X writes are switched on.

Config (api-vm env; all default-safe, so the pipeline is unchanged until you opt
in). Requires the post-drafter's `NOELLE_POST_VERIFY=1` so drafts are scored:

| Env | Default | Effect |
|---|---|---|
| `NOELLE_POST_AUTOSCHEDULE` | `0` (off) | Master switch. On ⇒ Vega auto-approves X ideas + grade-gates X drafts. |
| `NOELLE_POST_AUTOSCHEDULE_MIN_SCORE` | `70` | Pass bar on a 0-100 scale (normalized to the 0..1 `quality_score`). |
| `NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH` | `1` (on) | Qualifying slots carry `auto_publish=true` (Vega posts via the X API). Set `0` for schedule-as-copy-out (a `ready` calendar slot, no auto-post). |
| `NOELLE_POST_AUTOSCHEDULE_SPACING_MIN` | `180` | Minimum minutes between two auto-scheduled slots. |
| `NOELLE_POST_AUTOSCHEDULE_LEAD_MIN` | `15` | Earliest an auto-scheduled slot may fire, in minutes from now. |

Code: `apps/api-vm/src/lib/content-autocurate.ts` (pure `decideAutoCurate` +
`nextPacedSlotAt` pacing, unit-tested), wired in `routes/post-ideas.ts` (approve)
and `routes/post-drafts.ts` (`maybeAutoCurate` gate). No migration, no worker
change: it rides entirely on the existing verifier score + slot model.

Deferred follow-ups: a per-round **Auto-curate** toggle on the Compose form (the
current switch is a global env, so the form's "you review every idea" copy is
stale while it's on); picking the **highest-scoring** of the 3 variants rather
than the first to clear the bar (needs buffering the set); and a per-instance
(vs global-env) config so multi-tenant orgs opt in independently.

Platform widening to `reddit` is migration 0055 (no column change — the columns
are `text`). Cross-platform fan-out columns are migration **0059** (backward
compatible: legacy single-platform ideas backfill `target_platforms=[platform]`).

## One contract, two producers

The api-vm routes + `@noelle/contracts` `posts.ts` are the single source of
truth. Two producers write the same rows:

1. **Server workers (prod path)** — the ideation + post-drafter workers run
   per-org, ground on the org vault, and POST via the HMAC routes
   (`/api/post-ideas`, `/api/post-drafts`). The post-drafter is **platform-aware**:
   for each approved idea it drafts `FRESH_VERSIONS[platform]` posts per
   `target_platforms` entry (X via `buildXPostSystem`, LinkedIn via the existing
   prompt) and pushes each — one idea → 3 X drafts + 1 LinkedIn draft. No Mac
   involved; this scales to every org.
2. **Operator skills (power path)** — content skills (`voice-post`,
   `daily-post-batch`, …) run on the operator's Mac and POST the *same*
   contract via `noelle content push`. A skill can push one idea with
   `targetPlatforms` to fan out, or push pre-written per-platform drafts directly.

In-app generation (the Ideas toolbar + per-idea **Generate posts**) creates a
LinkedIn-home idea that fans out to **X + LinkedIn**; it's available under All /
LinkedIn / X. Reddit is view-only (Orion drafts replies, not original posts).

## The bridge: `noelle content push`

```
# push a batch of ideas (object form: { platform, ideas: [...] })
# each idea may carry targetPlatforms to fan out, e.g.
#   { "id": "<uuid>", "platform": "linkedin",
#     "targetPlatforms": ["linkedin","x"], "hook": "…" }
cat ideas.json | noelle content push --kind ideas

# bare ideas array + explicit platform
cat ideas-array.json | noelle content push --kind ideas --platform x

# push a single pre-written draft for one platform
cat draft.json | noelle content push --kind draft --platform linkedin
```

- Reads JSON from `--file <path>` or stdin; validates it against the wire
  contract before sending.
- Signs with HMAC-SHA256 (`NOELLE_HMAC_SECRET`) exactly like the server workers
  (`X-Noelle-Timestamp` + `X-Noelle-Signature`, 5-minute window).
- Targets `NOELLE_API_URL` (default `http://127.0.0.1:18791`; Lima forwards the
  guest api-vm port to the Mac, so localhost reaches the VM). Point it at
  `https://api.trynoelle.com` to push to prod for your own org.

Payload shapes (camelCase, per `posts.ts`):

```jsonc
// --kind ideas
{ "platform": "linkedin",
  "ideas": [{ "id": "uuid", "platform": "linkedin", "hook": "…",
              "thesis": "…", "angle": "story", "pillar": "building",
              "inspirationRefs": [], "sourceEngine": "voice-post", "model": "…" }] }

// --kind draft
{ "ideaId": "uuid", "platform": "linkedin", "body": "the post",
  "charCount": 412, "sourceEngine": "voice-post", "model": "…",
  "qualityPassed": true }
```

The client lives at `@noelle/runtime/content-push`
(`signContentRequest` / `pushPostIdeas` / `pushPostDraft`) and is reused by both
producers.

## Voice grounding & the vault

Both producers ground on the **per-org noelle vault** (not a Mac-local folder):
self-host = `NOELLE_VAULT_DIR` on the Lima VM (markdown, BM25, live re-index),
prod = the org's GCS prefix (`noelle.vaults`). Scope retrieval with
`NOELLE_VOICE_DIRS` / `NOELLE_KNOWLEDGE_DIRS`.

To seed an operator's voice from an existing Obsidian vault:

```
NOELLE_VAULT_DIR=~/.noelle/vault \
  node scripts/ingest-vault-anchors.mjs \
  --src /path/to/context/voice-anchors
# idempotent — re-run after edits; never deletes destination files.
```

The edits ledger (`noelle.content_edits`) captures operator corrections; a later
pass materializes recent edits back into the vault so future drafts learn from
them (content-pipeline's `edits.md` loop, made multi-tenant).

### Voice spec — the rules live in the vault too

Voice *anchors* (sample posts) come from the vault; the voice *rules* (hard bans,
structure, CTA style) used to be inlined in `post-drafter.ts`. They are now a
single editable file the operator keeps in their vault — **`voice-spec.md`** —
that BOTH the `voice-post` skill and the dashboard drafter read, so editing one
file steers every generated post (X + LinkedIn).

- Path: `NOELLE_VOICE_SPEC_PATH`, default `<NOELLE_VAULT_DIR>/voice-spec.md`.
- When present, `buildPostDrafterSystem` / `buildXPostSystem` inject it as an
  **authoritative** block above the inlined rules (loader: `lib/voice-spec.ts`,
  cached 15 min so edits apply without a restart).
- When absent, the system prompt is **byte-identical** to before (the inlined
  rules alone) — safe to ship dark; turns on the moment the file lands.
- Starter template: `docs/voice-spec.template.md` — copy it into the vault and
  edit. (This is the "skill, inside the vault.")

## Media storage

Uploads flow browser → server action → `POST /api/content-media` (JWT) → the
storage backend, selected by env:

- **self-host (`NOELLE_MEDIA_BACKEND=local`, default):** bytes are written under
  `NOELLE_MEDIA_DIR` and served same-origin by the Next app at `/media/<key>`
  (the only Tailscale-published origin, so media loads on every device). Set the
  same `NOELLE_MEDIA_DIR` for the api-vm and the app.
- **prod (`NOELLE_MEDIA_BACKEND=gcs` + `NOELLE_MEDIA_BUCKET`):** bytes go to the
  media bucket; the row's `url` is the (public/signed) GCS URL.

Storage keys are `<orgId>/media/<uuid>.<ext>`. The abstraction lives at
`@noelle/runtime/content-storage` (`createLocalContentStorage` /
`createGcsContentStorage`).

### Images on auto-posts (Vega only)

Vega is the one intern that publishes, so it is the one that can attach an image
to a live post. A scheduled slot binds to a `post_drafts` row (`draft_id`); an
image is a `content_media` row linked to that draft (`draft_id`) or to the
draft's idea (`idea_id`, cross-platform or `platform='x'`). At publish time the
`content-publish` worker:

1. resolves the slot's attached image(s) — up to 4, X's per-tweet cap;
2. reads the bytes (local disk under `NOELLE_MEDIA_DIR` on self-host; the signed
   `content_media.url` on the `gcs` backend);
3. uploads each via the X write client's `uploadMedia` (v1.1 `media/upload`,
   simple single-request — images only) to get a `media_id`; then
4. posts with `media.media_ids` attached (`XWriteClient.postTweet({ mediaIds })`).

The worker needs `NOELLE_MEDIA_DIR` (and `NOELLE_MEDIA_BACKEND`, default `local`)
set to the SAME values the api-vm + app use. A missing/unreadable asset is
skipped (the post still goes out); a retryable X error (rate-limit / lock)
returns the slot to `ready` exactly like a failed post. Text-only posts are
unchanged when no image is attached.

**Setting the image.** Uploading a fresh image to a draft (composer →
`POST /api/content-media` with `draftId`) already binds it. To point an
*existing* library asset (or a generated image) at a scheduled post without
re-uploading, `PATCH /api/content-media/:id` with `{ "draftId": "<uuid>" }`
(binding derives the draft's idea; `null` unlinks). A Schedule/Media UI affordance
for this and end-to-end image *generation* are follow-ups (see the PR notes).

Video is not yet supported on the auto-post path — v1.1 chunked upload
(INIT/APPEND/FINALIZE + STATUS polling) is a follow-up; `uploadMedia` handles
images only today.

## Hooking up a skill (voice-post)

The global `voice-post` skill keeps generating (dry-run → approve). On approve,
when `NOELLE_CONTENT_TARGET=on`, it pipes its output to `noelle content push`
instead of (or in addition to) content-pipeline's `localhost:3010`:

```
echo "$IDEAS_JSON"  | noelle content push --kind ideas
echo "$DRAFT_JSON"  | noelle content push --kind draft --platform linkedin
```

Default OFF so it never double-writes unintentionally. `daily-post-batch` and
`yc-series-post` carry the same optional `NOELLE_CONTENT_TARGET` section
(daily-batch maps each day onto `suggestedDay`). With all three repointed,
content-pipeline is no longer the *only* content home — flip the flag to make
noelle the destination, and retire content-pipeline as the dashboard once
you've confirmed the cross-device loop (it stays intact as a read-only archive;
no code in this repo depends on it).

## Cross-device verification (run on the live box)

These need the running self-host VM + your devices and can't be verified from a
dev session:

1. **Self-host:** apply migrations (`noelle migrate`), restart the api-vm/app,
   then from the Mac: `echo '<ideas json>' | noelle content push --kind ideas`.
   Confirm a `noelle.post_ideas` row, then open the Tailscale URL
   (`https://<host>.<tailnet>.ts.net/app/<org>/content`) on your phone and see it.
2. **Prod:** apply migrations to Cloud SQL (`psql -U postgres -f infra/cloudsql/schema/0055_…`,
   `…0056_…`), deploy api-vm + Vercel, confirm the worker path lands ideas and
   the dashboard shows them on the web.

## Status

- **Phase 1 (this PR):** cross-platform workspace + nav + redirects, platform
  widened to reddit, edits ledger, the HMAC bridge (`noelle content push`), and
  the vault ingest script.
- **Phase 2 (done):** Media library + blob storage abstraction (local + GCS) +
  the same-origin `/media` serve route.
- **Phase 3 (done):** cross-platform Overview (KPIs + per-platform breakdown +
  weekly tracker); `daily-post-batch` + `yc-series-post` repointed (optional,
  default-OFF); content-pipeline wind-down stance documented.
- **Cross-platform fan-out (migration 0059):** the idea is now the cross-platform
  source concept; one Generate fans out into a side-by-side X + LinkedIn post set
  with per-platform versions (the content-pipeline `GeneratorRun` model). This
  corrects Phase 1's single-platform-per-idea modeling.
- **Deferred follow-ups:** edits-ledger → vault exporter (materialize
  `content_edits` back into the vault); platform-scoped voice dirs (X drafts use
  the same vault voice as LinkedIn today); X/Reddit *ideation* workers (the X
  drafter exists via fan-out, but only LinkedIn has an ideation worker); an
  editable Vault page.

## Writing checks for generated ideas

LinkedIn and X idea generation and LinkedIn idea polish use the shared anti-AI
reader rules. Each hook and thesis passes the existing deterministic format
checker with strict voice enabled before storage. Hook and thesis are checked
separately so repeating the core claim across the two fields is allowed.

When text fails, the worker makes at most one rewrite call with the rejected
candidates and specific reasons. The rewrite must retain the batch count and
order, factual limits, and core point. Stable repair IDs bind each candidate to
its original position. Only hook and thesis can change; source tags, angle,
pillar, and already clean ideas are retained from the original response. The
worker checks the result again and saves only a passing response. Failed or malformed repairs raise a
request error and save nothing; failed polish leaves the existing idea intact.
Text beyond the storage limits (600 characters for a hook, 1200 for a thesis)
also requires repair, so storage cannot truncate a checked idea afterward.

The shared gate lives in `packages/runtime/src/ideaQuality.ts`; prompt guidance
lives in `packages/runtime/src/antiAiWriting.ts`. These checks catch known wording
