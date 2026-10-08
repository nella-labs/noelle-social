<!-- Design dossier from the multi-agent research workflow (2026-06-21) — build spec for the human-behavior / anti-detection engine. -->

# LinkedIn Actuator — Human-Behavior Engine Design Dossier

**Target:** `apps/linkedin-actuator` (Chrome MV3, TS, wxt). All input via `chrome.debugger` CDP `Input.*` (isTrusted:true). All randomness via injectable seeded `Rng`. Pacing gated by `scheduler.planTimeline()`.

**Scope note (critical):** Today the actuator dispatches a *single* `Input.dispatchMouseEvent{type:mouseMoved}` per Bézier point, scrolls with a uniform `planScrollSteps`, has no reading model, no `…more` expansion, and `locateLike` fails against live DOM. Lyra (the sibling on Lima) is draft-only and never writes to LinkedIn; this actuator is the *write* path, so account-safety risk lives here. Everything below is written so the **pure planners** (`motion.ts`, `scheduler.ts`, new dwell/session modules) are unit-testable with a seeded RNG, and only the CDP dispatch + DOM are browser-only.

---

## 1. Threat Model

### 1.1 What trusted-CDP-input already solves

Dispatching through `chrome.debugger` → `Input.dispatchMouseEvent` operates at the browser-process input layer, **below** the DOM `dispatchEvent()` API. This buys us:

- **`isTrusted: true`** on the resulting DOM events. (VERIFY-2 flags this as *fragile/not-definitively-confirmed* for CDP `Input.*` specifically — the contrast with JS `element.dispatchEvent` (which is provably `isTrusted:false`) is solid, but treat CDP `isTrusted:true` as "very likely, not guaranteed.") **Conservative default: do not rely on isTrusted alone; assume the harder behavioral signals below are what matter.**
- **A real pointer/mouse event chain** when we orchestrate it (mousemove → mousedown → mouseup → click), unlike a bare synthetic `click`.
- **No `navigator.webdriver`** — we are a *Chrome extension on a real headed user-profile browser*, not Playwright/Puppeteer. This sidesteps the **entire Tier-1 CDP-detection class**: no `Runtime.enable` Error.stack getter leak (dead anyway since the May 7+9 2025 V8 patch — CONFIRMED), no `__puppeteer_evaluation_script__` stacks, no headless WebGL (SwiftShader/llvmpipe), no `$cdc_*` artifact, no JA4/HTTP-2 mismatch (real Chrome binary, real TLS stack, real residential session). **This is our single biggest structural advantage and must be preserved — never migrate this to a headless/Playwright driver.**

### 1.2 What still leaks — prioritized by detectability

Ordered by impact-per-effort, grounding each in the research:

| # | Leak | Why detectable | Research anchor |
|---|---|---|---|
| **P0** | **`getCoalescedEvents()` returns empty on our `mouseMoved` events** | Real hardware pointermove carries 2–8 coalesced intermediate samples per rAF frame; CDP-dispatched moves carry zero. This is a *browser-engine behavior we cannot patch from JS.* | W3C pointerevents #187; spec sets coalesced list empty for synthesized events (CONFIRMED as spec; vendor deployment UNVERIFIABLE → treat as fragile but assume worst case) |
| **P0** | **Velocity profile violates Fitts/neuromotor law** | Current `mousePath` is a single quadratic Bézier sampled at *roughly uniform t*, with `sleep(6–22ms)` between points → near-constant velocity, no bell curve, no overshoot+correct, **no micro-tremor**. Coefficient-of-variation of velocity is too low; curvature ratio too straight; zero corrective sub-movement near target. | DMTG 2410.18233 ("slow initiation + directional force"); BeCAPTCHA 2005.00890 (Bézier-without-lognormal-velocity → 93% detect); FP-Agent (no-mouse-movement = F1≈1.0) |
| **P0** | **Robotic scroll** | `planScrollSteps` emits uniform `deltaY∈[120,420]` with `sleep(250–900ms)` uniform between. No momentum/inertia decay, no attention-paced slowdown on interesting content, constant velocity through all content. CV of scroll spacing ≈ uniform (low). Also dispatched as `mouseWheel` (no real wheel-notch granularity). | iOS PastryKit τ=325ms momentum; NNGroup attention; bot scroll CV<0.1 vs human >0.5 |
| **P1** | **No reading dwell proportional to content** | Bot scrolls past a 400-word post and a 1-line post at identical speed. Correlating scroll-velocity with content length is a *session-level* tell. | Brysbaert 238wpm; Liu/White/Dumais Weibull dwell |
| **P1** | **Timing is i.i.d. uniform, not log-normal + autocorrelated** | Every `rng.float(a,b)` is uniform. Human inter-action gaps are log-normal/power-law with lag-1 autocorrelation (ρ≈0.4 "tempo"). Inter-action CV currently moderate but *shape* is wrong (uniform body, no heavy tail, no momentum). | CV human 0.8–2.0 vs bot <0.3; AR(1) ρ=0.4; power-law α≈1.2–1.6 |
| **P1** | **Every action is goal-directed** | No decoy hovers, no partial engagement, no `…more` clicks-without-react, no "open profile → leave". Anti-bot flags "action-only" sessions. | Evasion §3 (high-impact, underimplemented) |
| **P2** | **Click lands at exact element center** | `elementCenter()` returns geometric center every time; humans hit a 2D-Gaussian biased ~70% edge→center. | Evasion §1f, §4b |
| **P2** | **No session/fatigue arc, weak off-hours taper** | `deepNightTaper` only down-weights 01:00–06:00 to 0.25 — still nonzero, and no warm-up/decay/micro-break/leave-return. Flat 24/7-ish activity + off-hours writes is "the clearest bot signal." | Circadian 12–31% perf var; off-hours = near-certain flag |
| **P2** | **Velocity/server-side: pacing too regular & volumes risk-tier** | Velocity > daily totals is *the* 2026 finding. Bursting and identical daily volumes are flagged server-side regardless of mouse realism. | LinkedIn behavioral AI; CV<0.3 flag |
| **P3** | **Likes currently fail (selector mismatch)** | Functional bug, not a tell — but a *stalled* run that only ever comments/DMs has an unnatural action-mix signature. Fix first so the mix is human. | §2 below |

