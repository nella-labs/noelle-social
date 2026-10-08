# X account safety — reducing ban / lock / shadowban risk

> Research synthesis (2024–2026 sources) + a prioritized hardening plan for the
> Noelle X-intern, which posts replies via captured browser cookies
> (`ct0` + `auth_token`) from a residential-IP VM. **Read this before touching
> the posting path or raising send volume.**

## TL;DR — the posture that actually matters

1. **The human-approval gate is the single most defensible thing we have.** In
   Oct 2025 X purged 1.7M accounts specifically for *reply spam*, and 2025–2026
   enforcement is **behavioral "human-only-interaction" detection** (did a human
   actually tap?), not just numeric quotas. Unattended keyword→auto-reply via
   cookies is a ToS violation *by mechanism*, so **no amount of throttling makes
   fully-unattended auto-send "safe."** Bias toward human-confirmed sends; treat
   `auto_send_enabled` as the highest-severity setting.
2. **Velocity, not daily total, is the #1 lock trigger.** ~20+ write actions in
   2–3 min (or a burst in one 30-min window) trips Error 226 "looks automated"
   even far under daily caps. Pace by *rolling window*, not just per-hour.
3. **Isolate the account.** Heavy authenticated *reads* from the *posting*
   cookies expose the posting identity to X's anti-scraping surface and burn its
   shared ~1,000/day read budget. **Done (§5):** discovery + profiler reads now
   run through Apify (`kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest`, no X login), so the posting
   cookies are write-only.
4. **A lock is the real danger, not a 429.** A 429 self-clears in 15 min. A
   *lock/challenge* (CAPTCHA, phone verify, "temporarily limited") cannot be
   satisfied by a headless cookie bot and **retrying on a locked account is the
   documented fastest path to permanent suspension.** We must detect it and
   hard-stop + alert.

## 1. Rate limits & enforcement states (current, 2026)

Two limit systems, both bind:

- **Per-15-min GraphQL buckets** (what the cookie session consumes): SearchTimeline ~50/15min, UserTweets ~50/15min, UserByScreenName ~95/15min, HomeTimeline ~500/15min, follow ~15/15min. `CreateTweet`/`FavoriteTweet` have **no** hard per-15-min cap → governed by account-level + behavioral limits. Over → HTTP 429, self-clears next window (harmless).
- **Account-level daily caps** (free/unverified, since ~May 2026): **50 original posts + 200 replies/day**, sub-sliced into semi-hourly buckets (bursting locks you before the flat ceiling). Likes ~1,000/day (behavioral, no published number). Follows 400/day. **Reads ~1,000 posts/day** (500 for new accounts) — a *shared* budget discovery+profiler+send all draw from.

**Three enforcement states:** (a) **429 rate-limit** — back off, non-event. (b) **Lock / "temporarily limited"** — hard stop until a human passes a challenge; 12–48h, escalates to suspension if unmet (~10–20 days). (c) **Suspension** — at-scale automation can jump *straight* here. Detect (b)/(c) and STOP; never retry into them.

## 2. How X detects cookie-driven automation

Four stacked layers; a naive bot fails at each:
- **Headers/protocol:** real web calls carry a per-request `x-client-transaction-id` (derived from page-only JS/SVG/meta), the public web bearer, `x-csrf-token == ct0`, `x-twitter-active-user`/`-client-language`. Missing/invalid transaction-id is a strong bot signal. (Mitigation: `@steipete/bird` fetches the live hashes; keep it current.)
- **Network:** datacenter IP / VPN / IP that mismatches where the cookie was minted → suspicious-login lock + Arkose. Residential, stable, geo-aligned egress is required. **ct0 must stay byte-synced to the live cookie** or you get 403-CSRF storms.
- **Behavioral:** uniform cadence, no dwell time, 24/7 flat-line activity, machine-even intervals → "not a human." Velocity bursts → Error 226.
- **Content:** templated/near-duplicate replies, generic low-value replies, links, replying to strangers who don't follow you, @-mention density.

## 3. Content & engagement signals to avoid

Reply-spam enforcement intensified hard (≈800M accounts removed 2024; 1.7M reply-spam purge Oct 2025). Avoid: near-duplicate/templated replies (copypasta deboost), generic "great point!"/AI-tells, links in replies (default zero), reply-bombing many strangers fast, unsolicited replies to non-followers at volume. Our existing voice rules (no echoing the post, no choppy "fragment. fragment.", first-person) help — but should become an **enforced near-duplicate gate**, not just guidance.

## 4. Safe volumes + warm-up ramp (CEILINGS — operate well under)

Noelle posts **replies** (and likes, added recently). Binding constraints = reply *velocity* + silent reply-deboost.

