# Creator voice — platform-native replies for X (Vega) and Reddit (Orion)

**What this is:** the layer that makes Vega's X replies and Orion's Reddit comments
*sound native to the platform* — punchy, short, funny where the post earns it, and
matched to the **energy** of the post they answer. Answering a joke with an earnest
analytical take is the single most obvious "bot in the replies" tell; this feature
kills it by (1) detecting the post's energy and steering the reply's register toward
it, and (2) reading the *other* replies already on the post so the draft mirrors the
room and never echoes a take that's already there.

Modeled on what the LinkedIn intern (Lyra) already does. All of it is **draft-only**
(every reply still goes to the human approval inbox — nothing is auto-posted), every
new fetch is **fail-open**, and every switch **defaults OFF** so an unset environment
is byte-identical to the pre-feature drafter.

## The two levers

### 1. Post energy → register (the "mirror the energy" core)

`detectPostEnergy(postText, { classifierLabel, energyLabel })`
(`packages/runtime/src/register.ts`) classifies a post into one **`PostEnergy`**:

| energy | what it is | register it draws | never draws |
|---|---|---|---|
| `celebration` | a win / launch / milestone | HYPE-dominant, warm short forms | — |
| `joke` | a joke, satire, shitpost, meme, sarcasm | **DEADPAN**, PUNCHY, ULTRA_SHORT, SLANG | HYPE, analytical NORMAL |
| `hot_take` | a spicy / contrarian opinion | PUNCHY, ULTRA_SHORT, DEADPAN | HYPE |
| `vent` | a rant / frustration | SLANG, PUNCHY, NORMAL (commiserate) | HYPE |
| `question` | asking for help / advice | NORMAL, PUNCHY (answer straight) | HYPE, DEADPAN snark |
| `analytical` | the default substantive post | the old neutral set | HYPE |

`DEADPAN` is the new register that carries "answer satire with satire" — a dry,
understated one-liner that beats any analysis. `pickRegisterForEnergy(energy, rng)`
samples from the energy's subset, so **HYPE can only ever land on a celebration** and a
joke can never draw the cold analytical default.

Detection is **label-first**, cheapest-signal-first, and falls open to `analytical`:

1. a persisted `energyLabel` on the lead payload (see the classifier follow-up below),
2. `classifier_label === 'light'` → `celebration` (matches the old `detectPostRegister`),
3. text heuristics: joke → hot_take → vent → question (first match wins),
4. any other non-empty classifier label → `analytical`,
5. no label → `looksCelebratory ? celebration : analytical`.

When energy is on, the drafter also injects a one-line **`POST ENERGY:` hint**
(`renderEnergyHint`) telling the model exactly what to mirror — the strongest, most
reliable lever for "don't answer a joke with philosophy". Analytical posts get no hint
(byte-identical).

The heuristics are deliberately conservative and *additive*: a misfire just picks a
slightly different register and the draft is still human-approved, never posted.

### 2. Sibling comments → "read the room"

Before drafting, the intern fetches the **top other replies on the same post** and
injects a `THE ROOM` digest (`renderCommentDigest`, `packages/runtime/src/commentDigest.ts`).
The framing is dual: **mirror the room's energy** (if the top replies are jokes, be
funny; if technical, be substantive; if venting, don't be chirpy) **and don't echo the
slop** (bare congrats / "so true" / emoji-only are negative exemplars; say the one
thing none of them said). Comments are ranked by engagement, the pure-emoji noise is
dropped when there's enough signal, and each is truncated so the prompt stays bounded.

**Data sources** (fetched at *draft time*, only for claimed leads, never in discovery):

- **X (Vega):** the tweet's replies via X's `conversation_id:<id>` search operator on
  the **same wired kaito Apify actor** discovery already uses (`conversationReplies` in
  `packages/x-apify`). For a top-level post the lead's `external_id` *is* the
  conversation root id. ~`$0.00025`/reply (pay-per-result), so ~`$0.004`/lead — noise
  against the shared pool. Metered as `engine='apify' worker='drafter'`; rotates the
  same token pool with the same fail-open exhaustion handling.