**The honest hierarchy:** server-side graph/velocity signals (P2) and the un-patchable `getCoalescedEvents` (P0) are the hardest floors. We cannot fix coalesced events from JS (would need OS-level injection, out of scope for an MV3 extension). Therefore our strategy is **defense-in-depth on everything we *can* control** (velocity profile, scroll, dwell, timing, decoys, pacing) so we're not the easiest 90% — combined with **aggressively conservative volumes** so the server-side ML never has reason to pull our session for deep behavioral inspection in the first place.

---

## 2. Real LinkedIn Selector Map

Strategy priority (from research + VERIFY-1): `data-urn` > ARIA (`aria-label`/`aria-pressed`/`role`/`contenteditable`) > stable BEM component classes > text-content match > obfuscated hashed classes (**never**). Confidence reflects VERIFY-1 verdicts. **"⚠ LIVE-CHECK" = must be confirmed against live DOM before depending on it.**

```ts
// === FEED POST CONTAINER ===  CONFIRMED HIGH
"[data-urn^='urn:li:activity:'], div.feed-shared-update-v2[data-urn]"
// (already in selectors.ts — keep)

// === LIKE / REACT BUTTON ===  CONFIRMED HIGH (EN-locale; fragile non-EN)
// already-liked = aria-pressed="true" on the same button (CONFIRMED HIGH)
[
  "button[aria-label^='React Like' i]",          // primary; Apify actor confirms exact prefix
  "button[aria-label*='React Like' i]",
  "button[aria-label*='Like' i][aria-pressed]",  // label-rewrite-resistant; aria-pressed WCAG-required
]
// (already in selectors.ts — keep; FIX: see §2.1 why locate fails)

// === REACTION FLYOUT (hover-to-pick) ===  LOW — ⚠ LIVE-CHECK
// hover Like btn → wait for: "[role='menu'] button"  (fallback ".artdeco-hoverable-content button")
// CONSERVATIVE DEFAULT: do NOT use the flyout. Click the plain Like button (a "Like" reaction).
// Reaction-picking is high-risk/low-value and the selector is unverified.

// === COMMENT BUTTON (opens composer) ===  MEDIUM-HIGH — ⚠ scope to post container
[
  "button[aria-label^='Comment on' i]",          // "Comment on <Name>'s post"
  "button[aria-label*='Comment' i]",
  // last resort, position-dependent: ".feed-shared-social-action-bar button:nth-of-type(2)"
]

// === COMMENT EDITOR (textbox) ===  CONFIRMED HIGH (pure ARIA)
[
  "div[role='textbox'][contenteditable='true']",
  ".comments-comment-box [contenteditable='true']",
]
// (already in selectors.ts — keep)

// === COMMENT SUBMIT ===  HIGH aria / MEDIUM class
[
  "button[aria-label='Post comment']",
  ".comments-comment-box__submit-button",
]
// (already in selectors.ts — keep)

// === "…more" / "see more" EXPANDER ===  MEDIUM — ⚠ LIVE-CHECK (weakest in set, BEM, no ARIA)  *** NOT YET IMPLEMENTED ***
[
  "button.feed-shared-inline-show-more-text__see-more-less-toggle", // Adsmith Feb-2025 bookmarklet uses exact class
  // text-content fallback: button in post whose visible text matches /\.\.\.\s*see more/i or /^see more$/i  (must NOT match "see less")
]

// === POST TEXT BODY ===  MEDIUM, UNVERIFIABLE externally — ⚠ LIVE-CHECK  *** NOT YET IMPLEMENTED ***
".update-components-text"
// fallback: longest visible text node inside the post container, minus actor/social-action subtrees

// === AUTHOR NAME ===  MEDIUM, UNVERIFIABLE externally — ⚠ LIVE-CHECK
".update-components-actor__name"
// (already used in locators.ts postAuthor — keep but treat as fragile)

// === SPONSORED / PROMOTED ===  CONFIRMED HIGH (text-based, rotation-immune)
/\bPromoted\b|\bSponsored\b/.test(post.textContent.slice(0,400))  ||  post.querySelector("[aria-label*='promoted' i]")
// (already in selectors.ts — keep)

// === DM COMPOSE / SEND ===  ARIA HIGH; ".msg-form" scope LOW-MEDIUM — ⚠ LIVE-CHECK the scope prefix
[".msg-form div[role='textbox'][contenteditable='true']", ".msg-form [contenteditable='true']"]
[".msg-form button[aria-label*='Send' i]", ".msg-form button[type='submit']"]
// (already in selectors.ts — keep; ARIA sub-selector works even if .msg-form scope rotates)

// === MEDIA DETECTION (for dwell weighting) ===  LOW — ⚠ LIVE-CHECK  *** NOT YET IMPLEMENTED ***
".update-components-image, [data-media-urn], video, .update-components-linkedin-video"
// Use ONLY as a soft +dwell signal, never as a click target.
```

