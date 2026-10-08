# X-Intern Classifier — Grading Guidelines

**This is the source of truth for how the X-intern classifier grades a discovered post
and decides whether it becomes a lead.** It covers the on-brand triage, the AI-slop
filter, the follower floor, and how they combine into the final `on_brand` / `tier` /
`score` written to `noelle.leads`.

Code: `apps/x-intern/src/lib/classifier-engine.ts` (LLM triage),
`apps/x-intern/src/lib/ai-slop.ts` (deterministic slop detector),
`apps/x-intern/src/lib/follower-policy.ts` (follower floor),
`apps/x-intern/src/lib/language.ts` (English-only gate),
`apps/x-intern/src/workers/classifier-tick.ts` (combines them).

---

## The pipeline, in order

A claimed lead (status `new` → `classifying`) is graded like this:

0. **Age cutoff (runs first, before the watchlist bypass).** If the post's own
   `posted_at` is more than `MAX_LEAD_AGE_DAYS` (15) old, it is dropped to `skipped`
   (label `too_old`) with no LLM call — replying weeks late is noise. This applies even
   to watchlist `priority` posts (in practice they're discovered fresh, so it rarely
   bites). Posts with a missing/unparseable `posted_at` fail open (never dropped here).
   See `apps/x-intern/src/lib/recency.ts`.

   > **`posted_at` is the tweet's real time, not a system clock.** Discovery sets it
   > from the tweet's own `created_at`. The X client (`packages/x-client`) recovers
   > that date from the raw GraphQL `legacy.created_at` when Bird's typed `createdAt`
   > is absent, and **drops** a tweet it cannot date rather than fabricating one. A
   > faked "now" used to make months-old tweets look fresh — passing both discovery's
   > `since` window and this cutoff — which is how a Feb-24 tweet once reached the
   > inbox in June. Because of that drop-at-ingest guarantee, the fail-open branch
   > above almost never fires in practice.

   > **Reposts are dropped at discovery, before a lead exists.** A pure repost
   > (native retweet) carries none of the author's own words, so a reply would
   > land on a stranger's tweet. The X client flags it (`XTweet.is_repost`, from
   > the raw GraphQL `legacy.retweeted_status_*`, with an `RT @` text-prefix
   > fallback) and `runDiscoveryTick` skips it before `upsertLead` — so a repost
   > never becomes a lead and the watchlist bypass below never sees one. This
   > applies to **both** lanes: a watchlisted person's repost is dropped too.
   > Quote-tweets (own commentary + a quoted tweet) are **not** reposts and flow
   > through normally.

0.5. **English-only gate (always on, before the watchlist bypass).** The operator only
   wants English leads. A post whose text the deterministic detector
   (`apps/x-intern/src/lib/language.ts`) judges non-English is dropped to `skipped`
   (label `non_english`, `payload.classifier.skip_reason = "non-english"`) with no LLM
   call — so a non-English post never gets a non-English draft. **This beats the watchlist
   bypass below:** even a watched person's French/Spanish/German/Portuguese post is
   dropped, not auto-classified. The detector is deliberately lenient — short text
   (`< MIN_DETECT_CHARS`), emoji-only, link-only, and ambiguous posts (and any post
   carrying a real English function word, which absorbs accented loanwords like "café")
   pass through as English. It skips only on a clear non-English signal: a non-English
   function word, or ≥2 distinct non-English diacritics/inverted-punctuation chars.

1. **Watchlist bypass.** If the lead is `priority` (posted by a watchlisted person on/after
   they were added), it skips *everything below this step* and is marked `classified` / `T1` /
   on-brand. Watchlist accounts are explicitly selected for replies. Nothing here touches that — except
   the age cutoff and the English-only gate above, which run first.
   (Reposts are already gone — see the discovery drop above.)

2. **LLM triage (Gemini).** The post text + author handle + follower count go to Gemini,
   which returns `{ on_brand, on_brand_reason, kind, velocity_score, tier, ai_slop,
   ai_slop_reason }`. On any backend error the classifier *fails open* (`on_brand=true`,
   `velocity_score=null`) — it is a cost-saver, not a hard gate.

3. **Deterministic AI-slop filter** (`ai-slop.ts`). Runs on the raw post text regardless
   of whether the LLM succeeded. Produces a `0..1` slop score and a reason list. This is
   the authoritative slop signal — see below.

4. **Follower floor** (`follower-policy.ts`). Adjusts the grade by the author's follower
   count. See the table below.

5. **Combine.** The final `on_brand` is `false` (lead becomes `skipped`, never reaches the
   drafter or the approval inbox) if **any** of these hold:
   - the LLM judged it off-brand, OR
   - the slop filter judged it slop (`isSlop`), OR
   - the follower floor judged it a drop (`< 100` followers, or strict-mode without
     strong signal).

   Otherwise it is `classified`. The `tier` and `score` are demoted by the slop and
   follower penalties even when the lead survives, so weak-but-passable posts rank below
   clean high-follower ones in the inbox.

