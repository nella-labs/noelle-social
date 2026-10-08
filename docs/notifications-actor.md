# Notifications actor — part 2 of the reply system

How Vega and Lyra answer the people who answer *them*. Read this with
`docs/reply-actuation-strategy.md` (how a reply reaches the platform at all) and
`docs/x-actuator-plan.md` / `docs/linkedin-actuator.md` (the extensions).

## The gap this closes

Part 1 opens conversations: the interns find a stranger's post, draft a reply,
and the actuator posts it. Then that person replies back — and nothing happens.
The notifications tab fills up and every thread dies on our side, which is the
worst shape a reply account can have. The second turn is where a reply becomes
a relationship.

Part 2 is an actor that reads the notifications page, finds the people who
replied to us, and puts them back through the normal drafting pipeline.

## The panel: discovery first, older modes available

Both extensions use the same compact panel. **Discover + reply automatically**
and **Stop actor** are visible; the three older start modes below are inside
the collapsed **Other modes** section. The old `Run` button and the
`Window / Comments / Likes` inputs are gone — the scheduled-run path is still
in the code and still used by the lights-out autonomy auto-start. The panel
shows active reply leads and errors instead of an activity console.

| Button | Command | What it is |
|---|---|---|
| **Auto** | `startFullAuto` | Persistent unattended drain. Posts every approved reply, watches for new ones, holds posts overnight (1am–9am). |
| **Manual Auto** | `startDrain` | The same persistent drain with **no** overnight curfew — you chose the hour. |
| **Auto notifications** | `startNotifications` | An unattended drain **plus** the notifications sweep. |
| **STOP** | `stopRun` | The one off switch. Clears the standing intent. |

## Why "Auto notifications" is a drain

This is the load-bearing decision. A sweep-only run would harvest the
replies-to-us, hand them to the intern, and then never post the drafts —
because the thing that posts approvals is the drain, and starting a
notifications run would have superseded it.

So `startNotifications()` is `startDrain({ manual: true, curfew: true,
notifications: true })`. One click runs the whole loop:

```
sweep the notifications page
  → POST /api/actuator/inbound-reply   (the extension's only write; it writes to noelle, never to the platform)
  → noelle.leads (status='classified', priority=true, payload.source='notification')
  → the intern drafter picks it up with full voice grounding
  → noelle.approvals
  → GET /api/actionable-x | /api/actionable-linkedin
  → the SAME live run posts it in-thread
```

The persistent drain already re-checks the server queue every ~75s with no
re-click, so the drafts the sweep causes get picked up by the run that caused
them, minutes later.

Implementation note: it is a **flag** on `RunState` (`notifications: true`), not
a third `mode`. Every existing `mode === "drain"` predicate
(`shouldExtendDrain`, `drainShouldKeepWaiting`, `inQuietDrainGap`) therefore
keeps working untouched. The flag also rides on `DRAIN_INTENT_KEY`, so a
notifications run that dies to a reload or SW-death resumes as a notifications
run rather than silently downgrading to a plain drain.

## The sweep

It hooks the tick's **idle branch** — where the run currently chooses between an
idle-like and an ambient browse while waiting for its next slot. Every ~10–20
minutes (jittered) a notifications run spends one of those waits reading its
notifications instead. Checking your mentions *is* ambient behavior, so this
adds no new behavioral surface.

The sweep is **not** gated on the write curfew. Harvesting is read-only, and
having overnight replies drafted and ready to post at 9am beats waking up to a
cold queue. What the curfew holds is the posting, and that gate is in the tick.

### X (`x.com/notifications/mentions`)

1. Navigate, dwell, scroll a pass or two.
2. `harvestNotifications` reads every tweet cell.
3. Keep only cells whose **"Replying to …" context names our own handle** —
   that is what separates a reply from a bare @mention or a quote post. Our own
   handle is read from the logged-in page (account switcher, then the profile
   nav link), with an Options `selfHandle` as a fallback.
4. Drop anything **older than 12 hours** (see below), then drop ids in the local
   seen-ring, cap at 3 per sweep.