### 2.1 Why likes fail today (root cause, not selectors)

The selector list in `findLikeButton` is correct (CONFIRMED HIGH). The failure is in the **locate flow**: `locateLikeTarget` runs `findFeedPosts(document)` synchronously after a single `cdp.wheel(...,800,...)`. On the live feed, the like button is inside the **social-action bar that only renders/attaches once the post is near-viewport and hydrated**, and the post the scroll landed on may be sponsored/already-liked, leaving `posts.length===0`. The diagnostic `no-likeable-post(posts=N,withBtn=M)` already exists — **wire the panel to surface it**, then fix by: (a) scroll to bring a *specific* candidate post to viewport center and `await` hydration (poll for the button up to ~1.5s), (b) widen the search to *all* in-viewport posts not just the top one, (c) skip sponsored/liked before picking. This is implementation, not selector, work (§6 Step 0).

---

## 3. Human-Behavior Engine Design

All distributions below are **concrete and seeded-RNG-implementable**. Where research conflicts/unverifiable, I state the conservative default. New helper needed on `Rng`: `logNormal(mu, sigma)` and `gamma(k, theta)` (derive from existing `next()` via Box–Muller for normal, sum-of-exponentials for integer-k gamma). Add these to `rng.ts` (pure, unit-testable).

```ts
// add to rng.ts
normal(mean, sd): number          // Box–Muller on two next() draws
logNormal(muLog, sigmaLog): number// exp(normal(muLog, sigmaLog))
gamma(k, theta): number           // sum of k exponentials (k integer) * theta; for fractional k, Marsaglia–Tsang
pickWeighted(weights: number[]): number
```

### (a) Scroll Engine — replaces `planScrollSteps`

Model a scroll as a sequence of **gestures**, each gesture = one flick OR one slow drag, followed by a dwell. Momentum decays exponentially (iOS PastryKit: `v(t)=v₀·exp(-t/τ)`, τ=325ms, ~6τ≈2s to stop).

**Gesture-type mixture (per gesture, weighted):**
- **Flick (momentum)** — p=0.45: peak velocity `v₀ = logNormal` with median **1800 px/s**, clamped [800, 3000]. Emit wheel events as a decelerating series: at 60fps frame budget (~16.7ms), `deltaY[n] = v(n·dt)·dt` with `v` decaying at 0.95/frame; stop when `|deltaY| < 2px` or cumulative ≥ gesture target. Gesture target distance: `logNormal` median **650 px**, clamped [200, 1400].
- **Slow drag (reading scroll)** — p=0.40: constant-ish `deltaY` median **90 px/notch** (`normal(90, 25)`, clamp [40,140]), 3–8 notches, inter-notch gap `logNormal` median **140 ms** (clamp [60, 400]).
- **Micro-nudge** — p=0.10: 1–2 notches of `normal(50,15)` px to re-center a post being read.
- **Back-scroll / re-read** — p=0.05 (raise to 0.15 *conditionally* right after a long-post dwell): scroll **up** `normal(180, 60)` px (mirrors the ~15% fixation-regression rate / ACM backtrack finding), dwell, then resume.

**Wheel-delta realism:** never emit the same `deltaY` twice in a row inside a gesture (jitter every value ±8%). Mouse-wheel notch base 100–120px; trackpad-style fractional deltas allowed in slow-drag. This raises scroll-spacing CV from ~0 to **>0.5** (human band).

**Inter-gesture dwell** (the attention pause): drawn from the reading-dwell model (b) when the gesture lands on a post; otherwise `gamma(k=2, θ=400ms)` (median ≈ 670ms) for transit pauses. **Never uniform.**

```
planScrollGestures(rng, totalPx, contentHints): ScrollGesture[]
  // contentHints: per-post {wordCount, hasMedia, topY} from content script
  // returns gestures with {deltas:number[], interDeltaMs:number[], postDwellMs?}
```

