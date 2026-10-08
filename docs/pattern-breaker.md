# Pattern Breaker

The Pattern Breaker is the **cross-post sibling of the per-draft verifier**
(`packages/runtime/src/drafting/draftVerifier.ts`). The verifier grades ONE
draft against a HARDCODED slop list. The Pattern Breaker reads the operator's
**last N posts as a corpus** (10/20/30/40/50/100), finds STRUCTURAL habits that
repeat too often — the "wall of text → tiny congrats" two-beat, a repeated
opener, the same rhythm — and writes them back as **DB-backed rules the drafter
and verifier consume dynamically**, instead of someone hand-editing
`SLOP_PHRASES`. It then alerts the operator on the approvals page.

## Why it exists

`draftVerifier.ts:93` literally quotes the operator: `"sentence. small phrase."
repeats SO much`. That catch is hardcoded. The Pattern Breaker DISCOVERS new
over-used patterns from the real corpus so the system keeps learning the
operator's tics without a code change.

## Data model (migration 0062, `suggestion` added in 0081)

- **`noelle.pattern_rules`** — machine-consumed. Active rows are injected into
  the drafter system prompt and the verifier's checks.
  - `kind`: `phrase` (a regex — a dynamic `SLOP_PHRASES` entry) or `structure` (a
    shape a regex can't express — folded into the LLM judge's voice score + the
    drafter prompt).
  - `label` (dedup key), `instruction` (the NEVER-DO line), `suggestion` (the
    positive "do this instead" mirror — nullable, migration 0081), `regex`,
    `severity`, `active`, `source` (`auto` | `refined` | `manual`).
  - **Enforcement scales with `source`.** An `auto`-detected `phrase` rule is a
    SOFT penalty in the format check (an occasional reuse still clears the bar) —
    the operator wanted variety nudges, not forever-bans, and the feed-wide
    [diversity check](#feed-wide-diversity-check-the-global-sibling) does the real
    anti-repetition work. Operator-confirmed rules (`refined` / `manual`) stay a
    deterministic **hard-zero**.
- **`noelle.pattern_alerts`** — operator-facing. The approvals-page popup.
  - `pattern_name`, `description`, `window_size`, `frequency_count`, `examples`,
    `refine_note`, and `status`:
    `open → refining → refined`, or terminal `reverted` / `acknowledged`.
    The popup shows `open | refining | refined`.

## Pipeline

```
last N posts ──▶ analyzePatterns (LLM) ──▶ for each NEW pattern:
 (drafts.sent_at +                            • pattern_rules (active)   ─┐
  published post_drafts)                      • pattern_alerts (open)     │ drafter + verifier
                                              • bus 'pattern.detected'    │ read active rules
                                              • best-effort vault note   ─┘ next tick
```

1. **Analyze** — `packages/runtime/src/patternBreaker/analyze.ts`
   (`analyzePatterns`). Pure, LLM injected as a closure (mirrors the verifier's
   `VerifierCall`). The LLM proposes findings; for `phrase` findings with a
   compilable regex we **recount matches deterministically across each window**
   (10/20/…/100) and keep the tightest window where the phrase clears the count
   + ratio floors — so "over-used" is grounded in the real corpus, not the
   model's guess. `structure` findings must supply an `evidence` array with a
   numeric `sourceIndex` and an exact nonempty snippet for every counted post.
   The analyzer checks each snippet against its source (normalizing whitespace),
   rejects invalid references and duplicate evidence, and recomputes the count
   and tightest qualifying window. An unsupported model `frequencyCount` cannot
   create a rule. The semantic match remains an LLM judgment; verified snippets
   make that judgment traceable, not objectively proven. Display examples come
   from verified source matches and carry real draft IDs. Examples rebuilt from
   regex matches keep at most 600 characters of the exact matched source text;
   truncation does not change the count or add invented text. Bad regex findings
   degrade to `structure` only if they satisfy this same evidence gate. Dedups vs
   active labels. Each finding also carries `suggestion` — the positive "do this
   instead" mirror of the NEVER-DO `instruction`, generated in the same call.

   Structure includes repeated sequences of ideas or endings even when the
   wording changes. New findings stay scoped to a demonstrated habit and give a
   positive revision direction. The StoryScope rule register
   explains the fiction-to-social adaptation; its detector feature rates do not
   replace this product's count/share thresholds. No additional model call or
   database migration is required.
2. **Persist + announce** — `runPatternBreakerTick`
   (`apps/linkedin-intern/src/workers/pattern-breaker-tick.ts`; the same pass is
   ported per intern — `apps/x-intern/...` for Vega and
   `apps/reddit-intern/...` for Orion, each with its own routing/role). Per NEW
   pattern: upsert rule + open alert (`persistPattern`, which stores
   `suggestion` too), emit `pattern.detected`, best-effort vault note.
3. **Consume** — the drafter loads active rules once per tick
   (`loadActivePatternRules`, carrying `source` + `suggestion`) and threads them
   into BOTH the system prompt (`renderPatternRulesBlock` → "BREAK THESE REPEATED
   PATTERNS", where a rule with a suggestion renders as `- <ban> → instead:
   <suggestion>`) AND `VerifyContext.dynamicBannedPatterns` (auto phrase → soft
   penalty, refined/manual phrase → hard-zero, structure → tanks voice; the
   suggestion steers the prompt only, it is not scored).

## Operator loop (approvals popup)

`PatternAlertBanner` shows over the approvals page: the habit, how often it
showed up (N of last M posts), an example, a **"TRY INSTEAD"** block with the
rule's positive `suggestion` (shown between the flagged example and the buttons;
omitted when the rule has no suggestion), and the live rule. The rule is
ALREADY active, so the buttons act on it:

- **Revert** — deactivate the rule (drafting reverts), close the alert.
- **Refine** — "refine with AI". ENQUEUES a rewrite (`status → refining`,
  optional steer note). The worker drains the queue (`runPatternRefineTick`,
  `refineRule`) on the **fast drafter cadence** so the refined rule appears
  shortly; the popup auto-refreshes. Consistent with how "Generate post" flips a
  status for the worker rather than calling an LLM in the CRUD API. Refine
  rewrites the NEVER-DO `instruction` only — the `suggestion` is minted at
  detection and left as-is (narrowing a ban rarely invalidates the positive
  direction).
- **Keep** — acknowledge, dismiss the popup, keep the rule.

API: `apps/api-vm/src/routes/pattern-alerts.ts` (JWT, org-membership checked) —
`GET /api/pattern-alerts?instanceId`, `POST :id/revert|refine|acknowledge`.
Server actions: `apps/app/.../approvals/actions.ts`. Page read:
`queries.listVisiblePatternAlerts` (direct Cloud SQL, fail-open).

## Configuration (default OFF)

The drafter worker runs the Pattern Breaker only when enabled:

| env | default | meaning |
|---|---|---|
| `LINKEDIN_PATTERN_BREAKER` | off | master switch for Lyra (drains refine queue + runs analysis) |
| `REDDIT_PATTERN_BREAKER` | off | master switch for Orion — same pass inside the reddit drafter worker; the `pattern_rules`/`pattern_alerts` tables, dashboard patterns panel, and agent-page card are instance-scoped and platform-agnostic, so they work for Orion with zero dashboard changes |
| `X_PATTERN_BREAKER` | off | master switch for Vega — same breaker, ported to `apps/x-intern` (corpus = sent X replies + published posts; rules feed the reply drafter's system prompt + verifier). Keep OFF until the dashboard Pattern Breaker panel is in view: auto-learned rules reshape replies X autosend can post unattended |
| `PATTERN_BREAKER_INTERVAL_MS` | 6h | min gap between full analyses, per instance |
| `PATTERN_BREAKER_MIN_FREQUENCY` | 3 | min matches in a window to flag (also corpus floor) |
| `PATTERN_BREAKER_MIN_RATIO` | 0.3 | min share of the window a pattern must cover to count as over-used (phrase + structure); a tic in 5 of 100 posts (5%) is not flagged |
| `PATTERN_BREAKER_MAX_POSTS` | 100 | largest analysis window / corpus cap |
| `LINKEDIN_DRAFTER_RECENT_PHRASINGS_TOPK` | 20 | last-N replies for the avoid-list + diversity check (0 disables both) |

The diversity check rides the verifier (`NOELLE_DRAFTER_VERIFY`), independent of
the `LINKEDIN_PATTERN_BREAKER` master switch above.

The AI-refine queue drains every drafter tick (cheap, no-op when empty); the
heavier analysis runs at most once per interval. Both fail-soft — any error is
logged and the drafter tick still succeeds. The `PATTERN_BREAKER_*` knobs are
shared by both interns' workers (same names, same defaults).

For Orion the corpus is its sent reply drafts (keyed on `approvals.status='sent'`,
which the actuator sets via mark-sent when it posts a reply — not `drafts.sent_at`);
it has no posts lane, so the `post_drafts` leg of the corpus union is empty. Active rules are
threaded into both the substantial and light reddit system prompts
(`renderPatternRulesBlock`) and into `VerifyContext.dynamicBannedPatterns`.

The X port lives in `apps/x-intern/src/lib/pattern-breaker-db.ts` +
`apps/x-intern/src/workers/pattern-breaker-tick.ts` and shares the same
`noelle.pattern_rules` / `noelle.pattern_alerts` tables (keyed by
`agent_instance_id`, no migration). The `PATTERN_BREAKER_*` tuning knobs are
deliberately the same env names for both interns; only the master flags are
per-platform. The dashboard `/patterns` subpage + Pattern Breaker card work for
both interns.

## Per-person repetition check (the per-person sibling)

The cross-post breaker above asks "am I over-using a structure across ALL my
posts?". Its per-person sibling asks "am I repeating myself to THIS person?" —
and it runs as a **verifier dimension**, not a corpus audit, because it must act
on a single draft before it's queued.

- `getRecentRepliesToAuthor` already fetches the replies the operator has sent
  this person (the drafter injects them as a passive "don't repeat" block). This
  check adds **enforcement**: those prior replies are passed into the verifier as
  `VerifyContext.priorRepliesToPerson`, and the judge grades a `novelty`
  dimension — does the draft rehash a point/angle/phrasing already used with
  them?
- A redundant draft scores low on `novelty`, fails the verdict, and the drafter
  **regenerates** with a "you already told them X; take a different angle" fix —
  reusing the existing regenerate loop (`runVerifyLoop`).
- Fully back-compat: `novelty` is forced to 1.0 on first contact (no prior
  replies), a failed judge, or empty history — a first reply is never penalized.
  No extra LLM call: it folds into the existing single judge call.

See `packages/runtime/src/drafting/draftVerifier.ts` (`priorRepliesToPerson`,
`DimensionScores.novelty`).

## Feed-wide diversity check (the global sibling)

Where `novelty` asks "am I repeating myself to THIS person?", **diversity** asks
"do my last ~20 replies across the WHOLE feed look nothing alike?" (operator:
*"make sure the 20 last replies are nothing alike or at least try"*). It is the
**enforcement leg** of the drafter's recent-phrasings avoid-list, and the
day-to-day mechanism that replaces forever-bans with variety.

- `getRecentReplyPhrasings` already fetches the operator's most recent reply
  bodies across all authors (the drafter injects them as a passive avoid-list).
  This passes the same list into the verifier as `VerifyContext.recentReplies`.
- A **deterministic** `diversity` dimension (`replyDiversityScore`, no LLM) scores
  each reply-kind draft against that window: opener overlap blended with
  word-trigram phrasing overlap, `score = 1 - max similarity` to any recent reply.
  A near-verbatim repeat or a reused opener/template scores low.
- A low-diversity draft fails the verdict and the drafter **regenerates** with a
  "take a different shape — change the opener, length, rhythm, phrasing" fix,
  reusing the existing `runVerifyLoop`. Bounded by the verify retry budget — *"or
  at least try"*: it takes the best after N attempts rather than looping forever.
- Fully back-compat: `diversity` is forced to 1.0 when there's no recent history;
  DM / repost drafts are exempt. No extra LLM call. Disable by setting
  `LINKEDIN_DRAFTER_RECENT_PHRASINGS_TOPK=0`.

See `packages/runtime/src/drafting/draftVerifier.ts` (`recentReplies`,
`replyDiversityScore`, `DimensionScores.diversity`).

## Draft-only invariant

The Pattern Breaker writes anti-pattern rules + operator alerts only. It never
writes a lead and never a platform write — it runs inside the drafter worker
with no own entrypoint, and `apps/linkedin-intern/src/invariants.test.ts` /
`apps/reddit-intern/src/invariants.test.ts` guard that there is still NO send
worker on either intern.
