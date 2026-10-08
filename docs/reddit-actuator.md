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
| normal | 38% | ~7.6–13.3 min — the mode |
| cooldown | 42% | ~13.3–19 min — a long "stepped away" pause (reply → cooldown → reply) |

The weights are **upper-tail-heavy** (cooldown > quick) on purpose: that breaks the uniform-band fingerprint while keeping the **mean gap equal-or-slower** than the old flat uniform (~11.9 min vs 11.5 min), so reply velocity never rises. That direction is mandatory because drain mode bypasses **both** the runtime `replySpacingOk` floor and `maxWritesPerHour` — the planned gap is the SOLE spacing backstop, so a quick-heavy mixture (mass shifted toward the floor) would be a real velocity regression even with every single gap ≥ 240 s. Every band stays strictly inside `[240s, 1140s]`, so the **240 s floor** and the 19-min ceiling are untouched; this only reshapes the middle. Still reply-only: `.filter(kind === "comment")` at both plan sites, zero vote slots, ever.

### Lights-out auto-drain (ports the Lyra queue-drain fixes, #446)

With **Options → auto-drain** ticked (requires *Autonomous* on; **default OFF**),
the 5-minute autonomy alarm also starts a **drain** whenever the server serves
approved replies and nothing is running, so an approval made mid-afternoon goes
out mid-afternoon instead of waiting for tomorrow's run or a manual "Drain all
approvals" click. Semantics (identical to the LinkedIn actuator):

- **Consent is server-side and standing.** The unattended path never arms
  `reply_send_enabled` (the panic-stop invariant). Instead the
  `GET /api/actionable-reddit` gate honors `agent_instances.auto_send_enabled` as
  durable lights-out consent (`reply_send_enabled OR auto_send_enabled`); set it
  once from the dashboard/DB for Orion's instance. **Pause-all clears both
  flags** (the `reddit_intern` role is in its scope), so a panic still starves
  auto-drain org-wide. Ships **inert**: it needs BOTH the Options checkbox and
  the dashboard flag.
- Same **safety gate** as the daily auto-start (server `/api/actuator/reddit-health`
  ok + post-challenge cooldown), same operating window (start/end hours), and
  every server-side withhold gate (challenge circuit-breaker, daily write cap,
  external-link guard) applies unchanged: an empty served queue simply means no
  drain starts. Drains stay reply-only with the 4–19 min gaps.
- **Not once-per-day**, but re-arm-limited: at most one auto-drain start per
  30 min (`AUTO_DRAIN_REARM_MIN`), so a drain that keeps dying with items still
  queued (no reddit tab, reply-fail give-ups) can't be relaunched forever.
- A manual **STOP silences auto-drain for the rest of the day**
  (`actuator.lastManualStopDay`), exactly like it already silences the daily
  auto-start.
- **Strongly recommended before enabling:** turn on
  `NOELLE_REDDIT_ACTUATOR_HALT_ON_CHALLENGE=1` (default OFF) — nobody is watching
  when an unattended drain hits a "you're doing that too much" throttle, and the
  circuit-breaker is what stops the queue from feeding it.

### Stalled-run recovery (ports the LinkedIn actuator)

`maybeAutoDrain` can't recover a run that is `"running"` but wedged (its
`runActive` gate skips). So the autonomy alarm also runs
`maybeRecoverStalledRun`: a provably stalled run — drafts loaded, reply slots
overdue, no post for `STALL_RECOVER_MIN` (20 min) past warm-up — is superseded by
a fresh drain, behind the same safety gates and **sharing the 30-min re-arm
stamp**. It never arms sending, so the server queue gate (`reply_send_enabled` +
the pending-arm inheritance) still governs supply — a wrong trigger just
supersedes and starves — and per-thread dedup (`actionedKeys`) blocks any
double-reply. Progress is stamped in `recordReplySuccess` (`lastProgressMs`). See
`docs/linkedin-actuator.md` § *Stalled-run recovery* for the full invariant list.

### Drain auto-continue (ports the Lyra queue-drain fixes, #439)

A **Drain** plans a fixed batch (the queue size at start), so it used to stop
after that batch even when the inbox still held approvals (capped at start,
arrived mid-run, or re-queued after a transient failure). Now, when every planned
slot is done, the drain re-fetches the queue and — if pending replies remain —
**appends a fresh reply-only batch** and extends the window, so one Drain clears
the whole inbox. **Persistent (never re-click):** an empty served queue no longer
ends the drain — the run stays alive and re-checks the queue every ~75 s
(`DRAIN_WATCH_POLL_MS`, `drainShouldKeepWaiting`), rolling its window forward, so
a reply approved later goes out with no re-click. Only **STOP**, a **challenge
halt**, or the runaway ceiling `MAX_DRAIN_ROUNDS` (raised 50 → **1000**, counting
actual send-batches only) end it; forever-failing drafts still hit the per-draft
retry cap below. Extension rounds are fed `likesPerGap*=0` and filtered to comment
slots, so they can never introduce a vote slot.

