# Guided workflow

The setup checklist at `/app/{orgSlug}/onboarding` and on the supporting
org chart page, `/app/{orgSlug}/org-chart`. Workspace home opens Approvals. It exists to get someone from "I just signed in" to
"my agent drafted something and I approved it" without them having to read this
repo first.

## What it is

Three pure modules and one that talks to Postgres:

| File | Role |
|---|---|
| `apps/app/src/lib/guided/types.ts` | `GuidedSignals`, `GuidedStep`, `GuidedPlan` |
| `apps/app/src/lib/guided/registry.ts` | the ordered steps + their completion predicates |
| `apps/app/src/lib/guided/plan.ts` | `buildGuidedPlan(signals, orgSlug)` — pure, fully unit tested |
| `apps/app/src/lib/guided/signals.ts` | the only module that queries Cloud SQL |
| `apps/app/src/lib/guided/load.ts` | the one entry point both surfaces call |
| `apps/app/src/lib/guided/dismissal.ts` | cookie-backed "hide this" |

UI: `components/guided/GuidedPanel.tsx` (server) + `DismissGuided.tsx` (client).

## Adding a step

Append one object to `GUIDED_STEPS` in `registry.ts`. Nothing else in the app
enumerates steps.

```ts
{
  id: "my-step",
  tier: "required",          // required | recommended | advanced
  eyebrow: "…",
  title: "…",
  blurb: "…",
  cta: "…",
  href: (orgSlug) => `/app/${orgSlug}/somewhere`,
  isComplete: (s) => s.somethingIsTrue,
  blockedBy: (s) => (s.prereqMissing ? "Do the other thing first." : null),
  waitingOn: (s) => (s.operatorDone && !s.systemDone ? "We're working on it." : null),
}
```

Then add whatever `isComplete` needs to `GuidedSignals` and load it in
`signals.ts`. `registry.test.ts` enforces the invariants (unique ids, routes
under the org, total predicates, required-before-advanced).

## The two rules

**A step is something the operator does.** "Wait for the first draft" is not a
step; it is the `waitingOn` reason attached to `approve`. This is what keeps the
list short enough to finish.

**A step is `required` only if the flow is genuinely broken without it.** Voice
grounding is fail-open: `vaultResolver` returns `[]` when there is no vault and
the drafter treats zero anchors as a normal degraded state, so `voice` is
`recommended`. The two things that actually block a first draft are an Apify
token and agent targeting, and both are `required`.

The flow this replaced had it exactly backwards: it hard-redirected the whole
dashboard into the vault wizard and never mentioned Apify or targeting at all.

## A waitlist placeholder is not a hire

`createOrgFromOnboarding` seeds each new workspace with paused social profiles; the X profile starts at
status `provisioning_alpha`. That row is a place in a queue, not an agent: the
status toggle only flips `active`<->`paused`, so it can never be started.
`hiredInterns()` excludes it, and the `hire` step's `note` says Vega is queued
and points at Lyra, Orion and Nova, which anyone can hire today.

Counting it as a hire pre-ticked step 3 for every operator who ever signed up.

## Step states

`done` · `current` · `todo` · `blocked` · `waiting`

- `blocked` renders no CTA. Sending an operator to a page that cannot do anything
  yet is worse than telling them why.
- `waiting` means the operator finished their part and the pipeline owes them
  output.
- Exactly one step is `current`: the first `required` step that is actionable.
- A step may also carry a `note`: extra context for an actionable step whose
  plain reading would mislead. A note never changes state.

## Signals, and what has no signal

Every field of `GuidedSignals` comes from a table that already exists. **The
guided workflow adds no migration**, deliberately: `infra/cloudsql/` has no
migration runner and no ledger (files are hand-applied with `psql -f`), so a
column this UI depended on would 500 every dashboard read until someone ran it
by hand. Dismissal is a cookie instead, which also scopes it to the operator
rather than the org.

Two things are invisible to SQL:

- **X session cookies** (`ct0` / `auth_token`) live in the runtime environment,
  not in `noelle.*`. The `publishing` step says so rather than showing an
  unchecked box forever. Only `x_api_tokens` (the API path) is detectable.
- **LinkedIn `li_at`** likewise. It is not a guided step.

An Apify token counts as done only when it is `active and in_use and invalid_at
is null` and not exhausted — exactly what the workers' own resolvers read. Tokens
pasted in Connections land SPARE (`in_use = false`), so "a token exists" is not
the same as "discovery can run".

## Caveats

`guidedCaveats(signals)` surfaces truths an operator would otherwise learn by
staring at an empty queue:

- **Orion** is hireable but has no Reddit worker in the native pm2 ecosystem, so
  the queue stays empty. Delete this caveat when the workers ship.
- **Nova** only spends Apify on a requested harvest. `NOELLE_VIDEO_SELF_TRACK`
  defaults to `"0"`, so the own-account sweep does not run on a stock install.
  Keep caveats true of the DEFAULT config: a warning about a cost that only
  happens behind an off-by-default flag trains people to skip the ones that matter.

## It never redirects

The dashboard root used to `redirect()` into the vault wizard. Because the wizard
is a child of the same layout, an earlier version of that gate looped forever on
Next 15 (the scar comment is still in `app/[orgSlug]/layout.tsx`). The panel now
renders inline, and `registry.test.ts` asserts structurally that no module under
`lib/guided/` calls `redirect(`.

## Testing

```
cd apps/app && npx vitest run src/lib/guided/
```

`plan.test.ts` and `registry.test.ts` run against plain object fixtures. No
database, no browser.

`signals.test.ts` pins the SQL against a mocked `sql` tag, because both real
bugs this feature shipped and fixed lived there and nothing in the pure layer
could reach them: a token predicate that disagreed with the workers, and an
agent query that counted a waitlist placeholder as a hire.