**Steady-state (aged account, 4+ weeks warmed):**
- Replies/day: **30–50 ceiling, operate at 20–40.**
- Replies per rolling 30 min: **≤6–8** (new `send_max_per_30min` knob).
- Replies/hour: single digits, ≤10–12, never machine-even.
- Inter-send: randomized 60–600s + occasional 5–20 min pauses; **cross-tick floor** so bursts can't slip through after downtime. **Implemented** behind `NOELLE_AUTOSEND_INTERSEND_FLOOR` (default OFF): when on, the send worker posts **at most ONE reply per tick** and refuses to send again until a jittered gap (`AUTOSEND_INTERSEND_MIN_MS`/`AUTOSEND_INTERSEND_MAX_MS`, default 60s/120s) has elapsed since the last successful post — so a post-downtime backlog drains one-at-a-time. Off ⇒ today's `Math.min(remaining,2)` claim, unpaced retry drain.
- **Active hours only** (e.g. 08:00–23:00 local), weekday-weighted, ±30% daily jitter. No 01:00–07:00 activity.
- Likes: research flags as higher-risk (behavioral, no cap, machine-cadence is a fingerprint). We added `likeTweet` by request — keep conservative + jittered, or gate it off. For the same reason the x-actuator's reply-also-likes (like the tweet you just replied to, ported from the LinkedIn actuator where it is always-on) is opt-in via the extension option `replyAlsoLikes`, DEFAULT OFF.
- Never reply twice to one tweet: `/api/actionable-x` excludes any tweet already replied to (always-on dedup keyed on the tweet id — 'sent' approvals unioned with `x_activity` reply rows stamped `tweet_id` at post time; fail-closed to an empty queue on query error), and the extension adds an in-session per-tweet guard + records a send locally BEFORE the retried markSent so a transient API failure can never re-serve (and re-post) a reply. A reply whose submit gesture (click or ⌘/Ctrl+Enter chord) was dispatched but never confirmed cleared is treated as AMBIGUOUS — dropped for the session and its tweet stamped into the per-tweet guard, never retried — because the post may have landed slower than the observation window and a retry would double-post; pre-dispatch failures retry at the back of the queue, capped at 3 per draft.

**Warm-up ramp (any new OR newly re-cookied account — a fresh cookie resets trust even on an aged account):** Week 1 = reads-only + 0–2 human-confirmed replies/day; Week 2 = 3–5 auto/day, ≤3–4 per 30min, active hours; Week 3 = ~8–10/day if clean; Week 4+ = +10–20%/week toward steady-state, each step gated on a clean logged-out shadowban probe + zero 429/lock events.

**Backoff:** on 429 → escalating cooldown (honor `x-rate-limit-reset`), never retry-loop. On any lock/challenge/Error-226/CAPTCHA/persistent-403 → **full STOP + Pushover alert**; resume only after a human clears it and a fresh probe passes. Don't taper, don't mass-delete history.

## 5. Read/write identity separation (operator ask #2) — ✅ IMPLEMENTED

**Done (2026-06-21).** Discovery + profiler reads now go through **Apify** instead of the posting cookies. (The actor was `apidojo/twitter-scraper-lite` at the time; it was swapped for `kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest` on 2026-06-23 after apidojo started serving `{demo:true}` placeholders to free-plan tokens — see `packages/x-apify/src/index.ts`. The read/write split below is unchanged by that swap.) Apify runs the scrape on its own proxies with **no X login**, so the posting account leaves X's anti-scraping surface entirely: there are no authenticated reads on it, its shared ~1,000/day read budget is freed, and a read can no longer lock the posting identity. The posting cookies (`ct0` + `auth_token`) are now used **only for `createTweet` + `FavoriteTweet`** in `send.ts` / api-vm `/send` — the scraper is read-only and cannot post, which is the read/write split by construction.