### Failure hygiene (ports the Lyra queue-drain fixes, #437)

- **Per-draft retry cap.** A failed reply is re-queued at the **back** of the pool
  (healthy drafts go first) and dropped for the session after `MAX_ACTION_TRIES`
  (3) failures — one thread the composer/submit can't handle (or a live throttle)
  can no longer be retried on every slot and starve every other pending draft. The
  retry count survives replenish merges. "Removed" targets are exempt: they are
  terminal on the first sighting, never retried.
- **Durable dead-post skip.** A removed/deleted/unavailable target is dropped
  locally **and** marked `skipped` server-side via the generic
  `POST /api/actuator/mark-skipped/:id` (reason `post-removed`, best-effort), so
  the queue stops re-serving the dead permalink on every future run. The route
  only ever flips a still-`pending` approval, so it can never clobber a sent row.
- **Per-stage skip diagnostics.** Failed replies log `reply-failed:<stage>` (or
  `reply-failed:gave-up-after-N:<stage>`) plus the thread's `post_id`, with stages
  `challenge` / `reply-button-not-found` / `comment-mismatch` /
  `composer-entry-not-found` / `box-not-found` / `submit-not-found` /
  `not-cleared` / `post-submit-challenge`. Signature reading: a wall of
  `not-cleared` = a live "you're doing that too much" throttle;
  `box-not-found` = composer/flavor drift; `submit-not-found` = submit locator
  drift.

