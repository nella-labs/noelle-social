# Reply realism — the house skeleton ban, the no-dots rule, and the human typo pass

Three cross-intern rules that exist for one reason: a machine-perfect, structurally
identical feed reads as a bot no matter how good any single reply is. Both live in
`@noelle/runtime` so Lyra (LinkedIn) and Vega (X) share ONE implementation, and
Orion (Reddit) can adopt either unchanged.

The measurements below are from 688 live reply drafts over the 30 days to
2026-08-24 (`noelle.drafts` joined to `noelle.leads`, `kind='reply'`).

---

## 1. The house skeleton

`packages/runtime/src/houseSkeleton.ts`

**What it is.** Lift a detail out of the post, make it the grammatical subject,
attach your verdict to it.

> "the $0/hour line is doing a lot of work here"
> "the brothers-as-cofounders line is the one i keep chewing on"
> "gm posts are the part i'd cut"
> "clipboard history is the one store that keeps every api key"

**Why it matters.** ~55% of Lyra's replies and ~49% of Vega's opened on this
shape. One narrow sub-frame — `is the <one|part|bit|line|detail|step> i/nobody
<verb>` — was 10.6% of Lyra's feed and 6.1% of Vega's on its own. The two interns
read as the same writer because they were running the same skeleton with
different nouns in it.

**Two layers, on purpose.**

| layer | what | where |
|---|---|---|
| `NO_HOUSE_SKELETON_RULE` | the prompt ban. Structural, so it covers the whole family, and it names the positive rewrite (make yourself / the consequence the subject) rather than only the ban | injected into `SYSTEM_LINKEDIN`, `SYSTEM_LINKEDIN_BASE`, `SYSTEM_LINKEDIN_LIGHT`, `SYSTEM_X`, `SYSTEM_X_BASE` — every REPLY surface, no DM surface |
| `houseSkeletonHits()` | a deliberately NARROW deterministic check on four canned frames, where a regex can be confident. Catches ~16% of Lyra's and ~11% of Vega's live drafts | `scoreFormat` in `drafting/draftVerifier.ts` |

The deterministic penalty is **0.4** (stacking +0.3, capped 0.9), sized above the
soft tier (`AUTO_PATTERN` / `HONESTLY` = 0.3, which one hit survives): one canned
frame should drop below the pass bar and regenerate. It is **not** a hard zero —
the check is lexical, so a rare sentence where the frame genuinely is the right
words can still win best-of-set. Replies only; a DM is a different register.

Broad structural detection stays the LLM judge's job. A wide regex here would
fire on legitimate sentences.

**Two directives were also retuned**, because they were *prompting* the skeleton:

- `OPENING_MOVES.DETAIL` — was "point at one concrete detail and what it
  implies", now "name the detail, then say what it means FOR YOU or what it would
  cost", with the verdict frame explicitly banned.
- `FORM_VARIANTS.DETAIL_ZOOM` (both platform sets) — was "say why it stuck with
  you" (which produces "X is the part that stuck with me"), now "say what it
  would MEAN or COST in practice… put yourself or the consequence in the
  predicate".

---

## 2. No full stops

`stripSentencePeriods` in `packages/runtime/src/voiceSanitize.ts`,
`NO_PERIODS_RULE` in `packages/runtime/src/replyPolish.ts`

The operator does not want a single dot in a public reply. A period is the
punctuation of written prose; these are meant to read as someone typing on a
phone.

Two layers, same shape as the em-dash rule. `NO_PERIODS_RULE` goes in the prompt,
because a sentence WRITTEN to end in a period and then shaved still reads like
prose (the clause structure is unchanged), and it hands the model the alternative
the operator actually uses: a comma and a connector, or a line break.
`stripSentencePeriods` is the backstop.

**"Sentence-ending" is load-bearing.** A blind strip turns `$0.66` into `$066`. A
dot is removed only when what FOLLOWS it is whitespace, end-of-string, or a
closing bracket/quote before either. Everything living inside a token survives:

| survives | example |
|---|---|
| decimals | `$0.66`, `9.0`, `3.5 stars` |
| versions | `qwen 3.8` |
| domains + URLs | `getnella.dev`, `https://x.com/foo` |
| ellipsis | `…`, and `...` collapsed whole rather than halved to `..` |

Question marks and exclamation marks are untouched: the ask was dots, and a reply
that cannot ask a question is a different instruction. Replies only; a DM keeps
its punctuation.

---

## 3. The human typo pass

`packages/runtime/src/humanTypos.ts`, wired into
`packages/runtime/src/outboundClient.ts`

On **18% of reply drafts**, introduce exactly ONE small, believable typing slip.