- **Reddit (Orion):** the thread's top comments via Reddit's **free public `.json`
  endpoint** (`https://www.reddit.com/comments/<id>.json?sort=top`), no token and **no
  Apify spend** (`fetchRedditPostComments` in `packages/reddit-apify`). Runs from the
  Mac's residential IP; fails open to `[]` on any 429 / 403 / timeout / bad shape.

If the fetch returns nothing or errors, the block is simply omitted and drafting
proceeds exactly as today.

## Switches (all default OFF, fail-open)

| env flag | effect |
|---|---|
| `NOELLE_DRAFTER_ENERGY` | energy-aware register pick (with `NOELLE_DRAFTER_VARIETY`) **+** the `POST ENERGY:` hint |
| `NOELLE_DRAFTER_COMMENT_ENERGY` | the sibling-comment `THE ROOM` fetch + digest |
| `NOELLE_DRAFTER_COMMENT_MAX` | max sibling comments fetched + shown per lead (default 12) |

Set on both the `x-intern` and `reddit-intern` workers. `NOELLE_DRAFTER_VARIETY`
(existing) gates whether a register block is injected at all; when energy is on, that
register pick becomes energy-aware instead of blind.

**To make it live** (draft-only, so low-risk): set `NOELLE_DRAFTER_ENERGY=1` and
`NOELLE_DRAFTER_COMMENT_ENERGY=1` (and `NOELLE_DRAFTER_VARIETY=1` for the register
variety) in the intern workers' runtime env, then restart the workers. The always-on
SYSTEM-prompt copy ("a `POST ENERGY:` line / a `THE ROOM` block may appear …") is inert
until the aids are actually present.

## Architecture notes

- **Single source of truth.** The register set, `PostEnergy`, `detectPostEnergy`,
  `pickRegisterForEnergy`, `renderEnergyHint`, and `renderCommentDigest` all live in
  `@noelle/runtime` (`/register`, `/comment-digest`). Each intern's `lib/register.ts` is
  now a one-line shim re-exporting the shared module — this **replaced** the hand-mirrored
  per-app copies that had drifted (Reddit's was a truncated copy missing energy detection
  entirely). Register/digest tests live in `packages/runtime/src/*.test.ts`.
- **LinkedIn (Lyra) is untouched.** It keeps its own `register.ts` + comment-digest for
  now (it's the in-prod reference). Migrating Lyra onto the shared runtime modules is a
  clean follow-up.
- **Classifier energy (follow-up).** `detectPostEnergy` already reads a persisted
  `payload.energy` label first. Having the classifier emit an LLM-judged energy field
  (it already makes one LLM call per lead) would make detection reliable for subtle
  deadpan satire that the text heuristics miss — and it plugs into the existing hook with
  **zero drafter rework**. Until then, the heuristics + the `THE ROOM` digest + the
  always-on "match the energy" system prose carry the subtle cases.

## Where to look

| file | role |
|---|---|
| `packages/runtime/src/register.ts` | registers, `PostEnergy`, `detectPostEnergy`, `pickRegisterForEnergy`, `renderEnergyHint` |
| `packages/runtime/src/commentDigest.ts` | `SiblingComment`, `renderCommentDigest` (dual framing) |
| `packages/x-apify/src/index.ts` | `conversationReplies` (tweet replies via `conversation_id:`) |
| `packages/reddit-apify/src/index.ts` | `fetchRedditPostComments` (free `.json`, fail-open) |
| `apps/x-intern/src/workers/{drafter,drafter-tick}.ts` | Vega wiring + `renderPrompt` injection |
| `apps/reddit-intern/src/workers/{drafter,drafter-tick}.ts` | Orion wiring + prompt injection |

See also: `docs/vega-account-feeder.md` (the style/voice mixer that stacks on top),
`docs/reddit-intern.md` (Orion operations), `docs/pattern-breaker.md` (cross-post
anti-slop), `docs/x-account-safety.md` (rate/pacing).