This is **pure** and unit-testable: feed seeded RNG, assert deltas decay (flick), assert no two equal consecutive deltas, assert CV of spacing > 0.4, assert total ≈ totalPx.

### (b) Reading-Dwell Model

Dwell time = function of word count, with the right *shape* (right-skewed, not normal).

- **Reading speed:** `wpm = normal(238, 60)`, clamp [130, 400] (Brysbaert; σ≈60 implied). Per session, draw **once** as the reader's personal speed, then add small per-post noise ±10% (people don't re-roll their reading speed each post).
- **Base read time:** `t_read = (wordCount / wpm) · 60_000` ms.
- **Skew & floor/ceiling:** wrap in a Weibull-flavored multiplier to capture skim-vs-engage. Implement as: with p=0.55 the user **skims** (multiply `t_read` by `gamma(k=2, θ=0.25)` ≈ ×0.5 median, floor 600ms = "short click/bounce" boundary at ≤5s); with p=0.45 the user **engages** (multiply by `gamma(k=3, θ=0.5)` ≈ ×1.5, and once past ~5s the hazard of leaving *drops* — Weibull k<1 negative-aging — so engaged reads can run long, cap at 45s).
- **Stop-vs-scroll-past decision:** P(stop to read this post) increases with wordCount and media:
  `P(stop) = sigmoid( -1.2 + 0.012·wordCount + 0.6·hasMedia + 0.4·isWatchlistAuthor )`
  - ~30-word post → P≈0.30; 200-word → P≈0.78; +media/watchlist pushes higher.
  - If "scroll past": dwell only `normal(450, 150)` ms (a glance), no `…more`.
- **Worked numbers:** 200-word post at 238wpm → 50.4s raw read; ×skim 0.5 = ~25s, ×engage 1.5 = ~75s→cap 45s. A 1-line (12-word) post → 3s raw → glance ~0.5–1.5s. This *directly* fixes the P1 "scroll-past everything at constant speed" tell.

```
readingDwellMs(rng, wordCount, {hasMedia, isWatchlist}, sessionWpm): number   // pure
decideStop(rng, wordCount, hints): boolean                                     // pure
```

### (c) Mouse Model — upgrades `mousePath` + `moveAndClick`

Replace the single quadratic Bézier + uniform sampling with a **sigma-lognormal velocity envelope + overshoot/correct + micro-tremor + variable point density**. This is the highest behavioral-impact change (Tier 2 of evasion checklist).

**Path shape:** keep a Bézier *spatial* curve (cubic, 2 control points jittered ±40–70px off the chord, biased to one side so curvature ratio > 1.1), but **re-parameterize time by a sigma-lognormal velocity profile**, not uniform `t`.

1. **Velocity envelope:** sum of **2–3 lognormal impulses** (agonist + antagonist + optional 3rd correction). Primary impulse peaks at ~40–55% of distance (bell-ish but asymmetric, slow initiation). Sample movement-time from Fitts: `MT = a + b·log2(D/W + 1)`, with **a = normal(150, 40)ms, b = normal(140, 30)ms/bit** (mouse consensus throughput 3.7–4.9 bps; intercept in the 0–400ms recommended band). Clamp MT [180, 900]ms. D=chord length, W=target size.
2. **Variable point density:** sample more points where velocity is low. Concretely: integrate the velocity envelope, place a `mouseMoved` event every time cumulative arc-length crosses a step that *shrinks near the endpoints*. Target ≈ **18–40 points** for a 300–600px move (vs current fixed 8–18) — and crucially **non-uniform inter-event sleeps** derived from the envelope (`dt[i] = arcLen[i]/v[i]`), not `sleep(6–22)` uniform.
3. **Overshoot + correct (every click):** primary movement stops **`normal(7, 4)` px past** target center (sign random). Pause `gamma(k=2, θ=35ms)` ≈ 60–120ms (micro-tremor active, velocity≈0). Then a short, **denser**, low-velocity corrective sub-movement into the click point. *This corrective low-velocity segment is the single most discriminative human feature in BeCAPTCHA — do not skip it.*
4. **Micro-tremor (always-on):** add 8–12 Hz sinusoidal noise, amplitude `normal(0.4, 0.2)` px RMS (clamp [0.1, 1.2]), to **every** dispatched coordinate — including during hover and the pre-click pause and idle holds. A human never holds a pixel still. Phase/amplitude jittered per session.
5. **Pre-click hover dwell:** on arriving at the element bbox, dwell `logNormal` median **220 ms** (clamp [80, 450] — Windows 400ms hover / 200ms prefetch threshold band) with ±1–4px tremor drift, *then* do the final approach. Breaks the "arrive-and-click-same-batch" tell.
6. **Click coordinate ≠ center:** sample a 2D Gaussian centered ~**70% from edge toward center** (slightly above-left for text targets), σ = **18% of element width/height**. Replaces `elementCenter()` for the *click point* (still use center for scroll-into-view).
7. **Idle drift:** between actions, when "looking at" the page, let the cursor slowly drift `normal(0, 8)` px over a few seconds (low-freq), independent of tremor.