| kind | weight | example |
|---|---|---|
| `DROP_WORD` | .24 | a skipped function word (the, a, to, of, is, it, that…) |
| `DROP_APOSTROPHE` | .16 | `it's` → `its`, `don't` → `dont` |
| `KEY_NEIGHBOR` | .13 | a letter swapped for a same-row QWERTY neighbour (`queue` → `qurue`) |
| `TRANSPOSE` | .12 | two adjacent letters swapped |
| `DROP_LETTER` | .12 | a doubled letter halved (`really` → `realy`) |
| `DOUBLE_WORD` | .09 | a short word repeated |
| `MISSING_SPACE` | .08 | two short adjacent words run together (`of the` → `ofthe`) |
| `DOUBLE_LETTER` | .06 | a key held a beat too long (`batch` → `baatch`) |

The first five were all one FAMILY of mistake — something is missing, or
something is duplicated — which across a feed reads as a single tic. The last
three are the phone-specific ones: a thumb landing one key off, a missed space
bar, a held key.

**Why 18% and not 10%.** The nominal rate overstates the real one. The
MIN_WORDS / MIN_CHARS floors below decline every MICRO, ONE_SHORT and RIFF
reply, and those are about a third of the X shape rotation by weight, so 18%
nominal lands nearer 12% actual across a real feed.

Two constraints the new kinds carry:

- `KEY_NEIGHBOR` uses SAME-ROW neighbours only, never the row above or below: a
  thumb slides sideways far more often than it jumps rows, and a vertical miss
  (`hello` → `hetlo`) reads as a corrupted string rather than as typing. It also
  never touches a word's FIRST letter, which is what a reader uses to recognise
  the word.
- `DOUBLE_LETTER` rejects any word that already contains a double, so doubling an
  interior letter can never produce a triple. The first version of that guard
  only scanned from index 1, so a word with a front double (`aardvark`) became
  `aaardvark`.

**Rules the design holds to** (a typo pass that gets these wrong is worse than
none):

- **ONE slip per body, never two.** Two in a 150-char reply reads as broken.
- **Replies only.** A DM is a cold first touch; a typo there costs more than the
  realism buys. `kind: 'dm'` passes through untouched.
- **Never a token a typo would corrupt.** `isSafeToken()` is an ALLOWLIST —
  lowercase ASCII plus an apostrophe — so @handles, #hashtags, URLs, domains
  (`getnella.dev`), numbers, emoji, and every capitalised proper noun (`Nella`)
  are excluded by construction, not by a denylist someone has to maintain.
- **Never the first or last token.** A mangled opening word reads as a broken
  bot; a slip mid-sentence reads as a thumb.
- **Never on a short reply** (< 7 words or < 40 chars). "eaten by wolves is wild"
  → "eaten by wolves wild" is a malfunction, not a typo.
- **Length-capped.** X hard-rejects a reply over 280 chars, so a mutation that
  grows past the cap is discarded rather than shipped. `charCount` is recomputed
  off the mutated body.

**Where it runs, and why there.** Every draft from every intern crosses
`createOutboundClient().postOutbound` exactly once on its way to the approval
queue. That placement means it runs **after** the verifier and the reply-diversity
gate (so a graded draft is never penalised for a slip we introduced on purpose)
and **before** the approval row is written (so the operator reviews the exact text
that will be posted, typo included, instead of approving clean copy that mutates
on send).

### Switches

| env | default | meaning |
|---|---|---|
| `NOELLE_HUMAN_TYPOS` | on | set to `0` to disable the pass entirely |
| `NOELLE_HUMAN_TYPO_RATE` | `0.18` | share of replies that get one slip (0..1). A malformed value falls back to the default rather than silently disabling |

Read on every post, so the rate can be retuned without a redeploy. Callers can
also pass `typoRate` to `createOutboundClient` (tests do).

---

---

## The order

Both deterministic transforms run through `polishReplyBody`
(`packages/runtime/src/replyPolish.ts`), called by the outbound client and by the
backfill script, so the live path and the backfill cannot drift.

**Periods first, typos second, and the order is load-bearing:** the typo pass
budgets against the platform character cap and picks a token to mutate, so it has
to see the final text rather than characters that are about to be deleted.

The slip rate does not gate the whole pass. `NOELLE_HUMAN_TYPO_RATE=0` disables
the typing slip only; the full-stop strip is a hard voice rule.

## Where to look

| what | file |
|---|---|
| The skeleton ban + narrow detector | `packages/runtime/src/houseSkeleton.ts` |
| The full-stop strip | `packages/runtime/src/voiceSanitize.ts` |
| The polish pass (order of transforms) | `packages/runtime/src/replyPolish.ts` |
| Backfill for the already-written queue | `scripts/backfill-reply-polish.mjs` |
| Deterministic penalty | `packages/runtime/src/drafting/draftVerifier.ts` (`scoreFormat`) |
| Typo pass | `packages/runtime/src/humanTypos.ts` |
| Where the polish runs | `packages/runtime/src/outboundClient.ts` |
| Shape rotation (the other half of "stop reading as one mold") | `packages/runtime/src/formVariants.ts`, `docs/linkedin-intern.md`, `docs/vega-account-feeder.md` |
