# Context-led writing structure

Noelle uses one short editorial contract from
`packages/runtime/src/writingStructure.ts`. It guides what a draft says and how
its ideas connect before applying the existing surface-format rules.

## Generation coverage

| Surface | Builder |
|---|---|
| X replies and lead DMs | `apps/x-intern/src/lib/prompts.ts` legacy and brand systems |
| LinkedIn replies, light replies, lead DMs, intro DMs and ladder DMs | `apps/linkedin-intern/src/lib/prompts.ts` |
| VIP intro DMs | `apps/linkedin-intern/src/lib/vip-dm.ts` |
| Reddit substantial and light replies | `apps/reddit-intern/src/lib/prompts.ts` |
| X and LinkedIn original posts | `apps/linkedin-intern/src/lib/post-drafter.ts` |
| X and LinkedIn ideas | Each intern's `src/lib/ideation.ts` |
| Content idea refinement | `apps/linkedin-intern/src/lib/idea-polish.ts` |
| Nova video ideas and scripts | `apps/video-intern/src/lib/video-generate.ts` |

LinkedIn post generation no longer requires a follow ask/sign-off, manufactured
tension, repeated central detail, or a fixed short/long sentence quota. A thin
fact can remain a brief post. A follow ask belongs when the operator's guidance
explicitly requests it. First-person voice remains available for supported
personal claims; it is not a required opening for every post or idea.

When an account count is missing, X omits the unsupported self-claim. It no
longer substitutes a qualitative claim such as having very few followers.
Refinement keeps the source idea's qualifications, attribution and uncertainty.

## Review and learning

The existing [draft verifier](grounded-drafting.md) and Nova script judge apply
structure guidance within their existing scores. The reply judge receives
bounded recent-feed evidence for public replies to distinguish a repeated idea
sequence from simple word overlap. DM-only and repost-only reviews omit that
feed history; mixed reviews apply it only to their public replies.
The [Pattern Breaker](pattern-breaker.md) requires exact source
evidence before counting structural repetition.

Checks remain subject to existing verification/pattern-learning switches. This
change does not enable those switches, add model calls, increase retries, or
change approval and sending controls. Generator guidance is always present in
the listed paths. Structural feedback remains editorial judgment; evidence
validation makes its inputs traceable, not infallible.

## Shared ownership and checks

Noelle imports its runtime writing contract directly. It does not depend on a local editor skill or home-directory file during deployment.

Regression coverage uses the real prompt builders, judge boundaries and pattern-evidence validation. Keep structural guidance in the shared runtime owner and preserve platform-specific constraints in their existing builders.