```ts
// motion.ts — all pure, seeded-RNG:
mousePlan(from, to, targetSize, rng): { points: Point[]; sleepsMs: number[]; overshoot: Point; correctFrom: Point }
clickPoint(rect, rng): Point          // 2D-Gaussian, ~70% edge→center
tremor(base: Point, tMs, rng): Point  // 8–12Hz sinusoid + amplitude jitter
hoverDwellMs(rng): number             // logNormal ~220ms
```

**Testable invariants:** velocity has a single dominant peak in [35%,60%] of the path (not at 0% or 100%); CV of inter-event sleeps > 0.3; path contains an overshoot point beyond `to` then a correction back; ≥1 point lies off the straight chord by >curvature threshold; final point == clickPoint (not center).

### (d) Content-Aware Behavior

Content script returns per-candidate-post `{wordCount, isTruncated (has …more), hasMedia, author, isWatchlist}`. Behavior:

- **"…more" expansion:** if `decideStop()` true AND post `isTruncated` AND `wordCount(visible) > ~60`, with **p=0.7** click the `…more` expander (via the §2 selector), then **re-measure** word count and **re-run reading dwell on the now-fuller text**. Sometimes (p=0.3) read the truncated preview and move on without expanding (humans do this too). Expanding-then-reading is itself a strong human decoy action.
- **Longer dwell on media/long posts:** dwell model (b) already scales with wordCount; add `hasMedia → +normal(1500, 600)ms` (looking at the image/video) and a higher P(stop).
- **Comment/DM target reading:** before commenting (`doComment`), the current `sleep(800–2200)` is replaced by `readingDwellMs` computed from the *target post's* word count (you opened its permalink — read it like a human would before replying). Same for DM: dwell on the profile.

### (e) Action Scheduler Upgrades — augments `planTimeline`

