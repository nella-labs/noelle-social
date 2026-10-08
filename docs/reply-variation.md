# Reply variation — the shape rotation, the tone-first split, and the gen-z marker lane

**Read with:** `docs/reply-realism.md` (the house-skeleton ban, the no-dots rule,
the typo pass), `docs/creator-voice.md` (energy mirroring), `docs/pattern-breaker.md`.

Issue #557. The complaint was that all three interns read as one writer, and it
was not only about length: the replies were uniformly clean, uniformly
mid-register, and uniformly the safest correct take.

## The stack a reply is squeezed through

Every drafted reply is specified by a stack of directives. Knowing the whole
stack matters, because a change to one layer is silently cancelled by another —
that is how the tone-first lane sat shapeless for months without anyone noticing.

| layer | where | what it fixes |
|---|---|---|
| post energy (6) | `runtime/register.ts` | celebration / joke / hot_take / vent / question / analytical |
| register (6) | `runtime/register.ts` | ULTRA_SHORT, HYPE, SLANG, PUNCHY, DEADPAN, NORMAL |
| energy → register subsets | `ENERGY_REGISTERS` | each energy samples 3-4 of the 6 |
| form shape (12) | `runtime/formVariants.ts` | MICRO … THREE_BEAT; three sets — `FORM_VARIANTS` (Lyra), `X_FORM_VARIANTS` (Vega), `REDDIT_FORM_VARIANTS` (Orion) |
| shape rotation | `createFormVariantRotation` | no shape repeats within the last **3** |
| energy → shape subsets | `ENERGY_SHAPE_IDS` | which shapes can carry which energy |
| register XOR shape | the drafters | one length authority per prompt, never two |
| opening move (5-6) | `runtime/openingMove.ts` | Vega + Orion: only for shapes that leave the opener free. **Lyra: only when NO shape was assigned at all** |
| gen-z marker | `runtime/genzMarkers.ts` | word choice, on a minority of replies |
| length budget | `SYSTEM_X_BASE` | 40-120 target, 150 ceiling — a shape overrides both |
| NO_PERIODS_RULE | `runtime/replyPolish.ts` | no full stops in a public reply |
| NO_HOUSE_SKELETON_RULE | `runtime/houseSkeleton.ts` | no "their detail is the subject, your verdict is the predicate" |
| NO HOUSE FORMULA | the drafter prompts | five named sentence shapes, banned as shapes |
| banned openers + softeners | the drafter prompts | ~20 phrases |
| reply memory | `priorReplies` + `recentPhrasings` | avoid-list of the last ~20 |
| diversity gate | `x-intern/lib/reply-diversity.ts` | trigram Jaccard ≥ 0.5 rejects |
| verifier | `runtime/drafting/draftVerifier.ts` | best-of scoring |
| typo pass | `runtime/humanTypos.ts` | 18% of replies, 8 slip kinds, ONE per body |

## What #557 changed

### 1. Rotation memory: 1 → 3

`createFormVariantRotation` excluded only the PREVIOUS shape. That stops the
literal double and permits A/B/A/B — and on X the two heaviest weights are MICRO
and RUN_ON, so the legal alternation was between a one-word reply and a 200-char
run-on. Measured on the real X set: **11 four-long alternating runs per 1000
picks at memory 1, zero at memory 3.**

The window is clamped inside `next()`, not in the closure, because the per-call
lane exclusion is only known there. It drops the OLDEST remembered shapes until
at least 2 candidates remain.

> That clamp is load-bearing. `pickFormVariant` falls back to the FULL variant
> list when exclusions empty the pool, so an over-wide window would not throw —
> it would quietly resample everything and reintroduce the repeats the window
> exists to prevent, with every window test still green.

### 2. The tone-first lane is no longer shapeless

> **This one is gated behind `NOELLE_DRAFTER_ENERGY`, which is OFF in prod.**
> Without it `postEnergy` is null, there is no tone-first lane at all, and every
> lead already takes an ordinary rotating shape. The change below is what
> happens once energy detection is turned on. The rotation-memory widening, the
> marker lane and the typo changes are not gated and apply today.


Four energies (joke, celebration, vent, hot_take) are treated as "tone first"
and were handed a REGISTER and **no shape at all**. Those four are a large share
of leads, so the loudest part of the feed was also its most uniform: tone varied,
form did not.

Now `TONE_FIRST_SHAPE_SHARE` (0.5) of them take a shape drawn from
`ENERGY_SHAPE_IDS[energy]` instead. The energy HINT is injected either way, so
tone mirroring never depends on which side of the split a lead lands on.

The exclusions in that table are its content:

- **celebration** drops `FLAT_DISAGREE` and `DETAIL_ZOOM` — you cannot disagree
  with someone's launch, and grading a detail of it is not a congrats.
- **vent** drops `RIFF` (joking at someone venting), `FLAT_DISAGREE`, and
  `QUESTION_ONLY` (they are not asking).
- **joke** keeps only shapes that can be funny.
- **hot_take** keeps the flat, declarative ones.

Both helpers fail OPEN: an unknown energy, or a subset resolving to under 3
shapes against a platform's own variant list, returns everything.

### A caveat on Lyra's opening move

Vega and Orion gate the opening move on `SHAPES_WITH_FREE_OPENER`, so a shaped
lead can still get one when the shape does not prescribe its own opener. Lyra
gates on `!formVariant` alone — she never emits an opening move alongside a
shape, whatever the shape is.

