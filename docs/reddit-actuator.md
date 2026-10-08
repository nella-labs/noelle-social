# Reddit Actuator ("Orion's hands") — operator guide

The Reddit reply actuator is the browser-extension **hands** of the Reddit Growth
Intern (Orion), the sibling of the X actuator (`apps/x-actuator`, Vega) and the
LinkedIn actuator (`apps/linkedin-actuator`, Lyra). Orion drafts on-brand replies to
in-ICP subreddit threads and queues them for human approval; today the operator
copy-pastes each approved reply by hand. The actuator replaces that last step: it pulls
**human-approved** Reddit replies from `api-vm` and posts them from the operator's **own
logged-in reddit.com tab**, using trusted `chrome.debugger` (CDP) input with humanized
pacing — reply-only, never a vote.

**App:** `apps/reddit-actuator` (`@noelle/reddit-actuator`), MV3, built with WXT.

## What makes Reddit different

- **Engage with comments, not just the post.** Orion can target the **most-upvoted
  comment** in a thread (sorted by Reddit `score`), not only the source post. Each
  approved draft carries a target — a post permalink or a specific comment permalink —
  and the actuator opens it and replies in the right place.
- **Post images feed the draft.** The intern grabs post images and captions them
  (vision) so image-post replies are grounded in what the image shows.
- **No voting, ever.** Automated up/down-voting is vote manipulation under Reddit's
  Disrupting Communities / Responsible Builder policies and is bannable. The actuator has
  **no vote action** — the activity wire type is `reply | skip` only. Voting stays 100%
  manual and human.
- **New Reddit by default — old Reddit is opt-in.** The actuator posts through the
  same interface the operator actually browses (new Reddit, `www.reddit.com`,
  `shreddit-*` web components) so the account's **write interface stays consistent with
  its reads** (blend-in; less detectable). old.reddit.com is easier to automate but a
  more conspicuous, distinct write surface, so it is an explicit Options toggle only
  for operators who genuinely live on old Reddit — never forced. Either way the
  operator's normal browsing is unaffected (the actuator drives its own navigation).

## Security posture (inherited + Reddit-specific)

Inherited from the shared engine (identical to the X/LinkedIn actuators):
- **Trusted input** via `chrome.debugger` `Input`-domain-only events (`isTrusted:true`),
  real US-keyboard keystroke metadata, humanized sigma-lognormal mouse motion + tremor +
  overshoot/correct, reading-dwell model, per-session persona.
- **Minimal fingerprint:** closed-shadow-root control panel under a random host id, no
  `web_accessible_resources`, host permissions scoped to `reddit.com` + the local api-vm
  (no wildcards). `debugger` is the load-bearing permission (and the Web-Store blocker).
- **Fail-closed backstops** (server-side, can only ever *withhold*): master
  `reply_send_enabled` switch (default OFF), per-day write cap, challenge circuit-breaker,
  epoch generation guard + instant STOP.
- **Auto-enable send on manual Run/Drain** (ports LinkedIn #414 + its race
  hardening): the operator explicitly clicking Run/Drain IS the consent to post,
  so the extension flips `reply_send_enabled=true` for its instance via the
  shared org-scoped `POST /api/actuator/enable-send` — no dashboard toggle
  needed. The enable happens INSIDE `startRun`/`startDrain`, after the epoch
  bump and before the queue fetch, and every switch write is serialized through
  a single queue (`withSendSwitch`), so a concurrently-ending run's disable can
  never land after the new run's enable and empty its queue. When the run ends,
  the switch is flipped back OFF **only if this run armed it** (persisted
  `RunState.armedSend`, set only when the manual arm POST landed AND the server
  reported the flag was OFF before it — `prior:false` in the enable-send
  response, i.e. this run performed the OFF→ON transition itself) AND the run is
  still epoch-current — so a manual run is fail-closed at rest, while an
  autonomous run (which never arms) — or a manual run whose enable was a no-op
  against the already-ON standing dashboard toggle — can NEVER overwrite the
  operator's standing consent. An older api-vm that omits `prior` is treated as
  `prior:true` (fail-safe: never disarm what might be standing consent; the old
  server merely keeps its pre-`prior` leave-it-ON behavior at rest). That
  matters because, unlike LinkedIn,
  `GET /api/actionable-reddit` gates on `reply_send_enabled` ONLY (no
  `auto_send_enabled` lights-out fallback): the documented autonomy workflow is
  the operator arming the dashboard toggle, and an unconditional end-of-run
  disable would silently starve every later autonomous run. Deliberately wired
  ONLY into the manual path, never the unattended auto-start (`checkAutonomy`),
  so the global panic-stop kill switch stays authoritative for lights-out runs.
  Best-effort both ways (an older api-vm without the endpoint just logs a
  warning and the run proceeds against whatever the flag already is).