6. **Recency weighting.** The surviving score is multiplied by a freshness factor in
   `(1 - RECENCY_DECAY, 1]` (today → ×1.0, 15-day-old → ×0.5), so at equal base quality a
   fresher post ranks above a staler one in the score-sorted inbox. Watchlist priority
   leads keep their forced `score=1` (no decay). `recency.ts`. The inbox can also sort by
   the post's `posted_at` directly via the "Newest post" sort.

   **"Per person → Latest only" filter.** Watchlist accounts (`leads.priority = true`) get a
   reply drafted for *every* post, so an active one floods the inbox. The opt-in `Per person`
   filter (URL `?wlLatest=on`, off by default) collapses **each watchlisted person to just
   their newest post**; non-watchlisted (keyword) leads are untouched. It runs on the raw
   approval rows before the per-lead/per-draft grouping, so the Review list, Speedrun, and the
   detail-page "Lead N of M" stepper all walk the same collapsed set
   (`keepLatestPostPerWatchlistedPerson` in `apps/app/src/lib/queries.ts`).

Every decision (slop reasons, follower bucket, penalties) is recorded in
`leads.payload.classifier` so it's auditable on the lead.

---

## AI-slop filter

**Goal:** a post that reads like it was written by an LLM gets a bad grade and is dropped.
The heuristics are the inverse of the Mars vault `writing-rules.md` — the same rules that
keep *our* posts from sounding like AI are used to *detect* AI in other people's posts.

The detector is a pure function over the post text. It accumulates weighted hits; when the
normalised score crosses the slop cutoff the post is flagged `isSlop` and dropped.

### Signals (each contributes weight)

| Signal | What it catches | Example |
|---|---|---|
| **Negative parallelism / reframe** (heaviest) | The single most machine-detected tell. | "It's not a tool. It's a system." / "X is dead. Y is the future." / "The question isn't X. It's Y." |
| **Em-dash density** | LLMs over-use `—`. | "agents are everywhere — they write code — they do real work" |
| **Banned hype vocabulary** | Corporate/AI buzzwords. | seamless, robust, leverage, unlock, supercharge, game-changer, revolutionize, cutting-edge, frictionless, paradigm, delve, harness, elevate, empower … |
| **Bloated copular verbs** | Dodging plain "is/has". | "serves as", "stands as", "marks a", "represents a", "designed to", "aims to" |
| **Dead openings / transitions** | Throat-clearing. | "In today's …", "Let's dive in", "Furthermore", "Moreover", "That said" |
| **Engagement bait** | Fake-deep hooks. | "Let that sink in", "Read that again", "This changes everything", "Building in public" |
| **Emoji-as-bullets** | Launch-post section markers. | "🧩 /code … 🛠 /forge … 🔬 the science …" (3+ emoji used as list markers) |
| **Rule of three** | Every claim packaged as a triple. | "speed, efficiency, and innovation" |
| **Significance inflation** | Empty importance. | "a pivotal moment", "a key turning point", "broader implications" |
| **Mass-mention bait** | Engagement/tagging spam — a genuine ICP question rarely tags 5 accounts. | "thank you to @a @b @c @d @e @f for your support" |
| **Hashtag stuffing** | Promo / news / spam shape (3+ hashtags). | "#RussiaUkraineWar #RussianWarCrimes #Ukraine" |
| **News-headline emoji** | Headline/announcement lead-in; pushes a hashtag-stuffed news post over the line. | "💥 In Dnipro, on the night of …" |

The screenshot that triggered this feature — a "Building in public 🛠️" launch post with
emoji section markers (🧩 /code, 🛠 /forge, 🔬 the science), em-dashes, and hype framing —
scores well over the cutoff and is dropped. The mass-mention/hashtag/news signals were
added after a real-data review surfaced a war-news report and a mass-@-tag demonetization
rant sneaking through.

### The 1500-follower rescue