This change WIDENS that gap, because it shapes many more of her leads than
before. It is left as-is rather than quietly aligned: her opening-move block is
suppressed together with the register on the same condition, and untangling the
two is a separate change with its own risk. Worth doing, not worth smuggling
into this PR.

### 3. Orion gets the shape lane he never had

Reddit had NO form variation — every comment in the same default 1-4 sentence
band, only the register varying. He now runs `REDDIT_FORM_VARIANTS` with the
tone-first split and the opening-move filtering.

That set is X's shapes with **one** change, and the reason is consequence rather
than taste: **a Reddit reply reaching the approvals queue is auto-sent** (Skip is
the veto). There is no human between the draft and the subreddit. X's `MICRO`
licenses a one-word reply and is the heaviest weight in the set, so it would have
been the most common thing Orion said — and a one-word drive-by auto-posted is
what automod removes. Reddit's `MICRO` takes a floor of three words and drops
from .12 to .05, with the freed weight going to the mid-length shapes Reddit
rewards. Every other shape is X's, because both rooms reward the two moves
LinkedIn punishes: being funny, and disagreeing flat.

While wiring it, his local **copy** of the opening-move set turned out to have
drifted. Its `DETAIL` move still read "point at one concrete detail from the post
and what it actually implies" — the phrasing that predates the house-skeleton
work, and the one that teaches a drafter to make a detail from the post the
subject of a verdict. Vega and Lyra got the corrected directive; Orion never did,
because his copy was never wired to the shared module. It is now a re-export
shim, like his `register.ts`.

### 4. The gen-z marker lane

The ask was gen-z wording, with the failure mode named in the same breath:
*"don't overdo it, it looks more ai that way"*. A prompt rule cannot be measured,
so this is a lane with three properties:

1. **Rate-gated.** 22% of replies get a marker block at all; the rest are drafted
   exactly as before.
2. **One, and optional.** A reply that gets the block gets ONE marker and explicit
   permission to drop it when it does not fit. Two markers is the tell; a
   wedged-in marker is the other tell. So the share that actually SHIP one is
   lower than 22%.
3. **Tiered, and fail-safe.** `plain` markers (ngl, tbh, idk, kinda, lowkey,
   "why is X like this") are ordinary spoken English and land anywhere. `loud`
   markers (cooked, peak, unserious, deadass, "not me …ing", "the way …") are
   performative and are unreachable on a **vent**, a **question**, *or an
   UNKNOWN energy*.

   That last case is the load-bearing one, not an edge case. `postEnergy` is
   null whenever `NOELLE_DRAFTER_ENERGY` is off — its default, and its state in
   the live ecosystem config — so a gate that only fired on a KNOWN vent would
   never fire in production, and "cooked" would land under someone's layoff
   post, auto-sent, on Reddit. Without a signal we cannot know we are *not*
   under a vent, so the absence of the signal means the same thing as the
   signal. The loud tier needs a POSITIVE reading that the room can carry it.

Three context-guarded conversational moves sit beside those tiers. One pairs a
brief acknowledgement with a post-specific reason. One uses direct address only
when the name or term is supplied by the profile, post, or conversation; it
never guesses identity or gender. One adds a short tag question only when its
referent is clear. Together they carry 0.32 of the marker-catalog weight. With
the 22% outer gate, they are offered on roughly 7 to 10% of replies; the drafter
can still drop one when it does not fit, so actual use is lower.

`plainOnly` is a PLATFORM policy, separate from post energy. **Lyra gets the six
universal plain markers plus the three guarded conversational moves. Vega gets
all 12 universal markers plus those moves. Orion keeps the universal 12-marker
pool**, so Reddit's behavior does not change.

The cosplay tier is deliberately absent and the rendered block restates its ban,
so the block cannot be read as licence: **no cap, rizz, it's giving, fr fr,
based, slay, bussin, ate** stay hard-banned in the prompts. Those are the ones
that read as an adult imitating a teenager, which is worse than corporate.

The marker block is NOT suppressed when a shape is assigned, unlike the register
and opening-move blocks. It governs word choice, not length, so it cannot
contradict a shape.

### 5. Typos: 10% → 18%, 5 kinds → 8

See `docs/reply-realism.md` § 3.

### 6. The emoji rule's second half now has a backstop

The rule always had two clauses — an emoji only when the post itself uses one,
AND only from the allowlist — but only the allowlist half was enforced
deterministically. `stripDisallowedEmoji` now takes the post text and strips
every emoji, allowlisted included, when the post carries none. The gate is "did
they set an emoji register", not "did they use one of ours", so answering a 🚀
post with 💀 is kept.

## Switches

| env | default | meaning |
|---|---|---|
| `NOELLE_DRAFTER_VARIETY` | on | the shape / register / opening-move lanes |
| `NOELLE_DRAFTER_ENERGY` | see runbook | post-energy detection; without it there is no tone-first lane at all |
| `NOELLE_GENZ_MARKERS` | on | set to `0` to disable the marker lane entirely |
| `NOELLE_GENZ_MARKER_RATE` | `0.22` | share of replies offered a marker (0..1). A malformed value falls back to the default rather than silently disabling |
| `NOELLE_HUMAN_TYPOS` | on | set to `0` to disable the typo pass |
| `NOELLE_HUMAN_TYPO_RATE` | `0.18` | share of replies that get one slip |

## Measuring a change here

`scripts/reply-variation-sim.mjs` replays Vega's X directive assignment over a
seeded lead sequence under two rule sets and reports the distributions. It opts
into the same X marker pool as the live worker. Run it before and after any
change to these lanes.
