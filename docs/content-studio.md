# Content Studio — what it has & will have

> The unified content command center. Plan, generate, and ship original content across **every** surface — LinkedIn (Lyra), X (Vega), Reddit (Orion), and **short-form video** (Nova · IG/TikTok) — from one workspace, one design, one flow: **idea → draft/script → schedule**, grounded in your voice and in what actually performs.
>
> Status legend: ✅ live & validated · 🔨 building now · 📋 planned

---

## Shape

- **Platform lanes:** All · LinkedIn · X · Reddit · **Video** (Nova)
- **Boards:** Overview · Ideas · Drafts/Build · Media/Discover
- **Controls:** a Generate-**N** count stepper, weekly (today→week) calendar, one-idea fan-out
- Lives at `/content`. Video is a **lane inside it** — not a separate page.

---

## ✅ HAS today — text / posts (live on Lima)

- **Platform switcher** — All · LinkedIn · X · Reddit, preserving the active board.
- **Overview** — weekly planner with KPI cards (Ideas / Generating / Posts), per-platform tallies, drag/date scheduling, weekly-batch trigger.
- **Ideas** — research-backed hooks; **Generate N** (count stepper), Generate weekly batch, Write-your-own.
- **Posts (Drafts)** — per-platform drafts, inline edit, rich columns (Hook / Content / CTA / Status / Category / Notes), Mark ready, verifier trace (voice/grounding/relevance/format).
- **Media** — unified asset library (uploads + the content-pipeline mount).
- **Fan-out** — ONE idea → 3 X + 1 LinkedIn versions.
- Grounded in your **vault voice** + the **Account Feeder** style learning.

## ✅ HAS today — video / Nova backend (live + validated on your real account)

- **Watchlist** — pick the IG/TikTok **creators** you choose + **niche** keyword/hashtag lanes; manage multiple accounts.
- **Harvest (Scout)** — pulls reels via Apify and applies your filters (top-N by views, audience-relative **outperformers**, niche newest-top).
- **Teardown (W2)** — downloads each clip → **whisper transcript** + Gemini multimodal → structured **hook · beats · transitions · on-screen text · pacing · CTA · sound · why-it-worked**. (Not just the caption.)
- **Brand Guide (Distiller, W3)** — distils the teardowns into "what works," per **creator / niche / your-own-account**.
- **Ideate (Muse)** — proposes video ideas grounded on the Brand Guide.
- **Script (Scribe)** — timed **structure + script** + suggested transitions/sounds.
- _Validated end-to-end on `@andrescontrerasofficial`: 9 teardowns w/ transcripts → Brand Guide → 6 grounded ideas → a scripted draft (4 beats, transitions)._

---

## 🔨 / 📋 WILL HAVE

