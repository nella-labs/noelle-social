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
