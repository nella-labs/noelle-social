# @noelle/linkedin-intern

The LinkedIn Growth Intern ("Lyra") worker pool. A draft-only sibling of
`@noelle/x-intern` specialised for LinkedIn. Runs as pm2 processes **inside the
Lima `default` VM** (residential IP) — never on `noelle-vm-0`.

Three workers, in `src/workers/`:

- `discovery` — for each watchlist person, fetch recent posts and upsert them as
  **priority, already-classified** LinkedIn leads (`platform='linkedin'`).
- `profiler` — deep-read a watchlist person's first ~40 posts and write an
  LLM-summarised profile (`noelle.linkedin_watchlist_profiles`).
- `drafter` — claim classified leads, pull voice anchors + the person's profile,
  and draft 3 reply angles + 1 DM via the runtime Codex runner, then POST to
  `/api/outbound` with `platform='linkedin'`.

**Hard invariant: Lyra never posts to LinkedIn and never auto-sends.** There is
no `send` worker, no classifier worker, and no `autoSend` block on the outbound
payload. Drafts queue for human approval; the operator copies them, sends by
hand on LinkedIn, and clicks "Mark sent".

Each worker is launched by `run.sh <kind>`. Shared libs live in `src/lib/`.

See [the platform guide](../../docs/linkedin-intern.md) for the current workflow.