Keep the burst architecture (it's good) but fix the *gap distribution* and add decoys/autocorrelation.

- **Inter-action gaps:** today bursts place actions at `rng.float(0, burstSpan·0.6)` (uniform). Replace within-burst spacing with **log-normal gaps + AR(1) autocorrelation**:
  `gap[n] = ρ·gap[n-1] + (1-ρ)·base[n] + ε`, ρ = **normal(0.4, 0.1)** clamped [0.2,0.6], `base[n] = logNormal` with **per-session median** drawn at session start (the "personal tempo," see (f)), typical median **150–280 s** between *write* actions, `ε = normal(0, 0.1·base)`. This raises inter-action CV from current ~moderate to the human **0.8–2.0** band and adds momentum so fast runs stay fast.
- **Burst structure:** keep ~1 burst / 45–90 min (`windowHours / float(0.75,1.5)`), but make burst *intensity* vary: each burst draws an action-count from a Gamma so some bursts are heavy, some light (humans batch then stop). Never the same daily total — vary ±20% day-to-day (e.g., 18, then 24, not 20 every day).
- **Decoy / non-goal actions** (new `PlannedAction` kinds, `kind:"decoy"`): interleave **2–4 per active hour**:
  - `decoy:hover` — hover a name/`…more`/reaction button, dwell 150–400ms, move away (no click).
  - `decoy:expand` — click `…more`, read, no reaction.
  - `decoy:profile-peek` — open a feed author's profile, dwell `gamma`, close, no action.
  - `decoy:scroll-explore` — scroll through 1–4 posts at reading pace before the *next real* action (never teleport to the target post).
  Decoys are scheduled by the planner (so they're seeded/testable) and executed in the tick loop.
- **Off-hours hard taper:** strengthen `densityWeight` from 0.25 → **0.05** in 23:00–06:00 local, and add a hard rule in the loop: **no `write` actions (like/comment/dm) between 23:00–06:00 operator-local**; decoys/ambient only. Off-hours writes are "a near-certain automation flag."

```ts
// scheduler.ts additions — pure:
planTimeline(...)  // now emits {kind: "like"|"comment"|"dm"|"decoy", subtype?, atMs}
//  - within-burst gaps via logNormal + AR(1)
//  - per-burst Gamma intensity
//  - decoys interleaved at 2–4/active-hour
//  - hard write-curfew 23:00–06:00
```

### (f) Session / Fatigue Model — new module `src/lib/session.ts` (pure)

Draw a **session persona** at `startRun` from a seed and hold it (this is the "session-level entropy" that prevents a repeated session signature):

- **Personal tempo:** base inter-action median `logNormal` ∈ [150s, 280s]; reading speed `normal(238,60)`; tremor amplitude; ρ; click-offset bias side. All fixed for the session.
- **Warm-up (first ~3–5 min):** scale inter-action gaps ×**1.4→1.0** ramp, and suppress writes for the first `normal(120, 40)`s (arrive, scroll, read before doing anything). Warm-up effects saturate fast (MacKenzie <3% across blocks) — keep it light.
- **Engagement decay within session:** multiply *base action rate* by a decay so late-session is slower: `rate(t) = rate0 · max(0.4, exp(-t/T))`, T ≈ **35 min** (softer than the aggressive ×0.2-at-5-min single-page model, which is per-*page* not per-*session*). Conservative default: gentle decay, since over-aggressive decay itself becomes a signature.
- **Micro-breaks:** every `gamma(k=2, θ=12min)` of activity, insert a break of `logNormal` median **90 s** (clamp [20s, 6min]) — pure idle, cursor idle-drift only.
- **Leave-and-return:** with p≈**0.15 per ~30 min**, do an `ambient:navigate` (already exists) to notifications/mynetwork OR **blur the tab** (focus another tab via no-op) for `logNormal` median 40s, then return. Models the >57% tab-switch rate. Vary whether a session is "read-heavy" (few writes, lots of scroll/dwell) or "action-heavy."
- **Circadian volume scaling:** scale the *target* action counts by time-of-day (peak 10:00–14:00 = ×1.0, evening ×0.8, early morning ×0.4, curfew ×0). 12–31% performance variation also nudges tempo (slightly slower outside midday).

### (g) Distraction / Idle Model

When no action is due (`idx < 0`), the loop already calls `runAmbient`. Upgrade ambient:
- **Scroll-read** (current default) → use the **new scroll engine + reading dwell**, not the old `wheel(...,600–1800,...)` + `sleep(1500–6000)`.
- **"Looking away" pause:** with p≈0.2, instead of scrolling, just idle (cursor idle-drift + tremor, no events) for `gamma(k=2, θ=4s)` ≈ 5–12s — models distraction. Power-law tail: rarely (p≈0.03) a long pause `logNormal` median 90s.
- **Non-productive hover during ambient:** occasionally hover a visible name/`…more` and drift away.

---

## 4. Detection-Evasion Checklist (prioritized — what moves the needle most)

**Already won (preserve, don't regress):** real headed Chrome extension on residential session ⇒ no `navigator.webdriver`, no `Runtime.enable` leak, no headless WebGL/JA4/HTTP-2 mismatch, isTrusted via CDP. **Never port to Playwright/headless.**

**Tier 1 — behavioral velocity (highest impact, all pure/testable):**
1. Sigma-lognormal velocity envelope + **overshoot+corrective sub-movement** on every click *(BeCAPTCHA's #1 feature)*.
2. **Micro-tremor 8–12 Hz on every coordinate**, including hover/idle (a still pixel = instant tell).
3. Variable point density + **non-uniform inter-event sleeps** (replace `sleep(6–22)` uniform).
4. **Pre-click hover dwell** (~220ms log-normal) + click point ≠ center (2D-Gaussian).

**Tier 2 — scroll & reading (fixes the user-reported "robotic"):**
5. Momentum/inertia scroll (τ=325ms decay), flick-vs-slow mixture, jittered wheel deltas, re-reads → scroll-spacing CV > 0.5.
6. Reading dwell proportional to word count (Brysbaert 238wpm) + stop-vs-scroll-past decision.
7. `…more` expansion on long truncated posts, then re-read.

**Tier 3 — timing & pacing:**
8. Replace all uniform `rng.float` action-gaps with **log-normal + AR(1) ρ≈0.4**; inter-action CV → 0.8–2.0.
9. Vary daily volumes ±20%; per-burst Gamma intensity; never identical schedule.
10. **Hard write-curfew 23:00–06:00**, circadian volume scaling.

**Tier 4 — behavioral completeness:**
11. Decoy actions 2–4/active-hour (hover-no-click, expand-no-react, profile-peek, non-task scroll before target).
12. Session persona + warm-up + decay + micro-breaks + leave-return; per-session entropy on every parameter.

**Tier 5 — hardening / can't-fully-fix (acknowledge limits):**
13. `getCoalescedEvents()` empty is **unpatchable from MV3**; mitigate by keeping volumes low so we're not pulled for inspection. (OS-level injection is out of scope.)
14. Keep acceptance/reply rates high (server-side spam signal #1) — this is a *content/targeting* lever (Lyra-side), but the actuator must not blast low-quality comments/DMs.

---

## 5. Safe-Pacing Recommendation (concrete)

Grounded in rate-safety research, biased conservative (this is the write path; HeyReach-style account-level bans are real). Caveat: the specific numeric thresholds in research ("40 profiles/20min", "200/day") are **community estimates, not official** (REFUTED as precise) — so treat all numbers as soft ceilings and keep well under.

**Hard rule (overrides everything):** velocity > totals. No burst > **5–10 write-actions/hour**; never uniform intervals (enforced by log-normal+AR(1) gaps median 150–280s).

**Established account, steady-state daily targets (set as `RunParams`/`caps` ceilings):**

| Signal | Conservative target/day | Hard ceiling/day | Per-hour cap | Notes |
|---|---|---|---|---|
| Likes | 30–50 | 80 | ≤10 | lowest-risk action |
| Comments | 15–25 | 40 | ≤5–8 | velocity is the risk, not total |
| DMs (1st-degree) | 12–20 | 30 | ≤4 | keep reply-rate >30–40% |
| Decoys (hover/peek/expand) | 20–40 | — | — | non-write, free |
| Active window | **07:00–21:00 operator-local** | never 23:00–06:00 | — | curfew enforced in loop |
| Inter-write spacing | logNormal median 150–280s | never < 45s | — | + AR(1) momentum |

**Warm-up ramp for a new/cold account (4 weeks), as a `warmupWeek` multiplier on targets:**

| Week | Likes | Comments | DMs | Connection reqs (if added) |
|---|---|---|---|---|
| 1 | 5–10 | 5 | 0 | 5 (known contacts) |
| 2 | 15–20 | 10–15 | 5–10 | 10 |
| 3 | 30–40 | 20–30 | 15 | 15 |
| 4+ | 50–80 (cap) | 30–40 | 20–30 | 20–25 |

**Day-to-day:** vary totals ±20% (18 one day, 24 the next — never exactly N daily). Distribute across 2–4 bursts in the active window. On any challenge/CAPTCHA (`detectChallenge` already wired) → **halt run, back off ≥14 days**, then resume at warm-up Week-2 levels.

---

## 6. Implementation Plan (mapped to files, ordered by impact)

Legend: **[pure]** = unit-testable with seeded RNG (no browser). **[browser]** = manual smoke only (CDP/DOM).

### Step 0 — Fix likes (unblock the whole pipeline) — *small, high-impact*
- **`src/content/locators.ts`** [pure-ish, fixture-testable]: in `locateLikeTarget`, search **all in-viewport** posts (not `posts[0]`), filter sponsored/already-liked, return the chosen post's `topY` + bbox so the loop can scroll it to center first.
- **`src/background/index.ts`** `tick()` like-branch [browser]: before locate, scroll the candidate to viewport center and **poll** `locateLike` up to ~1.5s for the social-action bar to hydrate (retry loop). Surface the existing `no-likeable-post(posts=N,withBtn=M)` diagnostic in `s.lastEvent`.
- Add fixtures: a multi-post feed + an already-liked post to `tests/fixtures/`. **Tests:** `tests/dom/locators.test.ts` — picks first likeable, skips sponsored/liked.

### Step 1 — Add distributions to `Rng` — *foundation* [pure]
- **`src/lib/rng.ts`**: add `normal`, `logNormal`, `gamma`, `pickWeighted`. **Tests** `tests/rng.test.ts`: seeded determinism + distribution sanity (mean/var within tolerance over N draws).

### Step 2 — New mouse model in `motion.ts` + upgrade `cdp.moveAndClick` — *highest behavioral impact*
- **`src/lib/motion.ts`** [pure]: add `mousePlan(from,to,targetSize,rng)` (sigma-lognormal envelope, variable density, overshoot+correct), `clickPoint(rect,rng)`, `tremor(base,t,rng)`, `hoverDwellMs(rng)`. Keep old `mousePath` temporarily for callers, then delete.
- **`src/background/cdp.ts`** `moveAndClick` [browser]: consume `mousePlan` — dispatch `mouseMoved` per point using the plan's **non-uniform `sleepsMs`**, apply `tremor` to every coord, do the **hover dwell**, then **overshoot → correct → press/hold/release** at `clickPoint` (pass the element rect from the locator, not just center). Ensure full chain: moves → `mousePressed` → hold `gamma`-ms → `mouseReleased`.
- **Signature change:** locators must return the element **rect** (x,y,w,h), not just center, so `clickPoint`/Fitts `W` work. Update `LocateResult` + `elementCenter` callers in `locators.ts`.
- **Tests** `tests/motion.test.ts` [pure]: invariants from §3(c) (velocity peak position, overshoot present, CV of sleeps, off-chord curvature, endpoint == clickPoint).

### Step 3 — New scroll engine in `motion.ts` + upgrade `cdp.wheel`/`ambient` — *fixes "robotic"*
- **`src/lib/motion.ts`** [pure]: add `planScrollGestures(rng, totalPx, contentHints)` (flick/slow/nudge/back mixture, momentum decay, jittered deltas). Delete `planScrollSteps`.
- **`src/background/cdp.ts`** `wheel` [browser]: consume gestures; emit `mouseWheel` with per-gesture decelerating deltas and **non-uniform** inter-event sleeps from the plan; tremor on the x,y.
- **`src/background/ambient.ts`** [browser]: replace the `wheel(...,600–1800)`+uniform-sleep with scroll-gestures + reading dwell; add the "looking away" idle branch and non-productive hover.
- **Tests** `tests/motion.test.ts` / `tests/ambient.test.ts` [pure]: deltas decay within a flick, no two equal consecutive deltas, spacing CV > 0.4, total ≈ target.

### Step 4 — Reading-dwell + content hints — *fixes proportional reading & adds `…more`*
- **`src/content/selectors.ts`** [pure, fixture-testable]: add `findSeeMore(post)`, `postText(post)`/`wordCount(post)`, `hasMedia(post)`, `isTruncated(post)`. Add fixtures (long post w/ `…more`, media post). **Tests** `tests/dom/selectors.test.ts`.
- **`src/lib/dwell.ts`** (new) [pure]: `readingDwellMs(rng, wordCount, hints, sessionWpm)`, `decideStop(rng, wordCount, hints)`. **Tests** `tests/dwell.test.ts`: monotonic in wordCount, right-skew shape, floor/cap respected.
- **`src/content/locators.ts`** [pure]: `locateLike` returns `wordCount/hasMedia/isTruncated/author`; add `locateSeeMore`.
- **`src/background/index.ts`** [browser]: in like-branch, run `decideStop`/`readingDwellMs` before clicking; expand `…more` (p=0.7) then re-read; in `doComment`/`doDm` replace fixed `sleep(800–2200)`/`(1000–2500)` with `readingDwellMs` from the target post/profile.

### Step 5 — Scheduler upgrade in `scheduler.ts` — *server-side pacing/CV* [pure]
- **`src/lib/scheduler.ts`**: within-burst gaps via `logNormal`+AR(1); per-burst Gamma intensity; emit `decoy` actions (2–4/active-hr) as new `PlannedAction` subtypes; strengthen off-hours `densityWeight`→0.05 and add `kind:"like"|"comment"|"dm"` **write-curfew 23:00–06:00**; vary daily total ±20%.
- **`src/lib/types.ts`**: extend `ActionKind`/`PlannedAction` with `"decoy"` + `subtype`.
- **Tests** `tests/scheduler.test.ts`: inter-action CV in [0.8,2.0]; zero writes in curfew window; decoys present; AR(1) autocorrelation lag-1 ρ in band; first-action-soon responsiveness preserved.

### Step 6 — Session/fatigue module — *session entropy* [pure + browser]
- **`src/lib/session.ts`** (new) [pure]: `makeSessionPersona(seed)` (tempo, wpm, tremor, ρ, curfew, read-heavy-vs-action-heavy), `warmupScale(tMs)`, `engagementDecay(tMs)`, `microBreakDue(activityMs, rng)`. **Tests** `tests/session.test.ts`.
- **`src/background/index.ts`** [browser]: build persona at `startRun`, store in `RunState`; apply warm-up suppression + decay + micro-breaks + leave-return in `tickOnce`. Thread `sessionWpm`/persona into dwell + mouse + scroll calls.

### Step 7 — Decoy execution in the loop [browser]
- **`src/background/index.ts`**: handle `kind:"decoy"` subtypes (hover-no-click, expand-no-react, profile-peek, scroll-explore-before-target). Reuse `mousePlan` for hover (move + hover dwell, **no press**).

**Build/verify:** run `pnpm build` in the worktree first (shared `@noelle/*` packages must be built or tests can't resolve dist — per the worktree-build lesson). All pure modules: `vitest run`. Browser-only steps (2,3,4-loop,6,7): manual smoke on a real LinkedIn tab with the panel log (DevTools can't be open during a run — it blocks `chrome.debugger`), watching `s.lastEvent` and the activity events. Verify likes succeed end-to-end (Step 0) **before** layering behavior on top.

**Sequencing rationale:** Step 0 unblocks (likes are functionally broken). Steps 1–3 kill the loudest behavioral tells (velocity + scroll = the user's actual complaint and BeCAPTCHA's top features). Step 4 adds the reading/`…more` realism. Steps 5–7 harden pacing and add decoys/session arc. Each step is independently shippable and the pure planners carry the test coverage; only CDP dispatch and live-DOM selectors need manual smoke.

---

### Conflicts / unverifiable parameters → conservative defaults taken
- **CDP `isTrusted:true`** — fragile/unconfirmed → don't rely on it; invest in behavior + low volume.
- **`getCoalescedEvents` as a deployed signal** — spec-real, deployment unverified → assume worst case, but unpatchable in MV3 → mitigate via low volume.
- **LinkedIn numeric rate thresholds** — community estimates (REFUTED as official) → use them only as soft ceilings, stay well under.
- **Per-page ×0.2-at-5min decay** — too aggressive for a *session* model → softened to exp decay T≈35min, floor 0.4.
- **Fragile selectors** (`…more`, `.update-components-text/-actor__name`, `.msg-form` scope, reaction flyout) — marked ⚠ LIVE-CHECK; prefer ARIA sub-selectors; **skip the reaction flyout entirely** (plain Like only).

**Relevant files:** `apps/linkedin-actuator/src/lib/{rng,motion,scheduler,types}.ts`, `.../src/lib/{dwell,session}.ts` (new), `.../src/background/{cdp,index,ambient}.ts`, `.../src/content/{selectors,locators}.ts`, `.../tests/{motion,scheduler,rng,ambient,dwell,session}.test.ts`, `.../tests/dom/{selectors,locators}.test.ts`, `.../tests/fixtures/*.html`.