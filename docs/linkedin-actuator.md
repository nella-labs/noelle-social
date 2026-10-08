# LinkedIn Actuator ("Lyra's Hands") — operator guide

## Discover + Reply hours

The in-page **Discover + reply automatically** button runs around the clock by default. Its **Pause comments and DMs during quiet hours** switch is optional; when enabled, the saved local-time window starts at 01:00 and ends at 09:00 unless you change either time. The start is included and the end is excluded, including for windows that cross midnight. During quiet hours the actor may keep browsing and liking, but it holds comments and DMs until a later paced slot.

The switch and times live in extension storage and survive a browser restart. Changes take effect at the next write slot, without interrupting an in-flight comment. This schedule takes precedence over the old Auto curfew while Discover + Reply is active. Manual Auto and Auto retain their existing behavior. Server-side send windows, caps, switches, challenges, and review checks still govern every attempted comment.

The floating panel shares its layout with the X actor. It shows active reply leads against the five-slot discovery limit (for example, `2/5`), the current run state, and an error alert when an action fails or a challenge is detected. **Discover + reply automatically** and **Stop actor** are the two visible actions. Quiet hours and the older Auto/Manual Auto modes are in collapsed sections; there is no on-page activity console. The count comes from the server's discovery-capacity endpoint once per minute; if unavailable, it falls back to the actor's loaded ready replies and shows an error.

The LinkedIn Actuator is a Chrome MV3 browser extension that executes pre-approved LinkedIn engagement from the operator's own logged-in browser tab. It is **Lyra's hands**: it pulls the approved queue that Lyra's draft-only pipeline produces and carries out likes, comments, and DMs with human-shaped timing over a multi-hour window.

Shared connection and input contracts live in `packages/actuator-cdp`.

**Making it multi-tenant (Lima → `api.trynoelle.com`, for all users):** `docs/linkedin-actuator-productionization.md`.

---

## What it is + safety posture

Lyra herself stays draft-only — discovery → profiler → drafter → approvals inbox, never auto-post. The actuator deliberately crosses that line, in the safest way possible:

- **Own account, own browser session, own IP.** No VM, no headless browser, no Voyager write paths. Traffic is a genuine authenticated session from the operator's residential machine.
- **Manually triggered.** Nothing happens until the operator opens `linkedin.com`, opens the panel, and presses **Run**. Stops the moment the tab is closed.
- **Tab-open-only.** The extension has no wake path when LinkedIn is not open. If the tab closes the run pauses; it resumes only when a LinkedIn tab is present again within the window.
- **Conservative, human-shaped pacing.** Actions are clustered into burst-and-idle sessions spread across a multi-hour window — never metronomic. Per-action jitter, inter-burst idle gaps, and an optional deep-night taper make the shape human.
- **Instant STOP.** The STOP button halts within the current action and detaches CDP. A run generation (epoch) makes it authoritative: STOP bumps the epoch, so any tick already in flight (mid-scroll, mid-post) and any lingering timer from the ephemeral service worker loads a now-stale epoch and bails instead of writing "running" back or firing one last action. The same epoch makes pressing **Run** while a run is live cleanly *supersede* it rather than spawning a second overlapping run (the old cause of the counter flip-flopping between two totals). An automatic halt fires if LinkedIn shows a challenge or captcha interstitial. As a server-side backstop, the api-vm `GET /api/actionable-linkedin` queue also halts for 1 hour after any `reason='challenge'` activity row (flag `NOELLE_LINKEDIN_HALT_ON_CHALLENGE`, default OFF/opt-in, fail-closed on a query error, auto-recovers when the hour elapses with no new challenge), so lights-out sending stops even if the extension's own client-side halt is bypassed.

This deliberately crosses LinkedIn's automation policy. It is intentionally conservative on velocity because sustained volume is the dominant account-lock trigger — see `docs/x-account-safety.md` for the analogous X reasoning. The operator accepts this tradeoff for their own account.

---

## Server-side send safety backstops (api-vm)

The browser extension's own caps and curfew are **advisory** — a tampered, misconfigured, or wrong-clock client can exceed them. So `GET /api/actionable-linkedin` (the queue the extension polls) enforces its own server-side gates that can only ever WITHHOLD items (serve fewer / an empty queue). All still return HTTP 200 with the normal `{comments, dms}` shape, so the extension keeps polling and resumes automatically. Every gate is **fail-closed** (on any error it serves nothing) and **off by default** unless noted.

| Gate | Env | Default | Effect |
|---|---|---|---|
| Master reply switch | `agent_instances.reply_send_enabled` (0081) | OFF | Empty queue until the operator flips it on in the dashboard. |
| One reply per post | always on (0084, 0107) | ON | The queue omits posts with a sent approval, comment activity, or durable pre-submit claim. The actor claims the canonical activity URN immediately before clicking Comment or using its submit shortcut. A lost send acknowledgment leaves that post reserved for reconciliation, preventing another automatic reply after a restart. Pre-submit loading and composer failures can still retry. |
| Challenge circuit-breaker | `NOELLE_LINKEDIN_HALT_ON_CHALLENGE` | OFF (opt-in; `1`/`true` to enable) | Halts the queue for 1h after any `reason='challenge'` activity row. Fail-closed (a failed count query halts). Auto-recovers. |
| Verifier precondition | `LINKEDIN_UNATTENDED_AUTOSEND` + `LINKEDIN_AUTOSEND_VOICE_FLOOR` (default `0.7`) | OFF | When ON, drops any auto-served COMMENT whose `draft_payload.verifier_meta` is missing / `pass!==true` / `scores.voice < floor` (fail-closed on ungraded/malformed). DMs are untouched (already human-approved). Pair with `LINKEDIN_UNATTENDED_AUTOSEND` in the linkedin-intern drafter (forces verify ON + floor≥0.7) so graded drafts exist. |
| Working-hours floor | `NOELLE_LINKEDIN_SEND_WINDOW_START` / `_END` / `NOELLE_LINKEDIN_TZ_OFFSET_MIN` | unset (disabled → 24h open) | Serves an empty queue outside the operator-local `[START, END)` hour window. See below. |
| Per-author daily cap | `NOELLE_LINKEDIN_PER_AUTHOR_DAILY_CAP` | unset (disabled) | Caps served WRITES (comment+DM) per author per calendar day, and drops any author already commented/DMed today. Non-numeric/`<1` fails safe to `1`. Runs BEFORE the global write-cap trim. |
| Global daily write-cap | `NOELLE_LINKEDIN_DAILY_WRITE_CAP` | 45 | Trims the served queue to the org's remaining daily comment+DM budget. |

### Working-hours floor

`NOELLE_LINKEDIN_SEND_WINDOW_START` (integer local hour, inclusive lower bound, 0-23) and `NOELLE_LINKEDIN_SEND_WINDOW_END` (integer local hour, exclusive upper bound, 1-24) define an allowed send window; `NOELLE_LINKEDIN_TZ_OFFSET_MIN` (default `-300` = UTC-5) sets the operator-local hour. It is **OFF by default** — with both unset the queue is 24h open (no behavior change) and the extension's own local-TZ 23:00-06:00 curfew is unchanged.

