# Vega Account Feeder — the "voice of our posts" for the X intern

Give Vega (the X Growth Intern) the same style-learning lever Lyra has: the operator
**picks a person** (an X account) whose *form* becomes the voice of Vega's drafts.
You can **pin** one exact voice, or **blend** several. Seeded first with
[@eliana_jordan](https://x.com/eliana_jordan).

## The two-layer model (unchanged from Lyra)

Voice is deliberately split so the operator never loses their own voice:

- **CONTENT = the operator's own vault** (Nella/BM25 voice anchors). *What* is said.
  Untouched by this feature.
- **FORM = the admired account(s)** — rhythm, hooks, sentence-shape, tone. *How* it's
  said. This is the Account Feeder. It **never** borrows the source's content, topics,
  opinions, or specifics.

Each draft records which accounts shaped it (`payload.style_source`), rendered on the
X approval card as a badge like `Style: eliana_jordan 100%` (pinned) or
`Style: kaia 67% · devon 33%` (blend).

## Architecture

The style engine is shared with Lyra, in `@noelle/runtime`
(`style{Select,Block,Types}.ts` + `stylePin.ts`) — one implementation, no mirrored
copies. Vega adds only the X-specific producer + wiring:

| Piece | Where |
|---|---|
| Shared selector / renderer / pin / row-types | `packages/runtime/src/style*.ts` |
| X corpus loaders (`platform='x'`, `role='x_intern'`) | `apps/x-intern/src/lib/x-account-feeder-db.ts` |
| X feeder worker (Apify pull → Gemini distil → Voyage embed) | `apps/x-intern/src/workers/account-feeder{,-tick}.ts` |
| Reply-drafter wiring (STYLE block + blend badge + pin) | `apps/x-intern/src/workers/drafter-tick.ts`, `lib/prompts.ts`, `lib/register.ts` |
| CLI | `noelle vega style …` (`apps/cli/src/lib/vega-style.ts`) |
| pm2 process | `noelle-account-feeder` (`apps/cli/src/lib/process-manager.ts`) |

The 3 tables (`noelle.account_feeder_sources`, `account_style_posts`,
`account_ultra_profiles`) are platform-generic — X is a `platform='x'` data value, no
schema change. Sources' tweets are split into `kind='post'` (originals) and
`kind='comment'` (the account's own replies) by `is_reply`; **the reply drafter
pools BOTH** — an X account's voice lives in its originals — and the Voyage reranker
+ performance floor pick the best-fit exemplars per lead.

## How the operator picks a person

```
noelle vega style add eliana_jordan       # add an X style source
noelle vega style pin eliana_jordan       # write in exactly her form (floors exemplars, variety=0)
noelle vega style run                      # trigger a pull (the feeder learns her)
noelle vega style list                     # show sources, pin, corpus counts, last run
noelle vega style unpin                    # back to a blend of all enabled sources
noelle vega style remove eliana_jordan     # disable a source
```

`pin` writes `account_feeder_config.pinnedStyleHandle`; `run` stamps
`account_feeder_run_requested_at`, which the `noelle-account-feeder` pm2 worker polls
(manual + cost-gated — it runs even while the instance is paused).

### Multi-voice faithful rotation (ported from Lyra #427)

Vega's drafter also honours the shared multi-voice keys on
`account_feeder_config` (schema: `packages/contracts/src/account-feeder.ts`):

- `faithfulVoices: string[]` — 2+ source handles; each lead deterministically
  gets ONE of them (`pickFaithfulVoice`, seeded on the post text) so a reply
  always sounds like a single real writer, rotating across the feed. A single
  `pinnedStyleHandle` still behaves exactly as before (it is read as a
  1-element list).
- `faithfulVoiceWeights: number[]` — optional relative weights parallel to
  `faithfulVoices` (e.g. `[0.6, 0.4]`); missing/mismatched/non-positive-sum
  falls back to a uniform draw. A chosen voice with no corpus fails open to
  the full pinned pool.

**Pinned voice beats random variety (ported from Lyra #428):** when a faithful
voice is pinned AND `NOELLE_DRAFTER_STYLE` is on (so the pin actually reaches
the prompt), the random ASSIGNED-REGISTER variety layer
(`NOELLE_DRAFTER_VARIETY`, incl. the autosend-quality auto-engage path) was
suppressed — the pinned writer's own posts already carry register/energy, and a
random SLANG/HYPE register fights them.

**This worker-level suppression is GONE as of 2026-07-26.** It was the reason
Vega read as one-note: Vega has `pinnedStyleHandle` set and `NOELLE_DRAFTER_STYLE=1`
in production, so `variety.enabled` evaluated to **false** on every lead, and
with `NOELLE_DRAFTER_ENERGY` unset there was no energy hint either. Vega drafted
every reply with no register, no shape and no energy hint: a fully static prompt.
Lyra replaced the same suppression with per-lead form variants in #498; Vega now
does the equivalent, so the pin is never fought by a contradicting register while
form still varies.

### Per-reply SHAPE rotation (Vega)

Each lead is assigned ONE shape from `X_FORM_VARIANTS` (`@noelle/runtime`
`formVariants.ts`), and the rotation never hands out the same shape twice in a
row (process-wide, so the guarantee holds across ticks as well as across leads).
Three differences from Lyra's set:

- **The shape is a STANDALONE block** (`renderAssignedShapeBlock`), not one
  rendered inside the faithful style block. Lyra now does the same (see
  `docs/linkedin-intern.md`): her rotation used to fire only when a voice was
  pinned AND the style pool loaded, which is why her feed measured 181 ± 44
  chars against Vega's 131 ± 58 over 30 days.
- **The two sets are no longer the same list.** They used to be the same ten
  shape ids with different length bands, which is a large part of why the two
  feeds read as one writer. Vega keeps `RIFF` (answer with the joke, nothing
  else) and `FLAT_DISAGREE` (contradict, one reason, stop) — the two moves X
  rewards and LinkedIn punishes. Lyra keeps `SELF_STORY` and `AGREE_EXTEND`
  instead. Ten shapes are still shared; the weighting differs too (X leans
  shorter).
- **Lengths are retuned for X.** `THREE_BEAT` is 190–240 chars (Lyra's is
  220–320) so it stays inside X's 280 reply ceiling and under the verifier's
  250-char `charLimit`. `MICRO` goes down to **one word** — a bare "brutal" is a
  native X reply — while still requiring a real reaction, since `SYSTEM_X`
  separately bans empty reciprocity ("true", "same", "100%").
- **Shape and register are mutually exclusive per lead.** Both claim authority
  over reply length, and two contradicting length rules is what #498's review
  found squeezes drafts. On a tone-first energy (joke / celebration / vent /
  hot take) the energy-aware REGISTER wins, because mirroring tone beats varying
  form there; every other lead gets a shape.

An **OPENING MOVE** (`@noelle/runtime` `openingMove.ts`) is layered on only for
the shapes that leave the opener free — `TWO_FLAT`, `RUN_ON`, `ASIDE`,
`THREE_BEAT`. The short shapes have no opening distinct from the whole reply, and
`HOOK_THEN_LINE` / `OBSERVE_ASK` / `DETAIL_ZOOM` already prescribe their own
opener, as do all four platform-exclusive shapes. Vega's move pool also drops `ANECDOTE`, which asks for a first-person
story and would re-open the burned-props failure the `RECYCLED PROPS` section
exists to stop.

### Reply memory

Vega also injects, and enforces via the verifier, what it has already said:
per-person (`X_DRAFTER_SENT_TOPK`, default 3 — "do not repeat these takes to this
person", graded as the verifier's `novelty` axis) and feed-wide
(`X_DRAFTER_RECENT_PHRASINGS_TOPK`, default 20 — "do not reuse these openers",
graded by the deterministic `diversity` leg). Both fail open and are omitted
entirely when there is no history. This is the prompt-side complement to the
existing `replyPriors` gate, which only rejects a near-duplicate *after* it is
written.

**Config-write trap (post-deploy only):** the readers `safeParse` a `.strict()`
schema fail-closed — writing `faithfulVoices`/`faithfulVoiceWeights` into an
instance's config while an OLD worker build is running makes the parse fail and
silently unpins the voice (drafts revert to blend/no-style with no error).
Write the new keys only after the code carrying them is merged + deployed.

## Activation

Style injection is **OFF by default** (drafts are byte-identical until turned on):

1. Set `NOELLE_DRAFTER_STYLE=1` in `~/.noelle/.env` (optionally `NOELLE_DRAFTER_DENSE=1`
   for the hybrid pgvector ranker, `NOELLE_DRAFTER_STYLE_POOL` to size the pool).
2. `noelle vega style add <handle>` + `pin <handle>` + `run`.
3. **Reload the drafter's env** — delete + start the `noelle-drafter` + `noelle-account-feeder`
   pm2 apps (pm2 only re-reads `~/.noelle/.env` on start, not reload).

The reply drafter then loads the style pool once per tick, selects per-lead exemplars
matched to the post (register-conditioned: celebration vs neutral), injects a
`STYLE TO EMULATE` block (FORM only), and stamps `style_source` for the badge.

## Fail-open guarantees

Every seam is fail-open: gate off / empty pool / any error → no STYLE block, drafts
exactly as before. Lyra is untouched (the extraction moved code verbatim; its tests
pass unchanged).

## Known limits / follow-ups

- **Reply path only.** The batched-light reply path and the ideation/post drafter don't
  yet inject style (they lack the per-tick `sql`/loader plumbing). Follow-up.
- **Dashboard source-picker.** Lyra's feeder-config page
  (`agents/[instanceId]/feeder/`) is LinkedIn-authorized; making it multi-platform is a
  separate UI task. Until then, manage X sources with the CLI. The **badge already
  renders** on X approval cards (`SpeedrunRow` → `StyleSourceBadge`).
- **Exemplar weighting.** The drafter pools originals + replies and reranks by fit +
  engagement; a pinned voice could optionally weight the originals harder still.
- **Apify billing.** A pull needs a live Apify token in the rotating pool; when the pool
  is exhausted the run surfaces a `feeder.error` and no corpus is written (by design).

---

## Classification, discovery and DMs (2026-07-26 parity pass)

The Account Feeder above governs Vega's VOICE. This section covers the rest of
the Lyra→Vega parity work, since several pieces change what reaches the drafter
at all.

### Reply-worthiness (`q`) replaces the virality proxy

The classifier used to return only `velocity_score` — a prediction of whether a
post will blow up — and the drafter's quality gate graded on it. That conflated
"will this go viral" with "should we answer this", and it scored quiet,
perfectly answerable questions from ICP founders low (live p50 0.20).

It now also returns **`q`** (0-100 reply-worthiness), **`reply_kind`**
(`substantial` | `light` | `skip`) and **`comment_bait`**, matching Lyra and
Orion. The gate grades on `q`; `velocity_score` is kept in `classifierMeta` for
observability. `tier` is DERIVED from `q` (>=90 T1, >=80 T2, else T3) rather
than trusted from the model, and only a `substantial` lead carries one.

The per-instance bar is `agent_instances.classifier_threshold` (mig 0042) and
falls back to `X_Q_THRESHOLD`. That column has been wired for Lyra and Orion
since #184/#230; Vega ignored it, so the dashboard's strictness control silently
did nothing for the X intern.

### Watchlist leads are classified, not bypassed

A watchlist lead used to skip the classifier entirely with a forged `score=1`
and `tier=T1`, so ~70% of drafted output was never graded. It is now classified
like any other lead and merely **protected**: a `skip` verdict is clamped to
`light` rather than dropped, because the person is the gate, not the post.

Guards that keep that honest:

- an **off-topic floor** — the rescue only fires at or above
  `NOELLE_X_CLAMP_MIN_Q` (default 25), so a hand-picked person's off-topic or
  promo post is still a skip;
- a **null `q`** (a scoring outage) clears the floor;
- the **AI-slop detector and the follower floor are exempted for a priority
  lead**. Both grade STRANGERS, and the old bypass short-circuited them, so
  removing it without this would have quietly made them terminal for watched
  authors. Measured on the live data before the exemption landed: 56 of 2813
  priority leads trip the slop detector and 11 would have been dropped — 10 of
  which had actually been drafted and sent. Both verdicts are still recorded in
  `classifierMeta` for auditing; they simply stop being fatal for someone the
  operator chose.

The only ways a priority lead is now dropped are the ones that applied before
too: it is too old, it is non-English, or it is off-topic below the clamp floor.

On X, `priority=true` already means "the author is in the watchlist people list
and posted on/after the day they were added", so unlike LinkedIn there is no
`payload.source` discriminator to apply: every X priority lead is hand-picked by
construction. This costs one classifier call per watchlist lead that the bypass
used to avoid.

### The light lane

`reply_kind='light'` routes to a SHORT warm reaction (a ship, a launch, a
personal win) instead of a substantive take. It reuses the shape machinery
rather than a second prompt: shapes that cannot carry a congrats are excluded,
a be-warm-and-brief directive is added, and `allowCelebration` stops the
verifier grading genuine warmth as forced cheer.

### ICP author gate

When `icp_config.headlineKeywords` is set, a non-priority author whose **bio**
clearly does not match is dropped before the LLM call. Two differences from
Lyra's headline gate, both platform-driven:

- **priority leads are exempt** — the operator already chose them;
- **a missing bio fails OPEN**, because the Apify actor does not reliably return
  one. Failing closed (Lyra's behaviour, correct for Voyager profiles which
  always carry a headline) would silently drop the entire keyword lane the first
  time the actor changed its payload shape.

### Discovery

- The **engagement floor (`minFaves`) is keyword-lane only.** It is a heuristic
  for trawling strangers; on the watch lane the person is already the gate, and
  quality is now judged downstream on content.
- The watch-lane fetch is narrowed to `max(window, added_at)`. Apify bills per
  item and pre-`added_at` posts are discarded anyway.
- `X_WATCHLIST_REPOLL_HOURS` now defaults to **2** (was 0, i.e. the gate shipped
  inert and never fired). Vega has no dual-role targeting handles, so every
  watch person was re-polled on every tick.
- A dead Apify pool now **pages the operator**. Both discovery lanes re-throw
  `AllApifyTokensExhaustedError` instead of swallowing it as a per-source
  failure, which is what made the existing handler unreachable (#494: discovery
  dead ~25h, symptom was an approvals queue draining to zero).
- Goal-runs have a **stall guard**: a target the watchlist can never reach
  auto-pauses after 2h of no new replies instead of polling Apify forever.

### DMs ladder up

The on-demand DM was a one-shot cold pitch every time. Note the SYSTEM prompt
declares the DM "is where the actual pitch lives" and mandates the site + install
lines, so a per-lead rung directive in the user prompt could not beat it — every
rung below Invite now also appends a hard DM-pitch override to the system prompt,
last, where it wins. It is now the next rung
of four, chosen by how many DMs were already SENT to that person: Open → Deepen
→ Bridge → Invite, and only the top rung may propose a call. Prior DMs to that
person are injected so a later rung cannot reuse an earlier opener. Any DB error
counts 0 sent, so an unknown person starts at rung 1 rather than being invited
to a call on first contact.

### Model escalation

`useOpus = likes > X_OPUS_LIKES || (replies > X_OPUS_REPLIES && !comment_bait)`.
Suppressing the replies trigger on an engagement-bait post is the load-bearing
half: otherwise a "comment WORD below" giveaway reliably buys itself the
expensive model on a reply count inflated with junk. Both thresholds at 0
disables escalation.

---

## Person-first discovery (2026-07-26)

Vega's lead model was entirely POST-first: the keyword lane found tweets, minted
leads from the good ones, and threw the author away. Someone who clearly matched
the ICP but whose current tweet was not reply-worthy left no trace and had to be
rediscovered from scratch every time. Lyra has retained qualified people since
#185; this is the X analogue.

**It is not a literal port, because X has no people-search.** Lyra's Feeder A
calls a LinkedIn profile-search actor; the X client exposes only `userTweets`,
`searchTimeline` and `conversationReplies`. So candidates come from the authors
already surfaced by the keyword lane, gated on their BIO.

How it works:

1. **Retain.** Any keyword-lane author whose bio matches `icp_config` is upserted
   into `noelle.x_discovered_people` (mig 0090), idempotent on
   (instance, handle), bumping `seen_count` on every re-sighting.
2. **Poll.** On later ticks the least-recently-polled candidates join the SAME
   source ring as the watchlist handles, so they inherit the tick budget, the
   rate bucket, the cursor rotation and the re-poll machinery instead of running
   in a parallel loop. Their posts become ordinary **non-priority** leads.

Deliberate asymmetries, each for a reason:

- **Retention fails CLOSED on an unknown bio**, while the classifier's ICP gate
  fails OPEN. Opposite trades: dropping the whole keyword lane because the actor
  stopped sending bios would be catastrophic, whereas filling a speculative
  prospect list with unvetted handles just spends Apify budget polling strangers.
- **Watchlist people are never retained** — the watchlist already holds them, and
  a handle in both lists is polled once, not twice.
- **The lane is off on a paused (watchlist-only) tick.** Paused means the
  operator turned the keyword lane off; speculative polling would spend their
  budget on people they never chose.
- **A candidate is stamped as polled even when their fetch fails**, so a broken
  timeline cools down instead of sitting at the front of the never-polled queue
  and being retried every tick.
- **It requires `icp_config`.** With no "right person" test there is nothing to
  qualify on, and retaining every author would be an expensive way to poll
  strangers. `readIcpGate` is shared with the classifier so "in-ICP" means one
  thing in both places.

This is distinct from watchlist auto-promotion, which is post-first and slow: it
promotes an author into the always-reply watchlist only after N drafted replies.
The person lane keeps *candidates*, gated on who they are, and polls them as
ordinary leads.

Knobs: `X_PERSON_LANE_ENABLED` (default on), `X_PERSON_POLL_PER_TICK` (3 — each
costs one Apify run), `X_PERSON_POLL_COOLDOWN_HOURS` (12).

### The follower feeder (person DISCOVERY)

Retention above answers "keep the good people we already bumped into". The
feeder answers "go find people we have never seen".

Lyra does this with a LinkedIn profile-search actor. X has no keyword→user
search actor that is trustworthy on a free Apify plan: the best feature fit is
`apidojo/twitter-user-scraper`, but that is the same publisher this repo
migrated OFF on 2026-06-23 for silently returning `{demo:true}` placeholders to
FREE-plan tokens while still charging. Re-taking that trade for a load-bearing
lane is not worth it.

So Vega discovers people from **audiences** instead, via
`kaitoeasyapi/premium-x-follower-scraper-following-data` — the same publisher as
the tweet actor, which is the one proven to return real data on free tokens. It
needs no login, no cookies and no proxy setup, and every record carries the bio
the ICP gate qualifies on.

Arguably a better signal than keyword search: a bio match finds people who
*describe* themselves a certain way; the follower list of an account your ICP
already reads *is* that audience.

**Seeds** come from `icp_config.seedHandles` when set, else the operator's own
watchlist (accounts they already chose). A cursor rotates through them so a long
list is covered over successive runs instead of re-harvesting seed 0 forever.

**Cost is the whole design constraint.** Unlike every other discovery knob this
one spends per RUN, not per useful lead, and the actor floors its list at 200
users. With the shipped defaults:

| | |
|---|---|
| per run (200 users @ ~$0.15/1K) | **$0.03** |
| per day (1 run) | **$0.03** |
| per month | **$0.90** — 18% of one $5 free-tier token |
| **if the throttle ever failed** (every 5-min tick) | **$8.64/day ≈ 52× a token/month** |

That last row is why the throttle is built the way it is:

- the stamp lives on the **bus**, not in process memory — the worker restarts on
  every deploy tick, and an in-memory stamp would let each restart re-trigger a
  paid run;
- it is written **before** the run, so a crash mid-harvest cannot leave the
  feeder eligible again on the very next tick;
- an **unparseable stamp means skip**, not run, so a bus glitch costs nothing.

It also ships **default OFF** (`X_FOLLOWER_FEEDER_ENABLED`) and requires
`icp_config`, because with no "right person" test it would retain everyone it
paid for. Knobs: `X_FOLLOWER_FEEDER_INTERVAL_HOURS` (24),
`X_FOLLOWER_FEEDER_MAX_USERS` (200), `X_FOLLOWER_FEEDER_SEEDS_PER_RUN` (1).

Spend is metered as actor `premium-x-follower-scraper` so this lane's cost shows
next to the rest of discovery's, priced from Apify's own `usageTotalUsd` when the
run reports it.