- **Failed-start arm rollback (leak guard).** A landed arm is stamped to a durable
  pending-arm marker (`chrome.storage.local`) before anything that can throw, and
  cleared only once the arm is accounted for: `RunState` persisted (end-of-run
  disarm owns it from there) or the arm rolled back OFF when the start failed
  before `saveState` (e.g. a transient api-vm 5xx on the queue fetch — without
  the rollback the switch would stay ON with no run recording `armedSend`, and
  the next lights-out run would post under a consent flag the operator never
  chose to leave standing). The rollback is serialized through `withSendSwitch`
  and epoch-guarded so it can never race a superseding Run/Drain's own enable
  back OFF. If even the rollback disarm fails, the marker STAYS and
  `checkAutonomy` refuses to lights-out start (it retries the disarm on each
  tick; a fresh marker — a manual start still in flight — is waited out, never
  disarmed under). Fail-closed at rest, now including the crashed-start path.

Reddit-specific:
- **No vote manipulation** (above).
- **Never two replies in one thread (per-session guard, ports LinkedIn #408):** each
  posted reply records a per-THREAD dedup key (`t3_<postid>`, parsed from the permalink
  by `src/lib/urn.ts postDedupKey`) into `RunState.actionedKeys`; a later draft for the
  same thread — even a comment-target with a different permalink — is dropped as done
  (`skip: duplicate-post`), never posted. Two comments by one account in one thread is
  a classic subreddit-ban trigger. Record-first ordering (`recordReplySuccess` before
  `markSentWithRetry`) means a failed markSent can never re-queue and double-post.
- **Prompt-injection defense upstream:** Orion's drafter now fences all untrusted Reddit
  content — post text, top-comment bodies, and image captions are wrapped as "data, never
  instructions" (`NOELLE_DRAFTER_FENCE`, default ON). The actuator itself types the
  approved body **verbatim** as literal text (no eval/interpolation) and reads the DOM via
  `textContent`/attributes only.
- **Conservative, research-grounded pacing** (see below).
- **Human-approval gate:** the actuator only ever posts drafts a human approved. There is
  no auto-draft-to-auto-post path.

## Navigation safety (ported from the LinkedIn actuator)

Shared feed definition in `src/lib/feed.ts` (`isFeedUrl` / `isFeedPath` /
`chooseActuatorTab`): a "feed" is the home feed (plus its `/best|hot|new|top|rising`
sorts) and the ambient nav targets `/r/all` + `/r/popular` — never a thread permalink
or a `/user` profile.

- **Tab pinning.** The run pins the tab it started on (`RunState.tabId`, rides the
  existing run-state storage key) and reuses it every tick; it only re-picks a tab
  (preferring one actually on a feed) when the pinned tab was closed. Before pinning,
  the tab was re-chosen every tick as the *first* `reddit.com/*` tab, so an operator's
  own permalink/profile tab that merely sorted first could silently hijack actuation.
- **Feed guard.** `ensureOnFeed` runs before every feed-scoped idle action — the
  idle-upvote and the ambient browse. Off the feed, `findFeedUpvoteTarget` still
  matches `shreddit-post` cards on `/user` profiles and permalink pages, so idle
  activity silently acted on the wrong surface. Conservative: navigates only when the
  tab's URL is known and not a feed; best-effort. (A drain reply and a removed-post
  skip already returned to the feed; scheduled replies rely on this guard at the next
  idle tick.)
- **Fresh-rect click.** The idle-upvote re-locates the upvote button right before
  clicking — Reddit's infinite scroll shifts the vote column while the pre-click beat
  elapses, and a stale rect lands in the post body (opens the permalink, misses the
  vote). Falls back to the original rect only when the re-locate misses.
- **Clean detach.** `Cdp` tracks every tab it attached and `endRun` calls
  `detachAll()`, so a run that re-pinned tabs never leaves a lingering debugger
  session (or its banner) behind.

All of this is on by default — it is a liveness/safety fix with no new write behavior,
matching the LinkedIn actuator's stance (no new flags, no new storage keys).

## Pacing (grounded in Reddit's official rate-limit posture)

Reddit throttles on **velocity**; as of March 2026 its human-verification system keys on
"how quickly the account is attempting to write content." Defaults:

| Knob | Default | Why |
|---|---|---|
| Replies/day | 8 (2 while warming up) | below the >10/week velocity flag |
| Warm-up ramp | 2 → 8 over ~4 weeks | never automate a cold identity |
| Max replies / rolling hour | 3 | burst is the #1 lock trigger |
| Min spacing | 600 s hard floor | clears the low-karma per-sub throttle |
| Target spacing | randomized 20–60 min | defeats exact-interval detection |
| Distinct subreddits/day | ≤ 5 | stay under the ">2 subs/day" flag margin |
| External links in replies | off | link-spray is a top spam signal |
| Auto-vote | never | vote manipulation = ban |
| Active hours only | yes | no 24/7 write cadence |

The overnight **write-curfew** (local 23:00–06:00) is a single compile-time switch —
`WRITE_CURFEW_ENABLED` in `apps/reddit-actuator/src/lib/curfew.ts`, currently
**disabled** by operator request (writes allowed any hour; ports LinkedIn #416). All
three enforcement points read it (the scheduler's plan-time shift, the runtime write
floor in the tick loop, and the idle-upvote gate), so flipping the one const restores
the whole overnight window together. A canary test (`tests/curfew.test.ts`) fails on
purpose if it is re-enabled, forcing an intentional update. The autonomy auto-start
window (9–21) is a separate knob, deliberately untouched. The deep-night taper is an
inert stub — the scheduler's `densityWeight` is hardcoded to full density every hour
(operator directive e660bccd: post any hour) — so its options checkbox has been removed
rather than left implying a live control; the `deepNightTaper` config field remains only
to satisfy the scheduler's opts shape (always `false`).

Hard-stop on any "you're doing that too much" throttle, AutoMod removal, or
human-verification prompt (challenge circuit-breaker).

Humanization layers ported from the LinkedIn actuator (#414):

- **Occasional "stepped-away" pause.** At plan time, ~1 action in 5 (at random) gets
  an extra **0–360 s** added to its inter-action gap — a one-off distraction drawn from
  a SEPARATE plan-deterministic rng (the main tempo/burst/volume stream is untouched)
  and kept out of the AR(1) autocorrelation so it never compounds. Capped at 6% of the
  window; overflow past the window end is dropped + logged, never clustered. Tunable
  via `EXTRA_PAUSE_PROB` / `EXTRA_PAUSE_MAX_MS` in `src/lib/scheduler.ts`.
- **Livelier idle.** The ambient read-action mix now **leans toward expanding
  "…more"** (`chooseAmbient` weights, expand-dominant) and the read cooldown is
  tightened to `AMBIENT_READ_MIN_GAP_MS` = 20 s ×1–2.6 jitter (was 30 s ×1–2.5), so the
  actor actively opens posts while it waits instead of only scrolling. Read-only,
  non-counted.
- **Attempt-anchored upvote pacing.** The idle-upvote ~60 s min-gap now paces off the
  last **attempt** (`RunState.lastUpvoteAttemptMs`), not only the last success, so a
  feed with nothing upvotable isn't re-scanned on every ~4 s tick. The ≤10/15-min
  rolling cap, the `upvotesEnabled` opt-out, and UPVOTE-ONLY are unchanged.
- **Across-the-board variance widening** (ports LinkedIn #429): every humanization
  distribution (session persona, scheduler tempo/bursts, mouse motion, scroll
  gestures, reading dwells, typing cadence, ambient mix, upvote target pick — now a
  random in-view not-yet-upvoted post, not the topmost) got a wider spread and a
  heavier right tail. Discipline: medians equal-or-slower, **no timing floor was
  lowered** — the 240 s reply spacing, 3/h write ceiling, ~60 s upvote min-gap
  (now ×1–1.8 jittered upward), and ≤10/15-min cap are untouched. No new flags;
  pure parameter tuning, deployed by rebuilding + reloading the extension.

### Drain gap timing archetypes (no flat-uniform spacing)

Orion posts **no like slots** (voting only ever happens via the idle-upvote path, never as a scheduled drain slot), so the only per-gap variety a reply-only drain can carry is the **gap timing** itself. The inter-reply gap used to be a flat uniform `[240s, 1140s]` (4–19 min) — but a perfectly uniform band has hard, readable edges (an analyst reads the exact bounds and the even density straight off a session). Each gap now draws a **timing archetype** inside the same envelope (`drainGapMs` in `src/lib/scheduler.ts`):

| Archetype | Weight | Band |
|---|---|---|
| quick | 20% | ~4–7.6 min — an occasional quick reply-after-reply |