How it's wired:
- `packages/x-apify` — `createApifyXClient()` exposes `userTweets()` (watchlist-handle timelines) + `searchTimeline()` (keyword lane), returning the same `XTweet` shape discovery already consumed (the actor returns `author.followers` directly, so the old `_raw` GraphQL follower extraction is gone). Read-only by design.
- `apps/x-intern/src/lib/apify-resolver.ts` + `apify-rotating.ts` + `connections-db.ts` — per-org token resolver over the **shared `noelle.connections` 'apify' pool** (same tokens Lyra/Orion rotate): a single rotating client tries tokens in order and rotates on a token-fatal error, with the same hardening Lyra/Orion use — **a 401 is health-checked before retiring** (`checkApifyToken`; only a probe that *also* 401s marks the token invalid, so a transient throttle 401 doesn't permanently kill a good token), a **403 benches the token until its real billing-cycle reset** (probed `monthlyUsageCycle.endAt`, not a flat +30d), and **invalid tokens are excluded from the read entirely** (`listApifyTokens` filters `invalid_at is null`) so X never re-hits a banned account. Self-heals on billing reset; falls back to the `apify-token` SM secret / `NOELLE_SECRET_APIFY_TOKEN` env when no DB token is set. All tokens spent → `AllApifyTokensExhaustedError` (worker error, not a crash-loop). X reads use **one** rotating client (not the parallel pool fan-out Lyra/Orion use) and egress from `noelle-vm-0`, so there's no concurrent-burst cohort-ban surface to cap.
- **Discovery Apify time bounds (free-tier hang guard).** The pool is FREE-tier Apify accounts (~$5/mo each); a free actor run that will succeed does so inside its first ~60s `waitForFinish`, but an over-quota/queued free run stays non-terminal — so waiting the x-apify default 120s per run is wasted, and a discovery tick that loops over many handles+keywords with one such run each burned **10+ minutes**, leaving the worker looking hung (observed 2026-07-22, blocked on an Apify socket at 0% CPU, ignoring SIGTERM). Two bounds fix it: **`X_DISCOVERY_APIFY_TIMEOUT_MS`** (default `90000`) tightens each run's give-up (threaded through the resolver to `createApifyXClient({ timeoutMs })`), and **`X_DISCOVERY_TICK_BUDGET_MS`** (default `120000`) caps the whole tick — once spent, `runDiscoveryTick` stops issuing NEW runs and defers the remaining handles/keywords to the next tick (logged, never a silent cap). Worst-case tick ≈ budget + one in-flight run instead of N × timeout. Deferred sources are retried next tick **starting from where the previous tick ran out**: the tick iterates a rotating source ring (handles + keywords) with a cursor held across ticks — keyed per (instance, mode) since full-mode and watchlist-only ticks iterate different rings — and the cursor stops at the first source the tick could not poll (budget-deferred OR rate-bucket-starved), so either kind of truncation walks the whole ring over consecutive ticks. (The budget originally restarted at the head of the fixed list every tick, so the first ~6 handles ate every tick's budget and the tail + the entire keyword lane never ran — observed 2026-07-22, 48 of 54 handles deferred on 100% of live ticks for 13h, 3 leads from ≥13k billed items.)
- **Handle-lane server-side filters (cost guard).** The actor bills **per returned item**, and `userTweets` rides the `from:` *search* operator — so the same advanced-search operators the keyword lane already uses work on handle polls too. Discovery now appends `-filter:replies` (when `excludeReplies` is on), `-filter:nativeretweets` (always — reposts never become leads), and `since_time:<window>` (only when `timeWindowHours` is set — the contract default is `null`, so an org without a window still bills up to `postsPerSource` items per re-poll; the live config sets 24h) to the `from:` query, so replies/retweets/out-of-window tweets are never fetched instead of being billed and then dropped client-side (`skippedReply`, out-of-window drops in `normalizeAll`). With a window set, a re-poll with nothing new returns ~0 items ≈ ~$0 (zero-result runs aren't metered). Client-side filters stay as the exact backstop.
- `discovery.ts` + `profiler.ts` resolve the Apify client per tick instead of X cookies; `send.ts` + api-vm `/send` keep posting cookies unchanged.
- Cost is metered as `engine='apify', model='apify/twitter-scraper-lite'` spend rows (estimate; event-based billing) per `packages/runtime/src/apifyPrices.ts`.
- **Watch-lane re-poll cooldown** (`X_WATCHLIST_REPOLL_HOURS`, default `2` hours; `0` disables the gate. Ported from Lyra's `LINKEDIN_WATCHLIST_REPOLL_HOURS`, #441): when > 0, each watchlist person's handle is polled at most once per window instead of every 5-min tick (~288×/day) — most of those polls return nothing (the `sinceISO` window) but still bill Apify and burn rate-bucket tokens the keyword lane needs. Targeting handles + the keyword lane are never gated, and a handle that is both a targeting handle and a watchlist person stays ungated while the keyword lane is on. State is in-memory (`@noelle/runtime/repoll-cooldown`, shared with Lyra and Orion); a restart costs one extra full sweep. The window is deliberately tighter than Lyra's 4h because the watchlist feeds PRIORITY leads with a fast reply loop.

> The original recommendation considered twitterapi.io / ScrapeCreators (~$0.15/1k). We went with Apify because the account already runs the Lyra + Orion Apify pool — one shared, rotating credential pool instead of a new vendor + key.

Why not the alternatives:
- **A burner read-account on the same VM/IP is WORSE than no split** — X co-suspends identities linked by IP/device/email/phone, so one ban becomes two. Hard isolation (separate VM + residential IP + no shared email/phone) is heavy for a solo operator.
- **Guest/unauth reads + Nitter** aren't viable as the primary plane (guest tokens are IP-bound ~300/hr, datacenter-banned, rotate; Nitter needs logged-in accounts) and can't reliably return the follower/engagement signals the classifier grading needs. OK only as a zero-cost best-effort fallback.
- **Official paid X API** is the only fully ToS-compliant read path but ~33× the cost + meters writes — a compliance fallback, not the default.

**Operational notes:**
- Reads no longer require `x-cookies-ct0` / `x-cookies-auth-token` — those secrets are now **write-only** (send path). A missing/dead Apify token makes discovery+profiler skip the tick (no leads), it does not fall back to cookie reads.
- The shared Apify pool already hit a FREE-tier monthly cap once (Lyra); stack multiple tokens in Connections so rotation has somewhere to go, and watch for `AllApifyTokensExhaustedError` on the dashboard.

## 5b. Server-side auto-send backstops (schedule endpoint)

The `POST /api/drafts/schedule-auto-send` endpoint (which stamps a picked batch of reply approvals with staggered `auto_send_target_at` times for the send worker to fire) now enforces its own server-side safety backstops, so a large or mistimed batch can't stack past the account's ceiling. Both can only WITHHOLD, never send more:

- **Daily auto-send budget (always on).** The batch is trimmed to `NOELLE_AUTOSEND_MAX_PER_DAY` (default **50**, matching the X send worker's `AUTOSEND_MAX_PER_DAY`), counting BOTH auto-sends already `status='sent'` in the last 24h AND rows already `pending` with an `auto_send_target_at` — so a second batch can't stack past the ceiling. A bad/negative env value falls back to 50. The trimmed count is returned as `withheld` (surfaced in the approvals UI). This is defense-in-depth — the authoritative daily ceiling still lives in the send worker; note the endpoint counts pending-scheduled rows (stricter) while the worker counts only `status='sent'`, so the two layers are deliberately not identical.
- **Opt-in master-switch refusal.** When `NOELLE_AUTOSEND_REQUIRE_SEND_ENABLED` is on (`1`/`true`; **default OFF**) the endpoint returns `409 sending_disabled` and stamps NOTHING while the instance's `reply_send_enabled` master switch is OFF. Default OFF preserves the pre-stage-while-off workflow (the send worker already refuses to post while the switch is OFF, so nothing leaks either way).
- **Fail-closed.** Any DB error while reading the switch/budget returns 500 and schedules nothing (never falls through to stamping); `remaining<=0` returns an empty `{scheduled:[],count:0,withheld}`.

## 6. Prioritized hardening plan

| Pri | Effort | Action | Maps to |
|-----|--------|--------|---------|
| **P0** | M | **Lock/challenge detection + hard circuit-breaker.** New `XLockError`/`XChallengeError` (detect /account/access redirect, "temporarily limited", error 326, Error 226, Arkose/CAPTCHA body, repeated 403-CSRF). On these: **hard-stop the tick, do NOT flip approval to errored, do NOT advance**, persist a paused state. | `packages/x-client` classifyError; `send-tick.ts`; `send.ts` |
| **P0** | S | **Wire the existing notifier into send.** Pushover alert on auth_failed (cookies dead), lock/challenge (hard stop), repeated rate_limit. (Already proven in classifier.) | `send.ts` + `lib/notifications.ts` |
| **P0** | M | **Velocity pacing on send:** rolling `AUTOSEND_MAX_PER_30MIN` (~6–8, DONE) + cross-tick min-inter-send floor + claim 1/tick (**DONE** behind `NOELLE_AUTOSEND_INTERSEND_FLOOR`, default OFF — §4/§8). | `send.ts`, `send-db.ts`, `env.ts`, `lib/send-pacing.ts` |
| **P1** | M | **Active-hours / overnight quiet gating** per-instance timezone, weekday-weighted, daily-count jitter. (LinkedIn now has a server-side active-hours backstop on the api-vm actuator queue via `NOELLE_LINKEDIN_SEND_WINDOW_START/_END/_TZ_OFFSET_MIN` — see `docs/linkedin-actuator.md`; X is still client/worker-side via `AUTOSEND_QUIET_*`.) | `send.ts`, instance config, `env.ts` |
| ✅ **DONE** | L | **Read/write split** (ask #2): discovery + profiler read via Apify `kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest`; only send touches the account cookies (§5). | `packages/x-apify`; `discovery.ts`/`profiler.ts`; `apify-resolver.ts` |
| **P1** | M | **Escalating backoff + persisted cooldown on 429** (honor `x-rate-limit-reset`; pause before remaining hits 0). | `send.ts`, surface rate headers in `x-client` |
| **P2** | M | **Enforced near-duplicate + AI-tell reply guard** (trigram/Jaccard vs last N sent; default zero links). | `quality-gate.ts`, `drafter.ts`, `send-db.ts` |
| **P2** | L | **Logged-out shadowban probe worker** (no cookies, 6–12h jitter): search `from:<handle>` + last replies' text; on disappearance trip the breaker + alert; graduated re-entry. | new `health-probe.ts` + unit |
| **P2** | M | **Cookie/IP hygiene runbook + warm-up state machine** (mint cookies from the stable VM IP; treat re-cookied accounts as new for 2–4 weeks). | `docs/runbook.md`, `docs/secrets.md`, per-instance ramp |

## 6a. Dashboard safety controls (operator-facing)

- **Global pause-all (panic stop).** The approvals-page header has a red "⏸ Pause all sending" button (`PauseAllButton` → `pauseAllSending` server action). It writes `reply_send_enabled = false` on **every** intern instance in the org in one `UPDATE` — the 0081 master send gate both send paths fail-closed on (`send.ts:97`, `actuator.ts`), so it's a real org-wide kill, not a UI hint. It only ever writes `false`, is org-scoped (the `org_id = auth.org.id` match is the IDOR guard), and is **deliberately asymmetric**: there is no `resumeAll` — re-arming stays per-intern via each agent's `ReplySendToggle`, so a panic stop can't be casually undone. No feature flag (a valve that only reduces sending shouldn't be hidden off-by-default), and no try/catch swallow (a failed write surfaces "sending may still be on — retry", never a false "paused").
- **Honest autopilot status + quiet-window labels** (behind `NOELLE_AUTOPILOT_PANEL`, default OFF; reflect-only). The Vega send-queue panel collapses `(reply_send_enabled, auto_send_enabled)` into one legible chip — **Off / Drafting only / Armed — master OFF (amber) / Live · autopilot** — removing the "I thought it was off / didn't know it was live" class of accidental unattended sends, plus a fail-closed caps snapshot (hidden on any error, never a fabricated "0 of N"). Independently, the dashboard now renders **"holds till HH:MM · quiet hours"** instead of "overdue" when a stamped auto-send target sits inside the `[4,12)` UTC quiet window the send worker already defers on (`send.ts:224`) — an overnight hold is expected, not a stall, so the operator isn't tempted to disable the protection. Client-visible hours mirror the server via `NEXT_PUBLIC_AUTOSEND_QUIET_START_UTC`/`_END_UTC` (default 4/12); display-only, no send-path effect.

## 7. Decisions needed before building

1. **Account age/trust?** Sets the warm-up tier (halve caps 2–4 weeks if new/re-cookied).
2. **Where were the cookies minted?** Laptop-minted + driven from the VM = geo/device mismatch = live suspicious-login risk → re-mint from / geo-align with the VM IP.
3. **Keep fully-unattended auto-send?** Recommend defaulting conservative + biasing to human-confirmed.
4. **Budget for a read API** (~few $/mo) for the read/write split? (Strongly recommended over a burner account.)
5. **X Premium Basic (~$3/mo)?** Lifts the 50/200 caps (not behavioral/velocity) — cheap lever if volume scales.
6. **Per-instance timezone** for active-hours gating (no tz field today).
7. **Does `@steipete/bird` expose `x-rate-limit-*` headers + a distinguishable lock/Error-226 body?** The proactive-backoff + lock-classification fixes depend on it; else fall back to status-code + redirect heuristics.

## 8. Unattended autosend hardening flags (2026-07 batch)

Anti-flag hardening for the lights-out X autosend path. **Every flag below defaults
OFF (no behavior change until the operator enables it) except the external-link
block, which defaults ON because blocking is the fail-closed / safe state.** All
new env keys live in `apps/x-intern/src/env.ts`.

| Flag | Default | What it does |
|------|---------|--------------|
| `NOELLE_DRAFTER_FENCE` | OFF | Wraps the untrusted post text + vision caption in `<post_by_author>` delimiters with a data-not-instructions guard so a hostile/prompt-injected post cannot steer Vega's autosent reply. Off ⇒ byte-identical prompt. Defense-in-depth pairing with the outbound link guard below (a fenced post can still smuggle a link the drafter echoes; the link guard catches that at the send chokepoint). |
| `NOELLE_AUTOSEND_QUALITY_AUTOENABLE` | OFF | When ON, any instance with `auto_send_enabled=true` auto-engages voice-variety (`NOELLE_DRAFTER_VARIETY`) + the reply-diversity gate (`NOELLE_REPLY_DIVERSITY_GATE`) even if their per-lever flags are off — the two human-likeness levers that most reduce templated/near-duplicate reply signals on the unattended path. Off ⇒ each lever governed only by its own flag. |
| `NOELLE_X_AUTOSEND_REQUIRE_VERIFY` | OFF | Fail-CLOSED autosend gate: an auto-post fires only with a GENUINE passing verifier verdict (verify ran, the judge actually returned, every dimension cleared the bar). Verify-off / judge-unavailable / failing verdict ⇒ HOLD the reply for manual approval (never auto-send on uncertainty). Composes with `NOELLE_DRAFTER_VERIFY` (verify must be on to ever pass) and pairs with the send-worker hourly/30-min velocity caps. Manual-approval path untouched. |
| `NOELLE_AUTOSEND_BLOCK_EXTERNAL_LINKS` | **ON** | An auto-sent reply that carries an external (non-x.com/twitter.com/t.co) link is never posted unattended — the drafter withholds the schedule (row falls to the human-review inbox) and the send worker reverts any already-stamped link row to `pending`. Autonomously posting links in replies is a documented top-tier spam signal (§3). Set `"0"` to disable. DMs (manual-send, legitimately carry the pitch URL) and human Send-button clicks are unaffected. |
| `X_PERSIST_SEND_COOLDOWN` | OFF | Persists the fixed cooldown deadline and 429 streak to `noelle.agent_instances` across restarts. A failed read blocks sends for that tick. The 429 escalation caps at 120 minutes; systemic reply restrictions set a six-hour hold. Both expire at their stored deadline. Off ⇒ in-memory cooldown only, with no additional query. |
| `NOELLE_AUTOSEND_INTERSEND_FLOOR` (+ `AUTOSEND_INTERSEND_MIN_MS`=60000, `AUTOSEND_INTERSEND_MAX_MS`=120000) | OFF | Cross-tick inter-send floor (see §4): ON ⇒ post at most ONE reply per tick and refuse to send again until a fresh JITTERED gap (uniform in [min,max]) has elapsed since the last successful post, so a post-downtime backlog drains one-at-a-time instead of bursting. Strictly slows sends ⇒ fail-safe. Off ⇒ today's `Math.min(remaining,2)` claim + unpaced retry drain. |
| `AUTOSEND_STAMP_HONORS_QUIET` | OFF | When ON, the drafter's stamped `auto_send_target_at` is pushed to the end of the `[AUTOSEND_QUIET_START_UTC, END_UTC)` (default 4–12 UTC) quiet window instead of landing inside it — the recorded stamp then matches what `send.ts` already enforces (send.ts always defers a quiet-window fire), so the dashboard stops showing a false "overdue" for a reply that is really just quiet-held. Off ⇒ stamp computed exactly as today. |

## 9. X actuator lights-out auto-drain (ported from the LinkedIn actuator, PR #446)

The X actuator (browser extension, `apps/x-actuator`) can now clear the approved-reply inbox unattended: with **Options → auto-drain** ticked (requires *Autonomous* on, both default OFF), the 5-minute autonomy alarm starts a **drain** whenever `GET /api/actionable-x` serves approved replies and nothing is running. Safety semantics:

- **Ships inert.** Two consents are required and BOTH default off: the extension's `autoDrain` checkbox AND the dashboard's `agent_instances.auto_send_enabled` standing consent. The unattended path never arms `reply_send_enabled` itself, so pause-all (`pauseAllSending` clears both flags on every instance) starves auto-drain org-wide — the panic stop stays authoritative.
- **Server-gated supply.** The `/api/actionable-x` gate now honors `reply_send_enabled OR auto_send_enabled`; every server withhold gate (challenge circuit-breaker, daily write cap) applies to both consent paths unchanged — an empty served queue simply means no drain starts.
- **One flag, two senders — the pool is partitioned.** Unlike LinkedIn (where the column is inert for Lyra), `auto_send_enabled` on X is ALSO the live consent for the x-intern **API autosend** pipeline (the drafter stamps `auto_send_target_at`; `claimAutoSendDue` claims + posts stamped rows via the official API). To keep the two unattended senders off the same approvals, `/api/actionable-x` serves ONLY unstamped approvals (`auto_send_target_at is null`, enforced in SQL and again in `buildActionableX` → `autosend-owned` omit): stamped rows belong to API autosend, unstamped inbox rows to the actuator.
- **Pre-send revalidation (fail-closed).** A pooled reply can sit queued for minutes-to-hours; before posting each one, the extension calls `GET /api/actuator/approval-state/:id` and posts ONLY a verified `pending` + unstamped approval (`preSendDecision`). Decided/claimed elsewhere ⇒ dropped locally with no durable write; check unreachable ⇒ fail closed, retry under `MAX_ACTION_TRIES` — a reply that another sender owns or already published is never posted twice.
- **Same safety gate as the daily auto-start:** `x-health` must be `ok` (fetch failure fails closed) + the post-challenge cooldown, and the same operating window (start/end hours). A manual STOP silences auto-drain for the rest of the day (`actuator.lastManualStopDay`); the re-arm cooldown (`AUTO_DRAIN_REARM_MIN` = 30 min, stamped BEFORE `startDrain` so a mid-start crash can't machine-gun restarts) bounds a drain that keeps dying with items still queued. With drain auto-continue (#439) an auto-drain self-extends until the inbox is clear, bounded by `MAX_DRAIN_ROUNDS`.
- **Velocity caution (X-specific):** drain pacing is hotter than LinkedIn's — `drainShortBandProb` (default 0.55) draws inter-reply gaps from the short 20–60s band (floor raised from 1s by the 2026-07-26 quiet re-tune; see §10). That is fine when an operator is watching, aggressive for lights-out. For unattended use set `drainShortBandProb` low (or 0) in Options so gaps come from the 60–120s band, and keep the server-side daily write cap (`NOELLE_X_ACTUATOR_DAILY_WRITE_CAP`) + challenge halt (`NOELLE_X_ACTUATOR_HALT_ON_CHALLENGE`) enabled — supply-side gates are what actually bound an unattended loop.

## 10. Actuator client-side humanization (Vega's hands — `apps/x-actuator`)

The X actuator shares the LinkedIn actuator's motion/timing engine; a batch of Lyra humanization fixes was ported to the X surface (all client-side; deploy = rebuild `dist-unpacked` + reload the extension, NOT `noelle sync`).

- **Stepped-away pause jitter (scheduler).** On top of the AR(1) tempo gap, ~1 action in 5 (at random) gets an extra **0–300 s (0–5 min)** added to its gap — a one-off distraction, not a tempo change (kept out of the autocorrelation, never compounds). Drawn from a SEPARATE plan-deterministic RNG so the main tempo/burst/volume stream is byte-for-byte unchanged; it only ever widens spacing (overflow past the window is dropped + logged, never clustered). Capped at 5% of the window. Tunable via `EXTRA_PAUSE_PROB` / `EXTRA_PAUSE_MAX_MS` in `src/lib/scheduler.ts`.
- **Idle-liking — likes in the wait.** While nothing is due, the actor slips real feed-likes into the gap rather than only scrolling (same read-then-click machinery as a scheduled like: find a hydrated tweet, read it, sometimes expand "Show more", then a trusted click). It is **paced** (`IDLE_LIKE_MIN_GAP_MS`=5 min since the 2026-07-26 quiet re-tune, was 45 s), **never runs during a drain at all** (see §10), **curfew-safe** (gated on the shared `isWriteCurfew`), and **budget-bounded**: idle-likes count against `s.done.likes` and only fire while `done < targets.likes`, so total likes (idle + scheduled) never exceed the plan's cap-bounded like budget — a scheduled like slot the idle-likes already covered is skipped (`like-budget-met`). Net: the same like volume, concentrated into the waits. This budget-share is the load-bearing safety property (§4: likes are a higher-risk behavioral signal — no over-liking past the cap). The expand-leaning ambient read-mix + tightened read cooldown (`AMBIENT_READ_MIN_GAP_MS` 30 s→20 s) ride along.
- **Action-variance widening (anti-fingerprint).** Pure distribution tuning across the shared humanization functions (`lib/{session,motion,dwell,scheduler}.ts`, `background/{cdp,ambient}.ts`, `content/locators.ts`) — no new flags, behavior gated only by the actuator being enabled. The invariant IS the safety review: **widen spread and the upper tail only** — never lower a timing floor, never raise action volume, hold central tendency equal-or-slower — so sustained-velocity triggers are untouched (per-session persona spreads widened, formerly-fixed click σ / tremor freq / dwell params re-drawn, scroll/dwell gammas given heavier tails, `volumeFactor` floor lowered 0.8→0.72 so the average plan is *smaller*). The like-target locator now picks a random in-view tweet instead of always the topmost — which is risk-REDUCING (kills the always-first-tweet tell), the riskiest X action class (§4).
- **NO auto-enable send on X (deliberate divergence from the LinkedIn actuator).** The LinkedIn actuator flips `reply_send_enabled` on manual Run/Drain because on LinkedIn that column has no consumer outside the actuator queue routes. On X it is the **master gate of the x-intern official-API send worker** (`apps/x-intern/src/workers/send.ts`): once true, that worker fires ANY `auto_send_target_at`-stamped pending approval via the official API — an unattended second sender armed over the same approval pool (duplicate public posts), and an `endRun` disable would silently revoke the operator's standing dashboard consent (killing API autosend after any manual actuator run). So the X extension **never writes the flag**: consent for X actuator runs is the operator flipping reply sending on the Vega agent page, and `/api/actionable-x` simply serves empty while it is off. Belt-and-braces on the server: `/api/actionable-x` also **excludes `auto_send_target_at`-stamped rows** — a pending approval scheduled for API autosend is owned by `claimAutoSendDue` and is never served to the browser, so even with both senders armed the same reply can't post twice.
- **Engagement variety on likes — DEFAULT-OFF (`engagementWeights`).** `pickEngagement` (`src/lib/engagement.ts`) draws the engagement each like slot delivers from a weighted table over `like` / `bookmark` / `repost`. Unlike LinkedIn's reaction variety (all six are the same low-risk reaction gesture → ships default-ON), on X these are DIFFERENT action classes — **repost is public amplification under the account's own name** (reputational + spam-signal risk; an intern reposting the wrong tweet is a real incident) and bookmark still adds write volume — so the default weights are **like=100 / bookmark=0 / repost=0**: behavior is a plain ❤ Like until the operator explicitly opts in per-config (raise `repost` deliberately). A non-`like` pick locates that button on the same tweet (by `tweet_id`) and clicks it — repost then clicks the confirm menu item (`retweetConfirm`, no `scrollIntoView` on the transient menu). **Stale-rect discipline (`src/background/engage.ts`, unit-tested):** locating the bookmark/repost button `scrollIntoView`s the tweet, so every rect measured before that locate is dead — a fallback must never click the pre-scroll like rect (a trusted CDP click at stale viewport coordinates can hit a link/follow/reply of a *different* tweet, and the open repost menu's backdrop swallows clicks anyway). A pre-scroll locator miss falls back to the still-valid plain Like; a post-scroll miss (repost confirm never opened) dismisses the menu via **Escape**, **re-locates the heart for a fresh rect** and clicks that — and if the re-locate misses too, the attempt records a `skip` (`engagement-not-landed`) and counts **no** like (never a phantom `done.likes++`). The same fresh-re-locate runs after a "Show more" expansion (it reflows the action bar). The discipline also covers the expand click itself: `locateLikeTarget` (`src/content/locators.ts`, regression-tested in `tests/dom/like-locator.test.ts`) scrolls the like button into view **before** measuring `seeMoreRect`, so the trusted click that opens "Show more" fires at post-scroll coordinates — the in-view filter admits tweets up to 1.4×viewport below the fold, so a pre-scroll measurement would be hundreds of px off and could land on another tweet's text, a link, or a Follow button (the LinkedIn locator got the same scroll-first fix). The delivered engagement rides the `like` activity event's `engagement` field + the panel string; api-vm accepts it but does not persist it (no column yet). The `Cdp.hover` primitive (approach/hover split) was ported alongside for future hover-card use during ambient browsing.

## Sources
Synthesized from current (2024–2026) X help docs, the twikit/TwitterInternalAPIDocument rate-limit references, reputable automation/OSINT writeups, and reporting on the 2025–2026 enforcement changes (50/200 caps, the Oct 2025 1.7M reply-spam purge, "human-only interaction" detection). Numbers are dynamic + trust-weighted — treat as ceilings to stay well under, not targets. Full agent findings: workflow `x-account-safety-research`.

---

## 10. Quiet drain re-tune (2026-07-26) — port of the LinkedIn actuator's #497

Vega's drain planned far more like activity than Lyra's, on the action class §4
flags as the highest-risk signal with no published cap. Measured over 600
simulated sessions against the pre-change planner:

| | before | after | Lyra (post-#497) |
|---|---|---|---|
| likes / session | 32.2 (median 32) | **9.5** (median 10) | — |
| likes / gap | 2.68 | **0.79** | ~0.78 |
| max likes in ONE gap | 8 | **3** | 3 |
| likes / minute | 2.60 | **0.67** | ~0.41 |
| planned gaps under 10s | 6.2% | **0%** | 0% |

What changed in `apps/x-actuator/src/lib/scheduler.ts` + `background/`:

- **Cooldown is now the modal gap pattern** (`GAP_PATTERN_WEIGHTS`
  `[.34,.26,.18,.11,.11]` → `[.14,.46,.20,.10,.10]`, and every one of the five
  session archetypes re-weighted to match). The typical gap is now a genuine
  quiet pause with **zero** likes; ambient browsing still fills it, so the
  session looks alive without acting.
- **Every liking pattern caps at 3 likes**, and `full` drops from 4–8 to 1–3.
- **A drain never idle-likes** (`shouldIdleLike`'s `inDrain` gate). Idle-likes
  were already budget-bounded, but they *raced ahead* of the plan on a flat
  ~45–81s drip, collapsing the per-gap patterns from #471 back into the single
  uniform cadence they exist to break.
- **`IDLE_LIKE_MIN_GAP_MS` 45s → 5 min**, matching Lyra. Volume is unchanged
  (idle-likes stay budget-bounded); the same likes spread over more wall clock.