A post that trips the slop filter is **dropped** — the *only* thing that rescues it is an
author with **more than 1500 followers** (`SLOP_RESCUE_FOLLOWERS` in `follower-policy.ts`).
Unknown follower count does **not** rescue (it can't clear the bar). This lets the detector
be aggressive — false positives on big, real accounts are caught by the rescue, while small
spam/bot accounts posting slop are dropped regardless. Recorded as
`classifier.ai_slop.rescued_by_followers` on the lead.

### Tuning

- Cutoff and per-signal weights live at the top of `ai-slop.ts`.
- A single buzzword does not make a post slop — it takes a *combination* of tells. But the
  spam-shape signals (mass-mention, hashtag-stuffing) are weighted to flag on their own,
  because the 1500-follower rescue backstops false positives.
- The LLM is also told to flag `ai_slop`; if either the deterministic detector or the LLM
  flags slop, the lead is dropped (unless rescued). Deterministic is primary (it runs on
  fail-open).

---

## Follower floor

Low-follower accounts are graded more strictly — a reply to someone with 30 followers is
rarely worth it, and very small accounts are disproportionately bots/slop.

| Followers | Policy | Effect |
|---|---|---|
| `< 100` | **Drop** | Never becomes a lead, even if otherwise on-brand. |
| `100 – 499` | **Strict** | Survives only with strong signal (on-brand **and** tier T1, **and** not slop). Tier demoted one step. |
| `500 – 999` | **Mild** | Small score penalty, tier untouched. "Don't punish much." |
| `>= 1000` | **Full credit** | No penalty; eligible for the best tiers/scores. |
| unknown / null | **Neutral** | No penalty. Missing data never drops a lead (a follower-extraction miss must not nuke the pipeline). |

Thresholds live at the top of `follower-policy.ts`.

**Data source.** Follower count comes from the X GraphQL response the discovery worker
fetches. `packages/x-client` calls Bird's `search`/`getUserTweets` with **`includeRaw: true`**
— without that flag Bird strips the author down to `{username,name}` and `_raw` is never
attached, which is why historical leads have no follower count. With it, `_raw` carries the
full result and the client reads `core.user_results.result.legacy.followers_count`. It is
stored on `leads.payload.author_followers` (the same field the dashboard reads). When the
count is absent the policy treats it as unknown → neutral (but note: unknown does **not**
rescue an AI-slop flag).

---

## What survives, concretely

A lead reaches the approval inbox only if **all** of:

- the watchlist bypass applied, **or** all of:
  - LLM did not mark it off-brand, **and**
  - the deterministic slop filter did not flag it, **and**
  - the LLM did not flag `ai_slop`, **and**
  - the follower floor did not drop it.

Everything else is `skipped` and never shown.

---

## Relationship scout (VIP flag + suggested DM)

Independently of the on-brand grade, the classifier also runs a **relationship
scout** in the *same* LLM call (no extra call, no extra latency). It judges
whether the post's **author** is a high-leverage person to build a relationship
with — an ICP match, a founder/CEO/builder of a notable or venture-backed company
(e.g. a YC founder), an investor, or a respected operator/creator — and, when so,
pre-drafts a short, genuine intro DM (a real question or a low-pressure coffee-chat
ask; **no pitch, no link**).

- **Where:** the `relationship` block in the classifier output
  (`buildClassifierSystem(..., vipScout)` appends the scout instructions). Shared
  shape: `@noelle/contracts` `VipSignalSchema`
  (`{ vip, reason, tags[], add_to_watchlist, dm_soon, suggested_dm }`).
- **Stored:** `noelle.leads.vip_signal` (jsonb), written by `markLeadClassified`.
  `NULL` = the scout never ran (predates the feature / disabled) or fail-open.
- **Why precomputed:** `api-vm` has no LLM path, so the suggested DM can't be
  generated on button-click — it rides along on the classifier verdict.
- **Surfaced:** a loud gold banner above the draft picker on the approvals detail
  page (both Vega's `DraftReviewPanel` and Lyra's `LinkedInApprovalDetailView`)
  and inline in the speed lane (`SpeedrunRow`): the reason + tags, a one-click
  **Add to watchlist** (seeds the scout reason as the engagement objective), and
  the **suggested intro DM** with **Copy** + **Park in DMs**. It's meant to catch
  the eye *before* the reflex Send / Mark sent.
- **Park in DMs:** the suggested DM is otherwise copy-and-it's-gone. "Park in DMs"
  (`parkVipIntroDm`, `apps/app/.../approvals/vip-dm-actions.ts`) persists it as a
  real `kind='dm'` draft + pending approval for the lead, so it shows in the inbox
  under the **DMs On** toggle (filter `payload->>'kind'='dm'`) — parked for when
  you want to send it a bit later, not right now. The body is read server-side
  from `vip_signal.suggested_dm` (never the client), and the write is idempotent:
  the draft carries `payload.source='vip_intro_dm'` so re-clicking never parks a
  second copy.
- **Toggle:** on by default; set `NOELLE_VIP_SCOUT=false` (or `0`) on the
  classifier worker to disable. Additive + fail-open — leaving it on is safe; a
  scout-off run or an omitted field simply yields `vip_signal = NULL` (no banner).

The same scout runs in the LinkedIn intern (Lyra). It's especially apt there —
the suggested DM and watchlist add feed Lyra's existing draft-only intro-DM and
connection-tracking flows.