5. Open each survivor's permalink and read the **ancestor chain** — the thread
   root and the last thing *we* said. This is what lets the drafter answer the
   person instead of cold-replying to a fragment.

   **How the focal tweet is located, and why it isn't by id.** On a permalink
   page X renders the focal tweet's timestamp *without* a self-permalink anchor
   — you are already on its page — so its id cannot be read from the DOM at all.
   The ancestors and the replies below it keep theirs. So the focal tweet is
   identified by the **absence** of an id, not by matching the id we navigated
   to (which can never resolve). This is documented in the repo's own captured
   fixture, `tests/fixtures/status-page.html`, and the first implementation got
   it wrong: matching on id meant `harvestThread` returned `[]` for every real
   conversation, and with rule 6 below the sweep would have ingested nothing,
   ever. `tests/fixtures/thread-page.html` now locks the real shape.
6. **Drop anything whose thread it couldn't read.** Two reasons: a context-less
   item drafts a cold reply to a fragment, and — less obviously — the turn cap's
   conversation key is `root:<id>` when the thread reads and `author:<handle>`
   when it doesn't, so filing one would key the same conversation two ways
   across sweeps and let it run to 2× the cap. Nothing is marked seen, so the
   next sweep retries it for free.
7. POST, return to the feed.

### LinkedIn (`linkedin.com/notifications/`)

Same shape, but the classification signal is LinkedIn's **own** machine-readable
`highlightedUpdateType` param on the card's headline link —
`REPLIED_TO_YOUR_COMMENT` and `MENTIONED_YOU_IN_THIS` are replies;
`REACTED_TO_YOUR_COMMENT`, `COMMENT_VIEWS`, `REACTED_TO_COMMENT_MENTIONING_YOU`
and `TOPIC_TRENDING_CONVERSATION_IN_YOUR_NETWORK` are not. Headline prose is the
fallback for cards that carry no type. There is no per-item navigation: the card
already contains their comment, the quoted original post, the commenter's
profile id, and every urn we need. A card with no readable comment text is
dropped rather than filed as a textless lead.

## The 12-hour recency window

Only notifications inside the configured 12-hour recency window are eligible.

The seen-ring answers a different question — *have I already handled this?* — and
on its own it is not enough. It is per-install and starts **empty**, so a fresh
profile's first sweep would treat the oldest thing on the page as brand new.
Both platforms keep days of notifications there. Answering a two-day-old comment
is necro-engagement: the thread has moved on, and a reply arriving that late
reads as a bot working through a backlog rather than a person in a conversation.

Both gates now apply, recency first. `MAX_AGE_MINUTES = 720`, boundary
inclusive.

**The window is enforced in THREE places, and they must agree.** The client's
window is a politeness filter; the **server's is the real gate**, since the
claim RPCs decide what may be drafted and sent regardless of what any browser
harvested. This drifted on day one: the actuators shipped one number while the
server's claim RPC shipped another from a parallel session, the server silently
won, and the operator's setting appeared to do nothing with no error anywhere.

`packages/runtime/src/notificationWindow.ts` (`NOTIFICATION_MAX_AGE_HOURS`) is
now the single source of truth. Two places necessarily hold a copy — the Chrome
extensions (a content script cannot import a workspace package) and the SQL
migrations (a migration is frozen and cannot import) — so
`tests/notification-window-parity.test.ts` in **both** actuators reads the
constant and the newest `notification_window_Nh.sql` off disk and fails if
either has drifted. Changing the window means: edit the constant, add a
migration, done — the tests will tell you if you missed one.

**Why twelve.** Six was the first cut and it worked, but it does not survive a
night: a reply posted at 1am has aged out by the time the first morning sweep
runs, and the sweep is deliberately exempt from the write curfew precisely so
overnight replies are drafted and waiting in the morning. Nine covered a normal
night; twelve covers it with room to spare, and is still far short of
"answering yesterday".

**Where the age comes from differs by platform, and that's the whole
complication.**