1. 🔨 **Video lane inside Content** — Ideas / Build / Week / Discover for video, reusing the exact Content components (count stepper, boards, weekly view, KPI cards). No duplicate page.
2. 🔨 **Tailored-harvest controls** — the knobs you asked for, editable per watchlist: **how many per creator**, **top-N best (by views / engagement)**, **outperformers** (views ≥ N× the creator's followers, excluding the top-N you already got), **niche** (recency window · min views · count), **deep-analysis tier**.
3. 🔨 **Nova in the org chart** — a real agent under Head of Growth, beside Vega / Lyra / Orion (hireable, clickable to its surfaces).
4. 📋 **Discover** — browse the harvested top videos with working thumbnails, sort/filter by creator/niche, deep-tier badges, view→source.
5. 📋 **Brand Guide page** — read the distilled guide (hook library · transition vocabulary · pacing fingerprint · structure templates · sound patterns) per creator / niche / your account.
6. 📋 **Talk-to-Nova** — a chat that knows your watchlist, your Brand Guide, this week's plan, **and your own IG account in real time** (followers + your recent uploads via Apify) to advise your next video.
7. 📋 **Your-account intelligence** — Nova profiles *your* uploads + their performance to tailor advice ("you do well with X opens; lean into Y").
8. 📋 **Asset generation (assist + overlays)** — **Remotion** graph/caption overlay specs, **suggested transitions + sounds** (from what your top creators use + trending audio), **image-gen** (Vertex Imagen / Sogni). Drop into your manual Premiere edit.
9. 📋 **Recommendations** — "what should I post today" / pick-what-fits-the-day, ranked from the Brand Guide + niche-trending.
10. 📋 **End-to-end into the calendar** — idea → structure → script → asset specs → scheduled on the weekly view.

---

## Activating TikTok (ops)

TikTok is code-complete: the Apify transport (`clockworks~tiktok-scraper` in `packages/video-apify`), the harvester lanes, the watchlist DB + server actions, the `VideoPlatformSchema` contract, and the app UI all already handle `"tiktok"`. Turning it **on** for an account is two manual ops steps — **both trigger PAID Apify scrapes, so do them deliberately**:

1. **Seed TikTok watchlist rows.** Run the seed script against prod with an explicit connection string (it refuses to run without `DATABASE_URL` + `CONFIRM=1`, and does NOT read `/etc/noelle/*.env`):
   ```bash
   DATABASE_URL='postgres://…' CONFIRM=1 \
     scripts/seed-video-watchlist-tiktok.sh --auto        # or: <org_id> <agent_instance_id>
   ```
   Inserts `platform='tiktok'` rows into `noelle.video_watchlist_sources` (creators, handle lowercased/no `@`) and `noelle.video_watchlist_niches` (hashtag/keyword lanes, no `#`). Idempotent (`ON CONFLICT DO NOTHING`). Override the starter set with `HANDLES='…'` / `NICHES='a|b|c'`. **Each seeded row is scraped (paid) on the next harvest tick.** The operator can also add TikTok creators/lanes from the Watchlist UI, and **"Plan from objective"** now has a platform selector, so Nova can expand the objective into TikTok niche lanes too.

2. **Grade against the objective (recommended).** Set `NOELLE_NOVA_OBJECTIVE_GRADE=1` on the harvester box (the Lima VM running `apps/video-intern`). Default **OFF**; when on, niche/viral clips are filtered against the instance objective (Vega-style relevance), fail-open. Not TikTok-specific, but you want it on before a broad TikTok niche pull floods Discover.

**Caveats**

- **`NOELLE_VIDEO_SELF_TRACK` defaults ON.** The harvester primes an own-account tracking sweep **on boot** and every `NOELLE_VIDEO_SELF_TRACK_MS` (6h), pulling each `is_own` source via Apify **independent of the manual harvest flag** — so merely (re)starting the worker spends Apify. Set `NOELLE_VIDEO_SELF_TRACK=0` to disable. Never run a worker `main()` from a dev box against prod; it will scrape.
- **TikTok niche discovery is hashtag-based.** `clockworks~tiktok-scraper` has no user-search that returns profiles, so `nicheCreatorReels` short-circuits to the hashtag lane for TikTok (IG uses profile discovery + a fallback chain). A keyword→videos path via the clockworks `searchQueries` input exists behind an **opt-in, default-OFF** flag (`tiktokKeywordSearch` on `createApifyVideoClient`). **UNVERIFIED** — the exact clockworks input field is not confirmed in-repo. **TODO:** confirm the shape returns videos with **one live run**, then wire an env flag in the harvester to pass the option before enabling in prod. Until then, TikTok niches use hashtags.

## Under the hood

- **Nova** = the `video_intern` agent (sibling to Vega/Lyra/Orion) + sub-agents: Scout (harvest) · Ripper (download/transcribe) · the teardown panel (Hooksmith/Architect/Cutter/Overlay/Maestro/Metronome/Closer/Oracle → Synthesist → Auditor) · Curator (Brand Guide) · Muse (ideate) · Panel (judge) · Blueprint/Scribe/Critic (script) · Set-dresser (assets) · Media-intern (recording brief).
- **Workers on Lima:** harvester · teardown · distiller · ideator · scripter (all live) · **briefer** (W6 media intern — a phone-readable recording brief per operator-approved draft; `NOELLE_BRIEFER`-gated, default **OFF**, so it is dormant until enabled). Supersedes the never-deployed Paperclip `media-intern`.
- **IG harvest resilience:** the harvester pulls IG creators through an actor **fallback chain** (`packages/video-apify`): primary `apify/instagram-scraper`, then `coderx/instagram-profile-scraper-bio-posts`. apify's actor periodically gets IG-blocked en masse (it 201s but every item is `{error:"no_items"}`, or the run overruns the timeout) — when it yields nothing, the client auto-falls-through to coderx (a separate vendor/backend) so the creator lane keeps producing clips. coderx is username-only, so the **niche/hashtag lane still uses the primary only**. TikTok is a single actor (`clockworks/tiktok-scraper`).
- **Engines (no OpenAI):** local `whisper-ctranslate2` + `claude-cli` for the bulk pass; **Vertex Gemini** (native-video) + **AWS Bedrock** for the deep tier; **Voyage** embeddings; **Vertex Imagen / Sogni** for images; rendering orchestrated through **Forge**.
- **Data:** `video_watchlist_sources` / `video_watchlist_niches` · `video_clips` · `video_teardowns` · `video_ultra_profiles` (the Brand Guide) · `video_ideas` · `video_drafts` · `video_recording_briefs` (the briefer's output) (+ `video_feeder_config` for the filters).
- Draft-only: Nova never posts to IG/TikTok — you record + post by hand.