- When BOTH vars are set and `START !== END`, the api-vm serves an empty queue outside `[START, END)` (a window may wrap past midnight, e.g. `22`→`6`).
- The offset is a **fixed** minutes-from-UTC value; it does **not** follow DST — this is a coarse backstop, not a precise scheduler.
- If a window is configured but the values are invalid (non-integer / out of range / NaN), it **fails closed** (empty queue) rather than falling through to a half-open window.
- The server floor and the extension's client curfew are independent layers — **the tighter of the two wins.** Recommended production setting: `START=8`, `END=20`, `TZ_OFFSET_MIN=-300`, which is strictly tighter than the client 06:00-23:00 curfew.

---

## Trusted CDP input + the debugger banner

The extension dispatches actions as **real trusted browser input** via Chrome's DevTools Protocol (CDP), using `chrome.debugger`. Every mouse move, click, scroll, and keypress is emitted as a genuine `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` with `isTrusted: true` — not a synthetic `element.click()` (which carries `isTrusted: false` and is a known detection surface).

**The "Noelle Actuator is debugging this browser" banner** appears in Chrome for the entire duration of a run. This is expected, accepted, and stays. It disappears when the window ends, all targets are met, or STOP is pressed — whichever comes first.

The CDP layer (`src/background/cdp.ts`) wraps attach/detach and fires humanized mouse paths (sigma-lognormal velocity + 8-12 Hz tremor + overshoot-and-correct), realistic per-character typing cadence, and trusted wheel-scroll events. The content script does **not** synthesize any input; it only locates DOM elements and reports their viewport coordinates back to the background, which then dispatches trusted input at those coordinates.

### Detection-surface hardening (keep these invariant)

An adversarial 2026 detection sweep (see `docs/reply-actuation-strategy.md`) confirmed the `chrome.debugger` transport itself is not caught by any known method (it enables only the `Input` domain, never `Runtime`/`Page`/`Emulation`, so it never trips the `Runtime.enable` CDP leak; `isTrusted:true` is unfakeable and only `chrome.debugger` emits it). What the sweep *did* catch were two ordinary, self-inflicted tells the implementation had reintroduced. Both are fixed; keep them fixed:

- **Real keystroke metadata.** `typeText` emits each character with its true US-keyboard `key` / `code` / `windowsVirtualKeyCode`, and holds Shift across shifted characters (`src/lib/keyboard-layout.ts`). A bare `{ text }` keydown types as `keyCode=0` / `code=""` / `key="Unidentified"`, which no hardware produces and both LinkedIn and X read from keystroke telemetry. Characters with no single-key US mapping (emoji, accents, newlines) go through `Input.insertText`, never a malformed synthetic key.
- **No fixed DOM signature.** The control panel renders inside a **closed shadow root** under a host element with a per-load random id and no light-DOM text or child ids (`src/content/panel.ts`). A page-side DOM walk (LinkedIn's BrowserGate/Spectroscopy scans text nodes + attributes for automation markers) sees only an anonymous node, not a `noelle-actuator-panel` / `na-*` / "Noelle Actuator" signature. Never append a fixed-id, max-z-index, labelled node to `document.body`.
- **Minimal host permissions + no `web_accessible_resources`.** The manifest is scoped to `linkedin.com` + the local api-vm, with no `http://*/*` / `https://*/*` wildcards (`wxt.config.ts`), and declares no web-accessible resources (declaring WARs makes the extension enumerable by the fetch-probe fingerprinting that has caught other automation extensions).

The dominant real ban driver is behavioral velocity, not the transport; that is where the pacing layer and caps do the work.

### Reply-landing verification (a click is not a confirmation)

`doComment` used to return success the instant it dispatched the submit click — with no check that the comment actually posted. When LinkedIn's "Comment" submit button was off-viewport (a short browser window) the trusted click landed on nothing: the reply sat typed-but-unposted in the composer, yet the draft was still marked sent (the visible symptom: replies never landing while the coupled like did). `submitComment` (`src/background/index.ts`) now **confirms the post landed** before reporting success:

1. Poll up to ~3s for the submit button to appear/enable (LinkedIn enables it a beat after input), click it, then poll `readCommentBox` — LinkedIn **clears the composer on a successful post**, so an emptied (or vanished) box = landed, a still-populated box = did not.
2. If the click didn't clear the box, refocus the composer and submit via a keyboard chord (⌘+Enter, then Ctrl+Enter) — this works even when the button is off-viewport or never enabled. The empty-box check makes the fallback safe from double-posting (a chord into an already-cleared box no-ops).
3. Only a confirmed clear returns `true`. The actor claims the post before the first submit click or shortcut. A failure before that claim can retry; an uncertain result after the claim stays reserved and logs `comment-failed:claim-reserved` so the actor cannot post twice after a restart.

`readCommentBox`/`commentBoxText` are the pure read primitives (unit-tested); the CDP submit path itself is manual-smoke-only (drive a Run, watch a reply post and the composer clear). **Reload the LinkedIn PAGE**, not just the extension, to load the new content script.

#### Finding the submit on the 2026 redesign (anchored locator)

The 2026 UI migration broke every unanchored way of finding the submit button, and the failure was worse than a miss — it clicked the wrong thing:

- **Class names are obfuscated hashes**, so the legacy `comments-comment-box__submit-button` BEM selector matches nothing on migrated surfaces.
- **The action-bar comment TOGGLE was relabeled** from "Comment on \<name\>'s post" to bare **"Comment"** — the possessive-label exclusion went dead, and the toggle now exactly matches the submit word list.
- **The real submit is also bare "Comment"**, hash-classed, rendered in the composer row **after** the TipTap editor (next to "Show Emoji Picker" / "Share photo"), and **disabled until typing registers**. The migrated feed composer carries `type=submit`; the post-permalink surface is unverified, so the locator never requires it.

Since the toggle *precedes* the composer in document order, the old document-wide word scan returned the **toggle**: the background clicked it once (which opens the composer, never posts), the box never cleared, and every attempt logged `comment-failed:not-cleared` — a wall of them across posts that looked exactly like an action-block. `findCommentSubmit` (`src/content/selectors.ts`) is now **anchored to the composer**, in this order, first hit wins:

1. **`composer:<hops>`** — climb from the comment box up to 6 ancestors; the first level that yields an enabled, non-toggle, non-comment-item button that is **submit-worded** (mandatory — see below) *and* **follows the box in document order** wins (submit-styled is only a tiebreaker among worded candidates). Position, unlike labels/classes/SDUI hooks, has survived every LinkedIn redesign so far: the submit always renders after the editor, the toggle always precedes it. The climb never widens past a hit — and if a level holds only a **disabled** would-be submit it stops and returns null: the submit exists and simply hasn't enabled yet, so the poll re-asks instead of the climb escaping to decoys.
2. **`bem`** — the legacy BEM submit, now filtered: a *disabled* BEM submit is no longer returned (the old unconditional pass clicked it and silently no-oped).
3. **`global-primary`** — a document-order scan requiring worded AND submit-styled, and (when a composer exists) the hit must **follow** the box in document order.

The word-gate is deliberately non-negotiable: the messaging overlay's Send button is `type=submit`, so a styling-only pass could hand a comment to a chat pane — a private DM that clears the pane and *reads as posted*. Everything inside `.msg-form`/`msg-overlay` is excluded outright, and the box search itself steps over messaging textboxes (by those classes AND by an aria-label containing "message", in case chat classes get obfuscated like the feed's were) before anything is typed. The bare global word scan is **gone** — that was the proven hijack channel. The 2026 toggle is additionally recognized by its SDUI hooks (`data-view-name="feed-comment-button"`, a `commentButtonSection` componentkey ancestor, the `#comment-small` sprite icon) but never *relied* on — the live capture's toggle carries none of them, and position alone rejects it. Thread "Reply" buttons are rejected by their comment-item wrappers (`replaceableComment` componentkeys / `comments-comment-item` classes) where present, and by the word rule where not: bare **"Reply"** only qualifies when the button is also submit-styled (the main composer's submit is never labelled Reply; hook-less thread replies are). When nothing qualifies the locator returns **null**, which keeps the background's submit poll (**~12s**, widened from 6s) waiting — correct for the disabled-until-typed 2026 submit — and ends in a diagnosable failure instead of a wrong click. The wide window matters because the *same post* lands on one attempt and reports `submit-not-found` on another: the 2026 composer's submit enables and lays out a beat after the CDP typing, and 12s rides out that race where 6s clipped it.