| | Source | Shape |
|---|---|---|
| X | `<time datetime>` on the cell | ISO 8601 — parsed directly |
| LinkedIn | `.nt-card__time-ago` | rendered-for-humans text: `6h`, `1d`, `3mo` |

LinkedIn exposes no machine-readable timestamp anywhere on the card, so
`ageMinutesFromText` parses what the card says. Two details are load-bearing:

- **`mo` is matched before `m`.** Otherwise `3mo` reads as three minutes and a
  quarter-old notification sails through the window looking fresh.
- **Every rule is anchored at both ends.** Start-anchoring alone is not a style
  choice, it is a correctness bug: `/^(\d+)\s*s/` reads the Spanish `3 sem`
  (three *weeks*) as three seconds, and `/^(\d+)\s*m/` reads `1 mes` (one
  *month*) as one minute. Both land at "just now", so a months-old thread would
  be answered. The card harvest is language-independent — it keys on
  `highlightedUpdateType`, not on prose — so the sweep really does run on a
  non-English UI even though the rest of the actuator's selectors are English.
  Anchored, every unrecognised form is `null`, i.e. skip.
- **The lookup is class-agnostic**, like everything else in that file. If
  LinkedIn renames `nt-card__time-ago`, `cardAgeMinutes` falls back to a
  structural scan — but that fallback has to be careful in two ways, because a
  degradation that invents a *fresh* age is worse than no fallback at all. It
  skips the human-written subtrees (a reply reading `5 min` is an ordinary
  thing for somebody to say, and must never become the card's age) and takes the
  **last** match rather than the first, since the timestamp renders after the
  comment body on a real card.
- **Only the innermost cards are harvested.** At `cardsIn`'s bare `article`/`li`
  fallback levels, a wrapper element also "contains a notification link" — it
  contains all of them. Harvested, that wrapper is a chimera: one card's
  identity with another card's timestamp, which then dedups the real card away
  by `external_id`. A stale reply wearing a fresh card's age is precisely what
  this window exists to prevent.

**LinkedIn floor-rounds, so its window is `[12h, 13h)` in practice.** A card
reading `12h` is at least 720 minutes old and at most 779; the boundary is
inclusive, so we admit it. X compares exact ISO minutes and is a hard 720. The
two platforms do not mean quite the same thing by "6 hours" and cannot be made
to — LinkedIn does not publish a precise timestamp anywhere on the card.

**An unreadable age is treated as out-of-window.** We cannot prove it is recent,
and only provably-recent things get answered.

### Saying which zero it was

Five different things produce "nothing to do", and they used to render
identically. This string is what the panel shows and what lands in
`noelle.{x,linkedin}_activity.reason`, so it is the first thing anybody
debugging "the agent answered nothing" reads — a line that blames the recency window
for a seen-ring zero sends them straight at the wrong code.

| what happened | what it says |
|---|---|
| page rendered nothing | *(no detail — the caller says "selectors may have drifted")* |
| cards read, none are replies to us | *(no detail — the caller says "read N cards, none are new replies to you")* |
| candidates exist, all older than 12h | `4 replies, none within 12h (4 older, 0 undated)` |
| candidates exist, all already answered | `3 replies within 12h, all already handled` |
| candidates exist, none has a readable age | `no readable timestamp on any of 5 replies — markup may have changed` |

**LinkedIn counts CARDS separately from replies.** Its `harvestNotifications`
returns only reply-type cards, so `harvested === 0` used to be the ordinary
"nobody replied to me in this window" state — most sweeps — while the panel
rendered it as *"page rendered NO notification cards — selectors may have
drifted"*. A healthy install cried wolf every 10-20 minutes, which degrades the
one alarm that should mean something when LinkedIn really does drift. The
content script now reports `cards` (every notification card) alongside `items`
(the replies), and the sweep reports the former. X never had this problem: its
harvest returns every cell, so zero genuinely is a markup break.

Three rules make those honest. The buckets are computed over the **candidates**
(cells that really are somebody replying to us), not over everything harvested —
the notifications page is mostly likes, follows and our own tweets. The candidate total is DERIVED from the buckets rather than passed in
alongside them, so the self-contradicting line that started all this
("3 replies, none within Nh (0 older, 0 undated)") is now unrepresentable. And
the two `undefined` rows matter as much as the strings: returning a detail there would
make the caller's own branches dead code, and one of them is the silent-page
signal added when a non-responding content script was being reported as an empty
inbox.

The fourth row is the **steady state** — an answered reply sits on the page for
hours and every sweep re-reads it — so getting that one wrong would print a
false line every ten minutes forever.

Verified against the real captured page (`tests/fixtures/notifications-page.html`,
6 cards): 2 reply cards, ages **2h** and **1d** — the 2h one is answered, the
1d one is not. Under the old rule both were.

**The tradeoff worth knowing:** age-dropped items are never marked seen, so
nothing is lost *while the sweep is running*. But any coverage gap longer than
12h — Chrome closed for a long weekend, Mac asleep, run stopped — makes those
replies permanently unanswerable. Nine hours was chosen to cover the ordinary
overnight gap; a longer outage still drops whatever aged out during it. That is
intended (a reply answered a day late reads worse than no reply), but it is a
deliberate call, not an accident.

### Comment-level threading (Lyra answers UNDER their comment)

This was the known limitation, and it was worse than a limitation: a
conversation reply posted at post level is not a reply, it is a SECOND
top-level comment from the operator on a thread he already commented on. Five
reached LinkedIn before it was caught.

It works now, and the chain is:

| step | where |
|---|---|
| the sweep captures THEIR comment urn as the lead's `external_id` | `content/notifications.ts` (`commentIdFrom` prefers `replyUrn`, not our own `commentUrn`) |
| api-vm serves it as `target.comment_urn` + `comment_author_name` | `routes/actuator.ts` (`isNotificationLead`) |
| the actuator finds that comment and opens ITS reply box | `content/comment-threading.ts` |
| the dedup exemption is granted ONLY to items carrying a target | `dedupeAlreadyCommented(built, urns, threaded)` |

**The interlock.** Being exempt from "do not comment twice on this post" is
legitimate only when we are not commenting on the post at all. So the exemption
is keyed on `target.comment_urn` being present — and the actuator refuses to
post without one. An item that cannot thread keeps the dedup and is dropped,
exactly as it was while threading did not exist. There is no path where a
conversation reply becomes a top-level comment.

**Three independent guards on the actuation**, because the cost of being wrong
is a public reply to the wrong human under the operator's name:

1. the comment is located by an id anchored on `,<id>)` — `…192` cannot match `…1920`;
2. the composer must BELONG to that comment (no other comment between them),
   because "the first box below the anchor" is another comment's box when the
   target's never opened;
3. the submit must read **"Reply"** (the post composer's reads "Comment"), and
   when the author name is known the box's pre-filled mention chip must name
   them.

Every failure is transient — the draft is retried on a later slot rather than
being published in the wrong place.

The drafter also gets the thread now (`renderConversationBlock`, shared from
`packages/runtime` so it cannot drift between the two interns again). Without it
Lyra had no idea it was mid-conversation and wrote opening remarks into
two-person exchanges.

## Triage — not everything gets a reply

Answering every inbound reply was the wrong default. Most of it is "thanks!" or
an emoji, and answering that is noise that burns write budget and reads exactly
like a bot working through a queue. A few are the opposite: a real opportunity
where an agent answering is actively the wrong outcome.

So every notification lead is triaged **before any retrieval or LLM spend**
(`packages/runtime/src/notificationTriage.ts`, pure + unit-tested):

| Verdict | What happens |
|---|---|
| **reply** | Drafted as normal — it earned an answer. |
| **pin** | **Pushover to the operator, and nothing is drafted.** |
| **ignore** | Lead closed quietly, `skip_reason: triage:ignore:<why>`. |

**Pin** fires on anything that reads like an opportunity: investment,
acquisition, a job or contract, an intro, speaking/podcast, partnership, sales
or pricing, an accelerator or grant, a meeting request, or "I sent you a DM".
Deliberately broad and it beats every other rule — a short "thanks! can we hop
on a call?" is both a pleasantry *and* the single most important thing to
escalate, so opportunity wins. It also beats the turn cap: an opportunity is
never dropped for arriving late in a thread.

Crucially a pin drafts **nothing**. There is no half-written reply left in the
inbox tempting a one-click send on something that needs a human. The push says
so in as many words: *"(no reply drafted — this one is yours)"*.

**Ignore** covers closing pleasantries, emoji-only, anything under 25 characters
that isn't a question, and conversations that have already had their turns.
`prior_turns` is stamped on the lead at ingest (the same count the turn cap
uses), so a long back-and-forth tapers off instead of running flat to the cap.

Pushover goes through each intern's existing per-org notifier, which returns
`no_channel` without throwing when no keys are configured — so an org with no
Pushover setup simply gets no push, never a failed lead.

## The commitment guard — agents never promise anything in your name

A separate, unconditional rule that applies to **every** draft from **every**
intern, not just notifications.

The failure it prevents is silent and expensive: a public reply that says "yes,
let's do a call Thursday" or "I'll send you the deck" creates a real obligation
the operator never agreed to, under their own name, in front of an audience. By
the time they see it the other person is already expecting it.

Two layers, because a prompt rule alone leaks:

1. **`NO_COMMITMENTS_RULE`** is woven into all three interns' system prompts
   (10 prompt variants across Vega, Lyra and Orion). It names every banned
   category and says what to do instead: acknowledge warmly, leave the decision
   open, never invent a yes *or* a no.
2. **`makesCommitment()`** (`packages/runtime/src/commitmentGuard.ts`) checks
   every draft before it can be queued. It catches promised future actions,
   scheduling, acceptance, promised resources, speaking for the operator, and
   deadlines-with-a-promise-verb.

Deliberately **not** folded into the reply-diversity gate: that gate is opt-in
and skipped entirely when there are no priors, and a safety rule that only runs
when an unrelated feature flag happens to be on is not a safety rule.

The guard is narrow on purpose — it is not a politeness filter. "I'll be
honest", "I'll never understand this", "agreed", "they got the green light" all
stay clean, because if ordinary warm replies trip it the drafter starves and
every conversation dies, which is the exact failure this whole feature exists to
fix. The test suite locks both directions.

A committing DM is dropped on its own so it can't take otherwise-good replies
with it. If every reply variant commits, the lead is skipped with a greppable
`commitment:<kind>("<match>")` reason rather than queued.

**Orion (Reddit) matters most here**: a Reddit reply that reaches the approvals
queue is treated as approved and auto-sent — Skip is the only veto — so there is
no human between a committing draft and a public promise.

## `POST /api/actuator/inbound-reply`

Actuator bearer + `instanceId`, same tenancy check as every other actuator
route. Each item becomes one `noelle.leads` row:

| Column | Value | Why |
|---|---|---|
| `external_id` | their reply's id (X: tweet id; LinkedIn: the `replyUrn` comment id) | UNIQUE ⇒ the idempotency key. Re-sweeping is a no-op reported as `duplicate`. On LinkedIn it must be **their reply**, not the `commentUrn` (which is *our* comment) — otherwise every person replying to one comment of ours collides on one id and only the first is ever answered. |
| `status` | `'classified'` | Skips the classifier. Someone talking *to us* is relevant by construction. |
| `priority` | `true` | Bypasses the drafter's classifier-quality and vault-relevance gates. Without it, a conversation reply that doesn't match the vault is silently dropped — the exact failure this feature fixes. |
| `payload.source` | `'notification'` | The marker the drafter and the dedup exemption key off. |
| `payload.conversation` | root + our last turn | Feeds the CONVERSATION prompt block. |

`priority = true` routes these through `claim_watchlist_leads_for_drafting`,
which claims one lead per author and skips authors who already have a pending
reply approval — one live conversation turn per person, for free.

### One batch, one parse

The server validates a sweep's items as a single `InboundReplyInSchema.parse`,
so **one malformed item 400s the whole batch** and loses every other item with
it. The extension therefore clamps at the source rather than relying on luck:

- scraped text is clamped to 4000 chars (X Premium long-form posts reach
  ~25,000 and do appear in replies),
- LinkedIn requires a derivable activity urn instead of falling back to the raw
  href — a real notification link carries `commentUrn`/`dashCommentUrn` tracking
  params and runs past 270 chars, over the 200-char `external_id` limit, and its
  params vary between renders so it is not a stable key either.

A 400 is not silent: it lands in the panel log as `ingest-failed`, and nothing
is marked seen, so the next sweep retries the whole batch.

### Turn cap

Two bots can ping-pong forever. The endpoint refuses to enqueue once a
conversation already has `NOELLE_NOTIFICATION_MAX_TURNS` (default **2**)
notification leads. The conversation key is the thread root when the sweep could
read it, else the person — so a thread whose root didn't render still can't
loop. Setting the env var to `0` disables the ingest entirely; leaving it blank
does **not** (an empty value reads as unset, not as zero).

## Drafting

`renderPrompt` takes an optional `conversationBlock`
(`renderConversationBlock` in `apps/x-intern/src/lib/prompts.ts`), built only
when `payload.source === 'notification'`. It leads the prompt — the model has to
know it is mid-thread before it reads the message, or it drafts an opener. When
the field is absent the prompt is **byte-identical** to today, so no other lane
is affected (there is a regression test asserting exactly this).

A notification lead also produces a DM draft, because that is the drafter's
output contract. X DMs are never auto-sent (`dms: []` in the actuator queue), so
this is harmless noise in the dashboard, not a send risk.

**The block is fenced.** The thread root is untrusted — on a reply to somebody
else's post it is a stranger's verbatim text — and it sits *ahead* of the fence
that guards the post itself. So when `NOELLE_DRAFTER_FENCE` is on, the block
wraps the thread in `<thread_context>` delimiters with a data-not-instructions
guard. Our own reply is fenced too: it can quote them, so it is not a trusted
channel either. (The fence defaults OFF repo-wide, so today the whole prompt is
unfenced; this just means the new block is not the one hole when it is turned
on.)

## The LinkedIn dedup exemption

`dedupeAlreadyCommented` exists to stop two different leads producing two
comments on one post — real spam. But a conversation reply *is* a second comment
on a post we already commented on: we commented, they replied, we answer.
Without an exemption every LinkedIn conversation reply is silently dropped and
the feature does nothing.

So the dedup takes an `exemptLeadIds` set, built by querying which of the leads
about to be served carry `payload.source = 'notification'`. Scoped to **lead
ids**, never urns, so exempting one conversation can never let an unrelated
stale lead through on the same post.

X needs no equivalent: the target there is *their reply's* tweet id, a different
tweet from the one we originally replied to, so `dedupeAlreadyRepliedX` is
already correct.

## Safety rails (all inherited, none new)

Overnight posting curfew · per-hour write ceiling · daily caps · per-tweet dedup
(in-run + server-side) · pre-send approval revalidation (fail-closed) · reply
freshness ceiling · STOP · challenge halt · remote intent switch · the org-wide
panic stop (the queue serves empty when consent is off, so the whole loop
starves).

## Verified against real captured markup

The notification-cell selectors were the risky part. They are now checked
against markup captured from the operator's own logged-in pages on 2026-07-26
(`apps/x-actuator/tests/fixtures/notifications-mentions.html`,
`apps/linkedin-actuator/tests/fixtures/notification-card.html` — anonymized,
SVG noise trimmed, every walked path byte-faithful).

**X passed as written.** Both real cells harvest correctly, including a
multi-handle context ("Replying to @operator and @cleo").

**LinkedIn failed on seven counts**, all now fixed and locked by tests against
both a single card and a full 25-card page capture.

From the full page — the three that mattered most:

| Assumption | Reality |
|---|---|
| a card links to `/feed/update/…` | a **reply** card links to `/feed/?highlightedUpdateUrn=…`. The card filter required the former, so it matched only impressions cards and found **zero replies** — the sweep harvested nothing |
| the comment urn identifies their message | a reply link carries **both** `commentUrn` (OUR comment) and `replyUrn` (THEIRS). Taking the first returned ours, so every different person replying to one comment of ours **collided on a single `external_id`** — only the first would ever be answered |
| `highlightedUpdateUrn` is the post | it is the **notification's own activity**, different for every notification on one thread, which would have defeated the turn cap. The real root is the entity inside the comment-urn tuple |

The page also exposed `highlightedUpdateType` — LinkedIn's own machine-readable
notification type (`REPLIED_TO_YOUR_COMMENT`, `REACTED_TO_YOUR_COMMENT`,
`COMMENT_VIEWS`, `MENTIONED_YOU_IN_THIS`, `REACTED_TO_COMMENT_MENTIONING_YOU`,
`TOPIC_TRENDING_CONVERSATION_IN_YOUR_NETWORK`). That is now the primary signal,
with the headline prose as fallback — far more robust than matching English.
It also settled the last open question: reply cards **do** carry a profile link,
in the left rail as `a[data-view-name='notification-card-image']`,
percent-encoded.

From the single card, four more:

| Assumption | Reality |
|---|---|
| `data-view-name="notification-card"` | it is `notification-card-**container**` |
| headline class `nt-card__text--headline` | it is `nt-card__headline`, and the anchor holds a `.visually-hidden` "Unread notification." that must be stripped — while a `[class*=headline]` fallback also matches the settings dropdown's items |
| post link is an `activity` urn | it is a **percent-encoded `ugcPost`** — `/feed/update/urn%3Ali%3AugcPost%3A…` — so an `/activity[-:](\d+)/` regex matched **nothing** and every real card was skipped |
| the snippet is the longest text | the longest text is the **original post** (1000+ chars); the comment is the body text *outside* `.nt-card-content__body--secondary`. Taking the longest made the drafter answer our own post instead of the person |

It also revealed a bonus: the href's `commentUrn` param carries a **real comment
id**, so a comment *is* addressable. `external_id` now uses it, which
distinguishes two comments by the same person on the same post — the old
(post, person) key collapsed them and the second would never have been answered.
And the card quotes the original post, so `conversation.root_post_text` comes
free with no extra navigation.

Also verified: `harvestThread` against `status-page.html` and `thread-page.html`;
the LinkedIn harvester yields **nothing** on every real non-notifications
fixture; and the ingest's SQL was dry-run against the live `noelle` schema in a
rolled-back transaction.

**Still unverified:** only `readSelfHandle` (X's account-switcher / profile-nav
testids). Everything else in the notification path is now checked against real
captured markup. If the self-handle read fails the sweep falls back to the
Options `selfHandle`, and with neither it reports `self-handle-unknown` in the
panel rather than guessing.

First live run: open the panel log. `notifications: nothing new` on every sweep
while you can see unanswered replies in the tab means a selector drifted.

## Scope

In: replies to us. Out: likes on their comments (the reply-coupled like already
exists behind `cfg.replyAlsoLikes`), standalone mentions, quote posts,
follow-backs, comment-level threading on LinkedIn. Reddit is not included —
Orion auto-sends and has no Full-auto panel.

## Where the code is

| Piece | File |
|---|---|
| Panel buttons | `apps/{x,linkedin}-actuator/src/content/panel.ts` |
| DOM scraping (pure, unit-tested) | `apps/{x,linkedin}-actuator/src/content/notifications.ts` |
| Sweep + cadence | `apps/{x,linkedin}-actuator/src/background/notifications.ts` |
| Run flag + idle hook | `apps/{x,linkedin}-actuator/src/background/{state,index}.ts` |
| Ingest endpoint | `apps/api-vm/src/routes/actuator.ts` (`/api/actuator/inbound-reply`) |
| Contract | `packages/contracts/src/inbound-reply.ts` |
| Prompt block | `apps/x-intern/src/lib/prompts.ts` (`renderConversationBlock`) |