**Idle-upvotes land on a feed, never the just-replied thread (ports LinkedIn #410):**
before an idle-upvote fires, the background checks the tab URL — a `/comments/`
permalink (where a scheduled-mode reply parks the tab) is navigated back to the feed
(old.reddit.com when `preferOldReddit`) first, so an upvote can never pair with the
reply the account just posted (a vote-manipulation fingerprint). Best-effort: a failed
nav degrades to ambient browsing. When nothing is upvotable, the skip reason is
self-diagnosing — `no-upvotable-post(posts=,withBtn=,btns=,path=,flavor=)` — so a
`reddit_activity` skip row separates "not on a feed" (`path=/…/comments/…`) from "all
already upvoted" (`withBtn>0`) from container DOM drift (`btns>0, posts=0`) without a
live DevTools session.

## Send reliability (ported from the LinkedIn actuator: #406, #407, #442, #444)

- **Challenge detection is structural first.** `detectChallenge` halts on evidence that
  cannot occur organically — an hCaptcha / Google reCAPTCHA **vendor iframe** (exact
  hostnames only, never a bare `src*='captcha'`) or a **verification/block interstitial
  route** (path-anchored, so a post slug containing "blocked" can't trip it) — checked
  before the alert-scoped text probes, so a wall whose prose the regexes miss still
  halts. A vendor iframe inside the transient `reputation-recaptcha` gate stays a soft
  js-challenge (waited out, never a halt).
- **The reply-submit locator is anchored + word-gated.** The old document-wide
  `button[slot='submit-button']` fallback (first match wins, whatever composer it
  belongs to) is gone. Search order: (1) the target comment's own composer subtree
  (scoped by `thingid`); (2) a composer-anchored climb from the located reply box —
  candidates must **follow the box in document order** and match an exact submit word
  (`comment|reply|post|save`; slot/type=submit is a tiebreaker, never a qualifier);
  (3) a global two-pass with the same word gate + decoy exclusions. Thread-level
  "Reply" openers (inside `shreddit-comment-action-row`, or count-only visible text)
  are rejected everywhere; a **disabled** real submit is returned as-is so the locator
  reports `reply-submit-disabled` and the background waits — it never widens to a decoy.
- **Chat-drawer exclusion.** The www.reddit.com chat drawer (`rs-*` elements, plus an
  aria `message|chat` backstop) is excluded from both the reply-box search and every
  submit pass — typing/submitting there would send a private chat message from the
  operator's real account, and the cleared-composer check would read it as success.
- **Zero-rect guard.** A resolved submit with no layout box is skipped
  (`submit-zero-rect`) instead of synthesizing a trusted click at the viewport corner.
- **Typing commits via `Input.insertText`.** Each mappable character is sent as a
  text-less `rawKeyDown` (keystroke telemetry with real key/code/keyCode, Shift-hold
  preserved) → `Input.insertText` (the `beforeinput`/`input` edit the framework
  composer's model actually syncs from, so the submit **enables**) → `keyUp`. A
  keyDown-with-text native edit could land in the DOM while the editor model stayed
  empty — the submit then never enables (the LinkedIn live symptom).
- **The submit locate is a poll, not a single shot.** After typing, the background polls
  `locateReplySubmit` for ~6–12 s (jittered ~500 ms steps), riding out enable/layout lag;
  only a persistent miss fails the attempt. The post-click cleared-confirm poll is ~3.2 s
  plus one late-post re-check, so a reply that lands late is never re-typed (duplicate).
- **Diagnosable failures.** A failed reply logs `reply-failed:<detail>` in
  `reddit_activity` — `not-cleared(via=<pass>,btn=<label>,type=<hook>)` names the exact
  button that was clicked; `submit-not-found(b=<build>,box=…,empty=…,last=<skipReason>,
  wf=…,en=…,vis=…,slots=…,scoped=…,top=…,path=…)` buckets why no clickable submit
  appeared (`diagnoseReplySubmit` re-walks the locator predicates on the failure path
  only: `wf=0` = no eligible worded submit, `en=0` = never enabled, `en>0,vis=0` =
  enabled but zero-rect). The `b=` build stamp (`BUILD` in `src/background/detail.ts`,
  bump on every submit/typing change) self-identifies which unpacked build produced a
  row — DevTools is blocked mid-run, so this row is the only debugging window.
  Page-derived values are sanitized to `[A-Za-z0-9 _-]` and length-capped; server health
  queries match `challenge`/`throttle` exactly and are unaffected.

## Dead-target skips (removed / locked / archived)

A reply target can be permanently un-replyable in two ways, both detected read-only
before the composer is ever opened:

- **Post gone** — removed by filters/mods, deleted, 404, private/banned community
  (`checkPostRemoved` / `isPostUnavailable`).
- **Comments unavailable** — the thread is **locked** or the post is **archived**
  ("New comments cannot be posted"): the post renders fine but no composer will ever
  appear (`checkCommentsLocked` / `isCommentsUnavailable`). Structural signals win
  (the `shreddit-post` `locked`/`archived` attributes, old Reddit's
  `.thing.link.locked`/`.archived` classes); the phrase fallback reads only
  alert/banner/infobar chrome — never a post body or the comment tree — so a post
  merely quoting "comments are locked" can't false-trip. Probed right after the
  removed-post gate and re-probed when the reply box never appears (the banner can
  render late).

Both are **terminal skips**, not retries: the draft is dropped for the session, the
skip is logged with a cause-specific reason (`post-removed` | `post-unavailable` |
`comments-locked` | `post-archived`), and the tab returns to the feed. The
**server-side** half (generic `POST /api/actuator/mark-skipped/:id`, best-effort,
irreversibly flips the pending approval to `skipped` so the queue stops re-serving
the dead permalink) is **gated on positive evidence**: a removed/deleted indicator
attribute, old Reddit's `.thing.link.deleted`, a matched removal phrase, or a
locked/archived signal (`classifyRemovedProbe` in `background/marksent.ts`). A
merely-absent post shell (`post-absent` → skip reason `post-unavailable`) also
occurs on transient 5xx / "something went wrong" interstitials, CDN error pages,
and old-Reddit age gates where the content script runs fine — that stays a
**session-local** drop that self-heals on the next run, never a server-side skip.
Previously a locked or archived thread died in the `reply-box-not-found` retry loop
and, with no server-side skip, was re-served every session forever. This only ever
*withholds* a write — a false positive drops one approved reply with a logged
reason; it can never post.

## Server side

`apps/api-vm/src/routes/actuator.ts` (mirrors the X handlers):
- `GET /api/actionable-reddit?instanceId=…` — approved `platform='reddit'`, `kind='reply'`
  drafts as `{ replies: [{ approval_id, draft_id, lead_id, kind, body, target }] }`, where
  `target` is a post `{type:'post', url, post_id, subreddit, author}` or a comment
  `{type:'comment', url, post_id, comment_id, subreddit, author}`. Gated by
  `reply_send_enabled` **or** `auto_send_enabled` (the standing lights-out consent,
  see auto-drain above), the daily write cap, the challenge breaker, and the
  external-link guard.
- **Persistent dedup-by-thread (always on, ports LinkedIn #420):** the queue never
  serves a reply for a thread already replied to — any session, any lead, any prior
  markSent outcome. Keyed on the bare t3 post id (a comment-target keys on its parent
  post, so the grain is the thread), unioned from `'sent'` reply approvals via
  `leads.external_id` (authoritative history) and `reddit_activity` reply rows the
  extension stamps with `post_id` at post time (survives a failed markSent). Fails
  CLOSED — a dedup query error serves an empty queue (still 200). Index: migration
  `0086_reddit_reply_dedup.sql`.
- `POST /api/reddit-activity` — append-only `noelle.reddit_activity` log.
- `GET /api/actuator/reddit-health` — today's volume + challenge signal.