#### Reading a comment-failed row (reason grammar)

A failed submit logs `comment-failed:<detail>` in `noelle.linkedin_activity.reason`; the detail now names the failing component (values sanitized to `[A-Za-z0-9 _-]`, whole detail capped at 120 chars):

| Detail | Meaning |
|---|---|
| `not-cleared(via=…,btn=…,type=…)` | A submit was clicked (and chorded) but the composer never cleared. `via` = which locator pass found it (`composer<hops>` / `bem` / `global-primary`), `btn` = its aria-label or text, `type` = its `type` attribute. A wall of these on the *real* submit is the signature of a LinkedIn comment action-block; a decoy `btn`/`via` means the locator drifted again. |
| `submit-not-found(box=…,empty=…,wf=…,en=…,vis=…,all=…,top=…)` | No clickable submit ever appeared in the ~12s poll. The composer read + a search diagnostic split the cause: `box=present,empty=false` = the reply is still sitting there. Then `wf` = worded submit candidates that follow the box (the locator's pool), `en` = of those how many enabled, `vis` = of the enabled how many had a non-zero rect, `all` = any "Comment"-ish button anywhere, `top` = `<label>_<why>` for the most telling candidate. Read it as: **`wf=0`** → no worded submit exists on this surface (selector model wrong — `top` says whether the only match was the toggle `_tog`/`_pre` or a thread reply `_itm`); **`en=0`** → the submit exists but never enabled (typing/editor-state race, `top=..._dis`); **`en>0,vis=0`** → enabled but no layout box yet (`top=..._zr`, the scroll/hydration race); **`vis>0`** → a clickable submit was right there and the locator still missed it (a real logic bug to chase). Older content script (pre-diagnostic) omits the `wf…top` fields. |
| `submit-zero-rect` | Locator-level skip (visible in the content script, folded into `submit-not-found` if it persists): the matched submit had a zero-sized rect (hidden/detached), which previously flowed through as a click at the viewport corner. The poll keeps waiting for it to become clickable. |
| `box-zero-rect` | Locator-level skip on the *box* side, folded into `comment-failed:box-not-found`: the box search only ever returns non-messaging textboxes (a chat pane's contenteditable is stepped over outright — typing a comment there, or chording ⌘/Ctrl+Enter into it, would send a private DM), and a hidden zero-rect box is skipped instead of clicked/typed at the viewport corner. A page whose only textbox is a chat bubble therefore reads as `box-not-found`. |

#### Shipping a locator fix (operator update path)

The extension runs in **Microsoft Edge** and is loaded unpacked from `apps/linkedin-actuator/dist-unpacked` (verified against Edge's `Secure Preferences`; the x/reddit actuators follow the same pattern). `wxt build` writes to `.output/chrome-mv3`, which Edge does NOT load — but the package `build` script already refreshes `dist-unpacked` from it with an **atomic swap** (build into `dist-unpacked.new`, rename into place — #448/#450), so there is **no manual sync step**; never `rsync --delete` into the live loaded dir by hand. Locator changes ride the **content script**, which only loads on page load:

1. Use the managed deployment path to build the installation; the actuator package build refreshes `dist-unpacked` atomically. See [the runbook](runbook.md).
2. Let the self-reload pick it up (≤5 min: the extension polls the served build stamp and `chrome.runtime.reload()`s itself — see "Self-reload on deploy" below), or expedite it: `edge://extensions` → reload the "Noelle LinkedIn Actuator" card.
3. **Reload the LinkedIn tab** — the self-reload/card-reload restarts the background worker, but the old content script (and the old locator) keeps running until the page reloads.

---

## Target-is-a-goal + supply-aware replenishment

Likes are supply-independent — the feed always has content. Comments and DMs are supply-gated: they need approved drafts from Lyra, and Lyra approves more over time. So the targets you set are a **goal to reach across the window**, not a snapshot drain of whatever is approved at Run time.

- The timeline plan allocates the target counts across the full window.
- The background re-polls `GET /api/actionable-linkedin` every ~7 minutes (jittered), merging newly-approved drafts into the pool.
- **When a comment/DM slot comes due but the pool is empty,** the slot is deferred to a later in-window time. No catch-up burst when supply arrives — still one action per tick, human-spaced.
- **Example:** target 40 comments, only 12 approved now → posts the 12 over their scheduled slots, then the remaining 28 slots keep deferring; as Lyra approves more, the pool refills and those slots fire on schedule. If only 31 get approved before the window ends, it posts 31 and **logs the 9-slot shortfall** — no silent truncation, no fabrication.
- While comment slots are deferring, the run stays live with likes and ambient browsing, so the session still looks like a human casually active.

### Persistent Drain (one click, never re-click)

The manual **Drain all approvals** button used to end the run the moment the inbox went empty — so approvals made later needed a fresh click. It is now **self-perpetuating**: one click keeps the run alive until you press **STOP** (or a challenge halt, or the runaway ceiling). Mechanics (`drainShouldKeepWaiting` in `src/background/replenish.js` + three touches in `background/index.ts`):

- **Never ends on an empty inbox.** When every planned slot is done and `maybeExtendDrain` finds nothing to append, the run does **not** go `idle`/`endRun`; it stays `running` in a "watching" state (`lastEvent: "inbox clear — watching for new approvals"`).
- **Watches for new supply.** While caught up, the idle branch re-checks `GET /api/actionable-linkedin` every `DRAIN_WATCH_POLL_MS` (~75 s) and appends fresh slots when approvals appear, so a reply approved later goes out within ~a minute — no re-click. (This is in addition to the ~7-min replenish poll during active batches.)
- **Window can't time it out.** The window-expiry end path rolls `windowHours` forward (`DRAIN_WATCH_WINDOW_H`) for a waiting drain instead of ending it.
- **`MAX_DRAIN_ROUNDS` raised 50 → 1000** and re-scoped to count only **actual send-batches** (empty watch-polls don't burn it). Server-side daily/per-author caps starve real supply long before 1000 batches, so the ceiling is a runaway backstop, not a normal stop.
- **Safety brakes unchanged.** It still only sends **server-approved** items inside the send window; outside the window / on a per-author cap / on a challenge the server serves an empty queue and the loop idles harmlessly. A **challenge halt still ends the run** (needs a manual restart, by design). The **tab must stay open** — the loop is driven by the content-script tick.

### Lights-out auto-drain (no manual "Drain all approvals" click)

The daily autonomous run stops at its comment target; approvals made after that used to sit until the operator clicked **Drain all approvals**. With **Options → auto-drain** ticked (requires *Autonomous* on), the 5-minute autonomy alarm also starts a **drain** whenever the server serves approved comments and nothing is running, so an approval made mid-afternoon goes out mid-afternoon. Semantics:

- **Consent is server-side and standing.** The unattended paths never arm `reply_send_enabled` (the panic-stop invariant). Instead the `GET /api/actionable-linkedin` gate honors `agent_instances.auto_send_enabled` as durable lights-out consent (`reply_send_enabled OR auto_send_enabled`); set it once from the dashboard/DB for Lyra's instance. **Pause-all clears both flags**, so a panic still starves auto-drain org-wide.
- Same **safety gate** as the daily auto-start (server `/health` ok + post-challenge cooldown), same operating window (start/end hours), and every server-side withhold gate (challenge circuit-breaker, working-hours floor, caps) applies unchanged: an empty served queue simply means no drain starts.
- **Not once-per-day**, but re-arm-limited: at most one auto-drain start per 30 min (`AUTO_DRAIN_REARM_MIN`), so a drain that keeps dying with items still queued (no LinkedIn tab, comment-fail give-ups) can't be relaunched forever. A drain that runs normally self-extends until the inbox is clear, as before.
- A manual **STOP silences auto-drain for the rest of the day** (`actuator.lastManualStopDay`), exactly like it already silences the daily auto-start.

### Stalled-run recovery (auto-drain a wedged run)

Lights-out auto-drain only fires when **nothing is running** — `shouldAutoDrain`'s `runActive` gate skips whenever a run is live. So a run that is `"running"` but **wedged** (a frozen tick loop, a tab that wandered off a `/feed/`, a wall of `comment-failed` skips, or drafts it can't submit) would pin the actor with approvals piling up and never recover — it *looks* busy but posts nothing. That's the "seems stuck" case.

The 5-minute autonomy alarm now also runs `maybeRecoverStalledRun` (before `maybeAutoDrain`). It supersedes a wedged run with a fresh drain, but only when the run is **provably** stalled — `shouldRecoverStalledRun` (pure, in `lib/autonomy.ts`) requires ALL of:

- drafts are **loaded** (`commentPool` non-empty — a run idle-waiting for supply is *not* stuck), and
- comment slots are **overdue** (an unexecuted `comment` slot whose time has passed — a correctly-paced run between actions is *not* stuck), and
- **no successful post for `STALL_RECOVER_MIN`** (default 20 min, `cfg.stallRecoverMinutes`; Reddit 30, above its ~19-min drain-cooldown gap), and
- the run is **past warm-up**, and
- the stall **persists across two consecutive autonomy ticks** with no progress between them (`confirmStall`).

That two-tick confirmation is the load-bearing guard against false positives: a single snapshot can't tell a *healthy* run momentarily past the threshold — a scheduled run's legitimately large inter-comment gap (writes are spread by `maxWritesPerHour`), or the ~15–60 s window while a post is mid-flight and the slot still reads overdue — from a genuinely wedged one. A healthy run posts within ~60 s, so by the next tick (~5 min later) its `lastProgressMs` has advanced and it never confirms; a real wedge makes no progress and confirms on the second sighting. The observation rides a persisted probe (`actuator.stallProbe` = session + progress marker), cleared the moment the run makes progress, ends, or is superseded.

It then passes the **same gates as auto-drain** — `passesAutoStartSafety` (server `/health` ok + post-challenge cooldown), operating window, STOP-day silence — and **shares the auto-drain 30-min re-arm stamp** (`AUTO_DRAIN_MS_KEY`), so a false positive can start **at most one drain per re-arm window per lane**. Recovery is **fail-closed** (clock skew → skip) and **never arms sending** (`startDrain` unattended supersedes the wedged run via an epoch bump; supply is still the server queue gate, so a wrongly-triggered recovery just supersedes and starves). `RunState.lastProgressMs` is stamped on every landed post; the detector falls back to `startMs` for a run that never posts. Requires the **auto-drain opt-in** (`cfg.autoDrain`); Vega and Orion carry the identical mechanism.

### Drain gap patterns (no fixed reply → likes → reply shape)

Every drain gap used to look identical — reply, 4–9 likes evenly scattered, next reply — and a rigid shape repeated all session is itself a fingerprint. Each between-reply gap draws a **behavior pattern** from the plan RNG (`GAP_PATTERNS` in `src/lib/scheduler.ts`, weights in parentheses). **2026-07-23 quiet re-tune:** the operator wants the wait before a reply to look *idle*, not busy — the like-free gap is now the modal draw and no pattern places more than **3** likes (the old `full` fill was 4–9, which read as a ~10-like burst before a reply):

| Pattern | Shape of the gap |
|---|---|
| `full` (14%) | 1–3 likes scattered through the gap — the busiest a gap gets |
| `cooldown` (46%) | **zero likes** — a quiet flat pause of 60 s up to ×1.2 of the session's gap tempo (1–3 min at the default band; a slow lurker's cooldowns stretch toward ~5 min, so the modal quiet gap is *not* one archetype-independent uniform); ambient browsing still scrolls, so the session looks alive without acting |
| `light` (20%) | exactly 1 like somewhere in the gap |
| `frontload` (7%) | 1–2 likes in the first ~40% of the gap, then quiet |
| `backload` (7%) | quiet first, 1–2 likes only in the last ~40%, then the reply |
| `cluster` (6%) | a tight ≤30 s pair (1–2 likes) somewhere in the gap |

Invariants: every pattern acts the same or **less** than the pre-re-tune fill, every gap keeps the `gapMin` floor (60 s), and the reply-gap band (60–315 s) is unchanged — so the re-tune only ever slows the account down, never speeds it up. Explicit `likesPerGap` knobs mean "exactly this" and disable the pattern draw. **Drain mode never idle-likes at all** (`shouldIdleLike`'s `inDrain` gate): the gap's planned like slots are the *only* likes between replies, so a quiet gap stays a genuine pause. (`inQuietDrainGap` remains the planner's quiet-gap definition, exercised by the tests and kept for shape-parity with the X/Reddit copies, but it no longer has a runtime caller.)

### Drain session temperament (unpredictable across sessions, not just gaps)

The gap patterns above break the "every gap looks identical" fingerprint; this breaks the "every **session** looks identical" one. Each drain draws a named **archetype** once at `startDrain` (`pickDrainArchetype` in `src/lib/scheduler.ts`), jitters it, and persists it on `RunState.drainStyle` so every auto-continue round shares one coherent mood:

| Archetype | Character |
|---|---|
| `steady` | balanced — matches the base per-gap weights, normal tempo, no breaks |
| `lurker` | almost all reading, the odd single like — cooldown-heaviest, slower tempo, takes long breaks |
| `engager` | the likiest temperament — still ≤3 likes/gap (~1/gap mean), brisk (never below the floor) |
| `skimmer` | shallow pass — single + front-loaded likes between quiet gaps, no breaks |
| `bursty` | a tight like-pair now and then, otherwise quiet — break-prone |

Each archetype sets a per-session **pattern-weight vector** (so no two sessions share the base 14/46/20/7/7/6 mix; all five vectors lean cooldown since the quiet re-tune — they differ in *how* quiet), a per-session **gap tempo** (`gapMaxMs`, always ≥ the 150 s default so it only slows), and **break-proneness**. A break-prone session inserts one **long "stepped away" pause** (~5–12 min) at a random reply boundary, chosen by a separate plan-derived RNG; that gap carries zero likes — and since drain mode never idle-likes, the pause plays out untouched.

Safety by construction: every archetype is a weight vector over the **same six patterns** (all of which place ≤3 likes, so no vector can exceed an all-`full` 1–3/gap volume), `gapMaxMs` is never below the 150 s default (never faster), and a long break only **adds** time — so every archetype is same-or-slower than the base mix. The archetype rides optional `DrainOpts` fields (`patternWeights`, `longBreakMs`), so `planDrainTimeline` called without them (the direct unit-test path) uses the stock defaults; both plan call sites (`startDrain` + `maybeExtendDrain`) pass the same persisted `drainStyle`.

### Self-reload on deploy (no edge://extensions click)

Edge loads the unpacked extension from `apps/linkedin-actuator/dist-unpacked` (untracked; ignored). The package `build` script refreshes that dir from `.output/chrome-mv3` on every build, so each merge-driven deploy (`noelle sync` runs `pnpm -r build`) puts fresh bits at the load path and the self-reload below actually picks them up.

`wxt build` embeds a build stamp in the bundle and writes the same stamp to `.output/chrome-mv3/build-stamp.json`. Token-authed `GET /api/actuator/extension-build` serves the on-disk stamp (fail-soft `null` when unreadable; path override `NOELLE_LINKEDIN_EXT_STAMP_PATH`). On the 5-minute alarm the extension compares stamps and calls `chrome.runtime.reload()` when a newer build landed, which re-reads the unpacked dir. Never during a run; one attempt per served stamp, so a machine whose unpacked copy is not synced to the served build (e.g. the laptop) tries once and stays quiet instead of looping. Works independently of the autonomy checkboxes, so every merge-driven deploy reaches the browser on its own.

### Pacing fits the window (short windows included)

The plan derives its inter-action gap from the window: the typical gap is the smaller of the operator's session tempo (150–280s) and `window ÷ (action count)`, floored at a ~40s human minimum. This keeps a short run from the old failure mode where a fixed multi-hour gap overflowed the window — the first ~half did nothing, then everything clamped to the window end and fired at once.

- A lone burst (short windows) anchors at the **window open**, not its midpoint, so the first action fires within seconds, not ~50% of the way in.
- If more actions are requested than can fit the window at a human pace, the overflow is **dropped and logged as a shortfall** (a `ClampNote`), never squeezed in or piled at the end. Requesting 90 actions in 30 min posts what fits (~40) and reports the rest — lengthen the window or lower the targets to raise the ceiling.
- Warm-up (read-before-acting) is capped at 10% of the window, so a 30-min run isn't eaten by up to ~4 min of warm-up.
- **Occasional "stepped-away" pause.** On top of the tempo gap, ~1 action in 5 (at random) gets an extra **0–300 s (0–5 min)** added to its gap — a one-off distraction, not a tempo change (it's kept out of the AR(1) autocorrelation and never compounds). This keeps the gap distribution heavy-tailed like a real person who occasionally steps away, and it only widens spacing (overflow past the window is dropped + logged, never clustered). The pause is capped at 5% of the window, so multi-hour runs get the full 0–5 min while a short 30-min run isn't back-loaded by a single 5-min gap. Tunable via `EXTRA_PAUSE_PROB` / `EXTRA_PAUSE_MAX_MS` in `src/lib/scheduler.ts`.

---

## Ambient browsing

During idle gaps between bursts, or while waiting on comment supply, the extension runs ambient behavior so the tab looks like a human reading — mostly scrolling and expanding "…more"; since the 2026-07-23 quiet re-tune the wait is deliberately **read-heavy, not like-heavy**:

- **Idle-liking — a rare like in the wait (Run/auto mode only).** While nothing is due, the actor occasionally slips a real feed-like into the gap. Each idle-like uses the same read-then-click machinery as a scheduled like (find a hydrated feed post, read it, sometimes expand "…more", then a trusted click). It is **slow-paced** (a rolling ~5 min minimum gap, ×1–1.8 jitter ⇒ roughly one like per 5–9 min of waiting; was ~45–80 s before the re-tune), **curfew-gated** (via the shared write-curfew switch), and **budget-bounded**: idle-likes count against `s.done.likes` and only fire while `done < targets.likes`, so total likes (idle + scheduled) never exceed the plan's cap-bounded like budget — a scheduled like slot the idle-likes already covered is skipped (`like-budget-met`). **Drain mode never idle-likes**: the idle top-up used to share the drain plan's budget and race ahead of it (stacking ~10 likes before a reply); now the gap's planned like slots (see *Drain gap patterns* — usually 0–1) are the only likes between replies, and the wait is ambient browsing alone.
- **Primary — slow scroll + read.** Trusted `wheel` scrolling down the feed at a human pace with dwell pauses on posts and occasional small back-scrolls. No interactions counted against targets.
- **Read-actions — expand "…more" + open comments.** A real reader doesn't only scroll: they expand truncated posts and open the discussion under a post to read it. So the ambient loop also, at a paced rate, moves the cursor to a truncated post's "…see more" toggle and clicks it (then reads the fuller text), and opens a post's comments — preferring the social-counts "N comments" link, which expands the thread **without** focusing the composer — then reads a few. The choice now **leans toward expanding "…more"** (the dominant read-action) so the actor actively opens posts while waiting. Both are **read-only** (trusted CDP click via the same motion engine as likes) and **non-counted** against the like/comment/DM targets. They only fire on posts actually in the viewport; when nothing suitable is in view the tick downgrades to a plain scroll. Controlled by **Ambient read-actions** in options (default ON — more read behavior lowers the behavioral signature; it never posts).
- **Occasional — navigate-away-and-back.** With low probability, visits a profile or the notifications tab, dwells, then returns to the feed. Rate-limited so it stays rare.

Ambient actions are jittered and separate from the action targets. The read-actions are additionally **cooldown-paced** (a rolling ~20–40 s minimum gap, jittered) so they cluster like real reading instead of firing on every ~4 s idle tick; the cooldown advances only when an action actually happens (a downgraded-to-scroll attempt does not burn it).

Every ambient tick **first re-asserts the feed** (the same `ensureOnFeed` guard the likes use). Without it, a reply/DM or a mis-landed click that left the tab on a profile turned the idle browse into an endless scroll of *that profile's own* activity cards (`findFeedPosts` matches them), so the actor looked busy while liking nothing — the run appeared to "die" on a profile page. See **Feed likes + zero-likes diagnostics** below.

---

## Feed likes + zero-likes diagnostics

Standalone feed likes (the scheduled `like` actions, distinct from the reply-coupled like each comment also lands) are hardened against the ways they historically produced zero likes — and against a like click that navigated the tab *off the feed onto a profile*:

- **Off-feed tab.** A standalone like only works on `/feed/`. The tab gets left off the feed several ways: a comment (non-drain mode) leaves it on a post permalink, a DM lands it on a `/in/` profile, or the operator drives it away. One shared guard — `ensureOnFeed` — now runs before **every** feed-scoped action: scheduled likes, idle-likes, **and the ambient browse**. It pulls the tab back to `/feed/` whenever it isn't already there (drain mode also returns to the feed after each reply, and DMs return to the feed after sending). Previously only the like path had this guard, so the ambient browse would keep scrolling whatever profile the tab had wandered onto.
- **Tab hijack.** The run **pins the tab it started on** (`RunState.tabId`) and reuses it every tick; it only re-picks a tab (preferring one actually on `/feed/`) if the pinned tab was closed. Before pinning, the tab was re-chosen every tick as the *first* `linkedin.com/*` tab, so an operator's own `/in/` profile tab that merely sorted first could silently hijack actuation.
- **Stale-rect click after "…more".** Expanding a truncated post grows it **in place**, shifting the like button down; lazy-loaded media does the same. The like used to click the rect measured *before* the read, which now landed in the post **body** — sometimes on an `@mention` (→ a profile, same tab) or an external link (→ a new tab) — navigating off the feed *and* missing the like. The like button is now **re-located immediately before the click**, so the click lands on the current button.
- **Container-markup drift.** LinkedIn renames feed-post container classes/attrs regularly; when every known container selector misses, `findFeedPosts` falls back to deriving posts from their **"React Like" buttons** — for each Like button it climbs to the post-sized container that wraps exactly it. The reaction button's `aria-label` is far more stable than the container class, so likes survive a feed redesign that would otherwise strand them at `posts=0`.

**Reading a like skip in `noelle.linkedin_activity`.** A skipped like logs `no-likeable-post(posts=P,withBtn=B,btns=N,path=/…)`:

| Field | Meaning |
|---|---|
| `posts` | feed cards `findFeedPosts` found (incl. the drift fallback) |
| `withBtn` | of those, how many exposed a Like button |
| `btns` | **React Like buttons anywhere on the page** — `0` ⇒ the feed wasn't loaded (or the button label itself drifted); `>0` with `posts=0` is unexpected (the fallback should have recovered them) |
| `path` | `location.pathname` — anything other than `/feed/` means the like fired off the feed |

So `btns=0,path=/feed/` ⇒ the feed genuinely had no visible posts (scroll/hydration or a label change); `btns>0` ⇒ investigate the container fallback; `path≠/feed/` ⇒ the `ensureOnFeed` guard didn't take (now rare: the guard runs before likes *and* the ambient browse, and the tab is pinned to the run).

### Reaction variety (not every like is a 👍)

A real person doesn't only tap Like — they Celebrate a launch, Support a hard update, react Insightful to a good teardown. So the actuator **varies the reaction** on every like it lands (both the scheduled/idle feed-likes and the like each reply couples), with an inclination toward **Like, Support, and applause (Celebrate)**:

- **The mix.** `pickReaction` (`src/lib/reactions.ts`) draws a reaction from a weighted table. Defaults (relative %): **Like 70, Celebrate 10, Support 10, Love 4, Insightful 4, Funny 2** — so ~70% stay a plain Like and the ~30% tail is dominated by Support + Celebrate, exactly the "inclined" three. Reactions are keyed by LinkedIn's Voyager enum (`LIKE / PRAISE / EMPATHY / APPRECIATION / INTEREST / ENTERTAINMENT`); `PRAISE` is the 👏 applause reaction and `EMPATHY` is the 🫶 support one.
- **How it lands.** A plain Like is a single trusted click on the Like button (unchanged, dominant path). For a non-Like pick, the background **hovers** the Like button (`Cdp.hover` — the same motion engine as a click, minus the press, held ~0.65–1.15 s so LinkedIn reveals the six-reaction flyout), then `locateReaction` finds the chosen reaction button (by its `data-reaction-type`, falling back to the visible label inside the `.reactions-menu`) and clicks it.
- **Never costs a like.** If the flyout doesn't open or the reaction can't be located, it **falls back to a plain Like** on the still-hovered button — so introducing variety never turns a would-be like into a no-op. The delivered reaction rides the `like` activity event's `reaction` field and shows in the panel (`reacted Celebrate to Jane (3/40)`); it is accepted by the server schema but not yet persisted to a column.
- **Tunable.** `reactionWeights` in the actuator config overrides any per-type weight (a `0` disables a reaction; all-zero ⇒ always a plain Like), so an operator who wants only Like + Support can pin the rest to 0 without touching code.

---

## Architecture

```
Lyra (Lima VM)                  api-vm (Lima)                     Chrome MV3 extension (operator browser, linkedin.com tab)
discovery→profiler→drafter  →   noelle.approvals          ◄─GET── background service worker  ── SCHEDULER / brain
   (unchanged, draft-only)      (status='pending')        ──POST►   • fetches queue, builds plan
                                noelle.linkedin_activity            • chrome.alarms dispatches actions
                                                                    • batch-POSTs telemetry
                                                                            │
                                                                            ▼
                                                                  content script (linkedin.com) ── HANDS
                                                                    • locateLikeTarget / locateCommentBox
                                                                    • navigateToPost / locateProfileMessageButton
                                                                    • detectChallenge
                                                                    • selectors.ts (single source of DOM truth)
                                                                            │
                                                                  floating control panel (injected UI)
                                                                    • Run / STOP, live log, counters vs targets
```

API endpoints the extension uses:

| Endpoint | Role |
|---|---|
| `GET /api/actionable-linkedin?instanceId=<id>` | Returns the approved work queue — `{comments:[...], dms:[...]}`. (New) |
| `POST /api/linkedin-activity` | Telemetry: like/comment/dm/skip events. Writes to `noelle.linkedin_activity`. (New) |
| `POST /api/drafts/:id/approve-dm` | Greenlights a specific DM for sending (sets `dm_send_approved=true`); DMs only fire after this. Actuator-token guarded. (New) |
| `POST /api/actuator/mark-sent/:approvalId` | Records the approval as sent after the extension posts to LinkedIn. Actuator-token-guarded. `:approvalId` is the `approval_id` from the queue response (not the `draft_id`). The extension forces `sent_via:'extension'`. (New) |

The extension source lives at `apps/linkedin-actuator/`. Entrypoints: `entrypoints/background.ts` (scheduler brain), `entrypoints/content.ts` (locators), `entrypoints/panel.ts` (floating UI), `entrypoints/options.html` (config). Built with `wxt` (MV3 ergonomics) — output at `.output/chrome-mv3/`.

---

## Operate

### Load the extension

1. Build the extension (from the repo root):
   ```bash
   pnpm --filter @noelle/linkedin-actuator build
   ```
2. In Chrome, go to `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `apps/linkedin-actuator/.output/chrome-mv3/`.

### Set options

Open the extension's **Options** page (from `chrome://extensions` → Details → Extension options) and fill in:

| Field | Value |
|---|---|
| API base URL | Lima tunnel URL (e.g. `https://<tunnel-host>`) or `https://api.trynoelle.com` for prod |
| Bearer token | The static actuator token (Lima: `NOELLE_ACTUATOR_TOKEN`; prod: your Noelle dashboard JWT — see Prod port below) |
| Instance ID | Your Lyra instance UUID (from the dashboard URL on the Lyra agent page) |
| Daily cap — likes | Hard ceiling, default 120 |
| Daily cap — comments | Hard ceiling, default 80 |
| Daily cap — DMs | Hard ceiling, default 10 |
| Watchlist preference | Ratio for preferring watchlist connections in the like feed (0–1, default 0.7) |
| Deep-night taper | On/off; if on, action density drops in a configurable overnight window (default 1am–6am local) |
| Ambient read-actions | On/off (default **on**); while idle-browsing, expand "…more" and open comments to read. Read-only, non-counted, cooldown-paced. Turn off to revert to scroll-only ambient |

### Keep the machine awake

The extension dispatches actions via `chrome.alarms` — it works while Chrome is open but will pause if the machine sleeps. Keep the machine awake for the run:

```bash
# macOS: prevent sleep, display sleep, idle, and disk sleep
caffeinate -dimsu
```

On Linux/Windows, disable automatic sleep in system settings for the duration of the run.

### Run

1. Open `https://www.linkedin.com` in a tab (must be the logged-in account).
2. Open the floating panel (extension icon or keyboard shortcut).
3. Set **Window** (hours), **Target comments**, **Target likes**. DMs appear as a read-only count (all approved DMs are greenlit — see [DM approval](#dm-approval) below).
4. Press **Run**, or **Drain all approvals**, or **Full automatic** (below).
5. The Chrome "Noelle Actuator is debugging this browser" banner appears — this is expected.
6. Watch the panel's ready-reply count, run state, and error alert.
7. Press **STOP** at any time to halt immediately and detach CDP (banner disappears).

> **Renamed 2026-07-26.** The panel now reads **Auto** (was "Full automatic"),
> **Manual Auto** (was "Drain all approvals"), and adds **Auto notifications**.
> The manual `Run` button and the Window/Comments/Likes inputs were removed —
> `startRun` still exists for the lights-out auto-start, it just has no manual
> surface. The underlying commands are unchanged, so the table below still
> applies under the new labels. See `docs/notifications-actor.md`.

### Run vs Drain vs Full automatic (three buttons)

| Button | Cmd | Overnight posting-curfew | Use it when |
|---|---|---|---|
| **Run** | `startRun` | off | A one-shot windowed session (spread N comments/likes over H hours). |
| **Drain all approvals** | `startDrain` | **off** — writes at any hour | You're present and want the inbox cleared *now*, including at night if you just approved replies. Persistent (watches for new approvals). Unchanged. |
| **Full automatic** | `startFullAuto` | **on** — 1am–9am local | Set-and-forget. Same persistent drain as "Drain all approvals" but it **holds comments/DMs during your sleep window** (1am–9am, `CURFEW_START_HOUR`/`CURFEW_END_HOUR` in `src/lib/curfew.ts`). Ambient browsing (plus the gap's occasional scheduled likes) continues overnight so the session still looks alive; held posts fire from 9am. |

**Why two drain buttons.** "Drain all approvals" is deliberately curfew-free — the operator chose the hour, so a night approval goes out at night. "Full automatic" is the safe leave-it-running mode: because it's unattended, it must not post at 3am, so it defers comments/DMs across the night and resumes in the morning. The overnight posting-curfew is **also** applied to every unattended auto-start path (daily auto-start, lights-out auto-drain, stall-recovery) — those pass `{ curfew: true }` regardless of the button. Manual **Run** and **Drain** never curfew. The curfew is a single switch (`isWriteCurfew(atMs, enabled)`), enforced by the runtime hard-floor in `tickOnce` (posts only — `isPost`); the per-run `curfewEnabled` flag on `RunState` is what turns it on.

**Reply-coupled like is no longer 100%.** Every reply also reacts to the post it opened ("a human likes what they engage with"). Because a *perfectly* consistent reply→like pairing is itself a tell, the reaction is now skipped on a small, drifting fraction of replies — starts at **2%**, re-rolled uniformly in **[1%, 5%] every 123 replies** (`src/lib/like-skip.ts`, drift state persisted on `RunState.likeSkip`). Feed likes are unaffected.

**Group-post feed-like fix.** `ensureOnFeed` now uses the strict `isHomeFeedUrl` (home feed only) instead of the permissive `isFeedUrl`, so a run whose tab is parked on a post permalink (`/feed/update/urn:li:groupPost:…`) is pulled back to the real feed before a feed-like — instead of repeatedly whiffing `no-likeable-post(...path=/feed/update/urn:li:groupPost:…)` on the stuck permalink. `isFeedUrl` stays permissive for `chooseActuatorTab` (never abandon a pinned tab).

---

## Lima self-host setup

Apply once before the first run:

**1. Apply the migration:**
```bash
# Inside the Lima VM
limactl shell default
psql -U postgres "$NOELLE_DATABASE_URL" -f /path/to/noelle/infra/cloudsql/schema/0054_linkedin_activity.sql
```

**2. Set env vars** in `~/.noelle/.env` (Lima VM, mode 0600):
```bash
NOELLE_ACTUATOR_TOKEN=<a long random secret you choose>
NOELLE_ACTUATOR_ORG_ID=<your org uuid, e.g. 3e9367d0-...>
```

**3. Restart api-vm** to pick up the new vars:
```bash
pm2 restart ecosystem.config.cjs --only noelle-api
```

**4. In the extension options,** set the API base URL to the Lima tunnel host and the bearer token to the value of `NOELLE_ACTUATOR_TOKEN`.

---

## DM approval

DMs are **fail-closed**: `GET /api/actionable-linkedin` only includes a DM in its response when that approval has been explicitly greenlit via:

```
POST /api/drafts/:id/approve-dm
Authorization: Bearer <token>
```

Without this call, `dms` is empty and zero DMs are sent. This is the default. A dashboard "Approve DM" button is a fast-follow UI improvement; until it ships, approve individual DMs via the API directly or curl:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/drafts/<draft-id>/approve-dm"
```

---

## Prod port to `api.trynoelle.com`

The extension and all three endpoints are built for both environments. The port is **config-only**:

1. **Base URL:** in the extension options, change to `https://api.trynoelle.com`.
2. **Auth:** swap the static bearer token for the Supabase JWT the dashboard already issues. The only code-bearing delta is in the extension's `src/lib/auth.ts` module (token acquisition); the request/response shapes, content script, scheduler, selectors, and data model are identical. On the server side, replace `requireActuatorToken` on the three actuator routes with `requireUserJwt` (the existing middleware used by all other dashboard-facing routes). No other server-side changes are needed.

The three endpoints live in `apps/api-vm` which already serves both Lima and `api.trynoelle.com` — there is no separate prod server to port to.

---

## Tuning levers

All levers are config (options page or env) — no code changes required:

| Lever | Where | Effect |
|---|---|---|
| Window length | Panel (hours) | Spreads actions wider — the primary volume-reduction lever |
| Target comments | Panel | Lower to reduce comment volume (comments are higher-risk than likes) |
| Target likes | Panel | Lower to reduce like volume |
| Daily caps | Options page | Hard backstop ceilings regardless of targets |
| Deep-night taper | Options page | Reduces density in the overnight window; disabling gives flat density across 24h |
| Overnight posting-curfew | `src/lib/curfew.ts` `CURFEW_START_HOUR`/`CURFEW_END_HOUR` (default 1→9 local) | The window "Full automatic" + every unattended auto-start hold comments/DMs in (scheduled gap-likes keep going). Manual Run/Drain ignore it. Handles both same-day (1→9) and midnight-wrapping (23→6) windows |
| Reply-coupled like skip | `src/lib/like-skip.ts` `LIKE_SKIP_BASE`/`_MIN`/`_MAX`/`_REROLL_EVERY` (2% base, [1%,5%] every 123) | Fraction of replies that DON'T also react to the post — breaks the 100% reply→like tell |
| Watchlist preference ratio | Options page | Higher = more likes go to watched connections before anyone else |
| Reaction mix | `reactionWeights` config, defaults in `src/lib/reactions.ts` | Per-reaction weights for varied reactions (default: Like 70 / Celebrate 10 / Support 10 / Love 4 / Insightful 4 / Funny 2). `0` disables a reaction; all-zero ⇒ always a plain Like |
| Ambient read-actions | Options page (`ambientReadActions`, default on) | Expand "…more" + open comments while idle-browsing. Read-only, non-counted. Off = scroll-only ambient |
| Ambient read cooldown | `src/background/index.ts` `AMBIENT_READ_MIN_GAP_MS` (default 20 s, ×1–2 jitter) | Minimum spacing between read-actions so they cluster like real reading |
| Read-action mix | `src/background/ambient.ts` `chooseAmbient` weights (expand-leaning) | Share of allowed idle ticks that expand "…more" / open comments / navigate (rest scroll) |
| Idle-liking cadence | `src/background/index.ts` `IDLE_LIKE_MIN_GAP_MS` (default 5 min, ×1–1.8 jitter) | Minimum spacing between likes slipped into the wait between actions — **Run/auto mode only; drain mode never idle-likes** (`shouldIdleLike` `inDrain` gate); bounded by the like budget + curfew |
| Replenishment poll interval | `src/background/replenish.ts` `POLL_INTERVAL_MS` | How often it checks for newly-approved comments (default ~7 min jittered) |
| Stepped-away pause | `src/lib/scheduler.ts` `EXTRA_PAUSE_PROB` (0.2) / `EXTRA_PAUSE_MAX_MS` (300 s, capped at 5% of window) | Chance and size of the occasional 0–5 min extra gap layered on top of the tempo gap |

**Honest note on volume:** targets like 80 comments / 120 likes in 8 hours are high (≈ 1 comment every 6 min, 1 like every 4 min). The burst-and-idle clustering and jitter make the *shape* human, but **sustained high volume is still the dominant ban risk.** When in doubt, lengthen the window and lower the targets. See `docs/x-account-safety.md` for the analogous X reasoning.

---

## Manual smoke (operator-run)

This checklist requires a live LinkedIn session and a running Lima api-vm. Run it yourself at low volume after the Lima setup above.

1. **Apply the migration and set env vars** (see Lima setup). Verify with:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
     "$BASE/api/actionable-linkedin?instanceId=$INSTANCE"
   ```
   Should return `{"comments":[...],"dms":[]}` (empty if Lyra has no pending approvals yet).

2. **Load the unpacked extension.** Fill in options: API base URL, token, instance ID. Leave caps at defaults.

3. **Open `linkedin.com`** (logged in). Open the floating panel.

4. **Set window=1h, comments=1, likes=2.** Press **Run**. Confirm Chrome shows the "Noelle Actuator is debugging this browser" banner (CDP attached).

5. **Watch the panel.** Confirm:
   - One like fires with visible mouse movement and a real click (human spacing).
   - One comment appears on the correct post (the comment text matches the approved body), the approval flips to `sent` (`sent_via='extension'`), and a `noelle.linkedin_activity` row exists (`SELECT * FROM noelle.linkedin_activity ORDER BY created_at DESC LIMIT 5;`).

6. **Supply test.** Set comments=5 with only 1 approved. Confirm it posts the 1 comment, then idles/defers — the panel log shows a `comment-awaiting-supply` skip event — and ambient browsing continues in the background. Approve a second draft from the Lyra inbox; confirm it fires on a subsequent tick (no burst, human-spaced).

7. **Ambient browsing.** During the idle gap between bursts, confirm slow scroll events fire (the feed advances without a click). With **Ambient read-actions** on (default), also confirm that over a few minutes the cursor occasionally moves to a truncated post's "…see more" and clicks it (the post expands, then dwells), and that it occasionally opens a post's comments and reads them — spaced out, not every tick. Optionally check that the extension occasionally navigates to notifications and returns.

8. **STOP mid-run.** Press STOP. Confirm it halts immediately and the "Noelle Actuator is debugging this browser" banner disappears (CDP detached). No further actions fire.
