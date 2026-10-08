# Reddit Growth Intern ("Orion") — operator guide

Orion is Noelle's third first-class agent: a Reddit sibling of the X intern (Vega) and the LinkedIn intern (Lyra). She watches a list of **subreddits** (not people), runs a **discovery → classifier → drafter** pipeline against the threads posted there, and drafts an on-brand **reply** to each in-ICP thread. **Orion auto-sends:** a reply that reaches the approvals queue is treated as approved and is posted to Reddit automatically by the **Reddit actuator** (the browser extension, `apps/reddit-actuator`, posting from the operator's logged-in tab). The operator's control is to **edit or Skip** a reply before it goes out — Skip is the veto. There is no profiler, no DMs, no original-post drafting, and no send *worker* (the actuator, not a pm2 worker, does the posting).

This doc is the operator runbook.

## Architecture (parallel to the X / LinkedIn interns)

| Piece | Path |
|---|---|
| Reddit data client (read-only, Apify) | `packages/reddit-apify` |
| Worker app | `apps/reddit-intern` — workers: `discovery` → `classifier` → `drafter` |
| Schema | `noelle.reddit_watchlist` (the subreddit watchlist); reuses `noelle.leads` / `noelle.drafts` / `noelle.approvals` with `platform='reddit'` |
| pm2 | NOT registered: the generated `ecosystem.config.cjs` has no `noelle-reddit-*` entries today. Wiring Orion's workers into the native ecosystem is a pending decision; posting itself is done by the actuator, not a pm2 worker. |

Reuses the platform-agnostic pipeline: `noelle.leads` (`platform='reddit'`) → `noelle.drafts` (`kind='reply'`) → `noelle.approvals`, plus `@noelle/runtime` (Codex routing, budget, voice KB, tenancy).

**No `send` worker exists** — but Orion is **not** draft-only: the Reddit **actuator** (browser extension) drains the approvals queue and posts approved replies automatically (auto-send / auto-drain, gated by the `auto_send_enabled` standing consent + the actuator's own pacing + panic-stop). A reply in the queue is treated as approved; Skip it to stop it. Discovery inserts each Reddit thread as a **new, unclassified** lead (`status='new'`, `priority=false`); the **classifier** then grades every lead against the per-subreddit objective, and the drafter claims the ones that clear the bar. The bar — the q-score threshold (0–100, thread drafted when `q >= threshold`) — defaults to `REDDIT_Q_THRESHOLD` (75) but is **operator-settable per-instance** on the **Config page → Classifier filter** (`agent_instances.classifier_threshold`; the worker resolves `inst.classifier_threshold ?? env`). Lower it (≈50–60) to loosen the filter when the approval queue is thin.

## Targeting model: a subreddit watchlist (not people)

Where Vega watches X handles + keyword searches and Lyra watches LinkedIn connections + keyword searches, **Orion watches subreddits.** The watchlist is a list of communities, each with its own objective and a minimum-score floor:

`noelle.reddit_watchlist`:

| Column | Meaning |
|---|---|
| `subreddit` | the community to watch (e.g. `r/SaaS`), keyed without the `r/` prefix |
| `objective` | free-text per-subreddit objective the classifier grades threads against |
| `min_score` | minimum Reddit post score (upvotes) for a thread to be considered — low-engagement noise is dropped before the LLM ever sees it |
| `added_at` | when the subreddit was added |

Manage the list on the agent's **Watchlist** page: add a subreddit by name / `r/<name>` / full URL, set its free-text objective, set a `min_score` floor, or remove it. There is **no people lane and no profiler** — a subreddit is the unit of targeting, and threads are the unit of work.

## Discovery → classifier → drafter

- **Discovery** (`apps/reddit-intern/src/workers/discovery.ts`) — for each watched subreddit, fetches recent threads via the Apify Reddit actor, drops anything below that subreddit's `min_score`, and inserts each surviving thread as a new lead (`platform='reddit'`, `status='new'`). The thread's permalink/id is the lead's `external_id`; the post title + selftext land on `payload`.
- **Classifier** — grades every new lead against the matching subreddit's `objective`, writing a 0–1 `classifier_score` (the LLM `q/100`). Threads that clear the threshold advance to `classified`; the rest go to `skipped`. (Storing the raw 0–100 `q` is the "7800/100" bug seen in the other interns — keep the `/100` normalization.)
- **Drafter** (`apps/reddit-intern/src/lib/prompts.ts`, `workers/drafter-tick.ts`) — claims classified leads and writes a single on-brand **reply** comment for human approval, grounded in the operator's voice KB. Reuses `@noelle/runtime` (Codex primary + Vertex/Bedrock fallbacks), the budget bucket, and the shared verifier / em-dash + slop hard-strip backstops. **Platform-native voice** (energy mirroring so a joke thread gets a joke, plus a "read the room" digest of the thread's top comments) is gated behind `NOELLE_DRAFTER_ENERGY` / `NOELLE_DRAFTER_COMMENT_ENERGY` — see **`docs/creator-voice.md`**.

Drafts land in the approvals inbox tagged `platform='reddit'` → treated as approved → the **Reddit actuator auto-sends** them (edit or Skip before they go out; Skip / Unskip / bulk Skip is the veto). "Mark sent" records a reply the operator posted themselves and removes it from the auto-send queue. See `docs/reddit-actuator.md` for the posting pacing + safety gates.

The drafter also carries Lyra's **Pattern Breaker** (gated behind `REDDIT_PATTERN_BREAKER`, default **off**): a corpus-level audit of Orion's last-N *sent* replies that learns over-used structural habits, stores them as active `noelle.pattern_rules`, and injects them into the drafting prompts + verifier so the next comments deliberately break them. The dashboard patterns panel and agent-page Pattern Breaker card are instance-scoped, so they work for Orion unchanged. See **`docs/pattern-breaker.md`** for the knobs (`PATTERN_BREAKER_*`, shared names with Lyra) and the operator revert/refine/keep loop.

## Reddit data source: Apify

Orion reads Reddit through the Apify actor **`parseforge/reddit-posts-scraper`** (via `packages/reddit-apify`) — there is no authenticated Reddit cookie or OAuth credential. Every Apify actor run is recorded to `noelle.llm_calls` with `engine='apify'` (flat per-result cost), and like the LinkedIn intern it is **excluded from the LLM budget cap** so the Reddit data fetch never starves the drafting budget. It still shows on the dashboard **Spend** page under Apify.

**Token + quota.** The actor authenticates with an Apify token. Orion resolves it from the DB-backed connection pool (dashboard **Connections** page → Apify) and falls back to `NOELLE_SECRET_APIFY_TOKEN` when the pool is empty. **This pool is shared with Lyra (and, once it migrates, Vega)** — every `kind='apify'` row in `noelle.connections` for the org. The free Apify tier caps at **\$5/mo**; when a token hits the cap Apify returns **HTTP 402/403** — Orion treats this as a token-fatal "quota wall", benches that token **until its real billing-cycle reset** (probed from `/v2/users/me/limits` → `monthlyUsageCycle.endAt` + 1h, not a flat +30d guess) and rotates to the next available token, **deferring** the tick rather than crashing. When every token is spent (or all cooling) the discovery worker records `worker_runs.error` (the Pipeline panel shows Discovery as errored: "all N Apify tokens exhausted…") and fires a Pushover ping once per episode. Transient 429 rate-limits are not token-fatal — they bubble and defer.

**401 → verify before retiring (no single-401 kill).** A 401 from one actor call is health-checked first (`checkApifyToken`): only when the probe *also* 401s is the token genuinely dead and marked `invalid_at`; an alive/inconclusive probe means the 401 was transient (a throttle during a burst) and the token gets a short cooldown instead of being permanently killed. A token marked invalid is **excluded from the pool entirely the instant it's flagged** (`listApifyTokens` filters `invalid_at is null`) — no worker fetches it again, because repeated 401s from a banned account on one IP are themselves an abuse signal that endangers the rest of the pool. Replace it on the Connections page.

**Cohort-ban avoidance.** Free Apify accounts created in a cluster and hammered concurrently from one residential IP get banned together by Apify's abuse detection (observed: 11 fresh tokens banned in ~1s, $0 spend). Orion bounds the burst: the discovery fan-out runs at most `NOELLE_APIFY_MAX_CONCURRENCY` (default **3**) shards at once with a per-shard launch stagger of `NOELLE_APIFY_SHARD_STAGGER_MS` (default **800ms**), so only a few Apify calls egress at a time with spread-out starts (parity with Lyra). Stack several tokens on the Connections page to widen the budget — but lean on **paid** accounts over farming many free ones, which is structurally ban-prone.

## Cadence (env knobs)

Orion runs **24/7 — there is no human-hours / active-hours gate** (Reddit is asynchronous and global, so unlike Lyra there is no "only touch between 7am–11pm" window). "24/7" means no *curfew* while the instance is **active** — it is not "ignores Pause": the dashboard **Start/Pause** button is the master switch, and pausing the instance puts the whole pipeline to sleep (discovery / classifier / drafter act only on active instances — unlike Vega/Lyra, Orion's watchlist is *subreddits*, its only lane, so there is nothing to keep doing while paused). Tuned via env (`apps/reddit-intern/src/env.ts`), renamed from the `LINKEDIN_*` knobs:

| Env | Default | Meaning |
|---|---|---|
| `REDDIT_DISCOVERY_POLL_MS` | 15 min | discovery tick interval (not a tight loop) |
| `REDDIT_CLASSIFIER_POLL_MS` | 15 min | classifier tick interval |
| `REDDIT_DRAFTER_POLL_MS` | 15 min | drafter tick interval |
| `REDDIT_DISCOVERY_LIMIT` | 15 | threads fetched per subreddit per tick (Apify bills per result) |
| `REDDIT_WATCHLIST_REPOLL_HOURS` | 0 (off) | **per-subreddit re-poll cooldown**: a watched subreddit's posts are fetched at most once per window. The extract cap counts new **leads**, not actor calls, so without this every subreddit is re-fetched every 15-min tick (~96×/day/subreddit — quiet subreddits burn full-price Apify runs returning nothing). In-memory per process (a restart = one extra full sweep); `0` disables (the default — activate at 1-2h via env; subreddits move faster than one person's profile, so Lyra's 4h default is deliberately not copied). Ports `LINKEDIN_WATCHLIST_REPOLL_HOURS`. |
| `NOELLE_APIFY_MAX_CONCURRENCY` | 3 | max Apify actor calls egressing at once across the discovery fan-out (cohort-ban lever; 0/unset → 3, never unlimited) |
| `NOELLE_APIFY_SHARD_STAGGER_MS` | 800 | per-shard launch delay so N tokens don't all hit Apify at the same instant from one IP (0 disables) |
| `REDDIT_DAILY_CAP` | 20 | max reply drafts queued per day (extra clearing leads are held as `classified`, not dropped) |
| `REDDIT_Q_THRESHOLD` | 75 | classifier q-score bar (0–100); drafted when `q >= threshold`. Overridden per-instance by `agent_instances.classifier_threshold` |

There is **no `REDDIT_ACTIVE_HOURS_*` / `REDDIT_TZ_OFFSET_MIN`** — that human-hours gate is LinkedIn-only and is intentionally absent here.

## DB tables it touches

- `noelle.reddit_watchlist` — the subreddit watchlist (`subreddit`, `objective`, `min_score`, `added_at`).
- `noelle.leads` with `platform='reddit'` — one row per discovered thread.
- `noelle.drafts` with `kind='reply'` — one reply draft per in-ICP thread (no `dm` kind, no post drafts).
- `noelle.approvals` — the reply queue; a pending row is treated as approved and auto-sent by the actuator (Skip to veto).
- `noelle.llm_calls` — drafting spend (`engine='codex'`/fallbacks) + Apify data spend (`engine='apify'`).

Tenancy is enforced in app code (`assertOrgMember`), same as everywhere else — every server-side path scopes by `organization_id` before touching `noelle.*`.

## Credentials

Self-host stores the Apify token VM-local (never the repo, never GCP Secret Manager on self-host):

```
# ~/.noelle/.env  (mode 0600, on the Mac)
NOELLE_SECRET_APIFY_TOKEN=apify_api_...
```

The worker prefers the DB-backed Apify connection pool and uses `NOELLE_SECRET_APIFY_TOKEN` only when the pool is empty. There is **no Reddit login credential** — all reads go through Apify.

## Operate (native Mac runtime)

Orion can run alongside the other social workers in the managed native runtime.

**Runtime status, stated plainly:** Orion's workers are NOT registered in the native pm2 ecosystem today. The generated `~/.noelle/ecosystem.config.cjs` defines X, LinkedIn, and video workers but no `noelle-reddit-*` entries, so no Reddit worker process runs on the live box. Wiring them into the ecosystem generator (`apps/cli/src/lib/process-manager.ts`) is a pending decision. To actually go live end-to-end, Orion needs: its workers in the pm2 ecosystem, the instance active (not paused), the Reddit actuator extension loaded, and `auto_send_enabled` armed for auto-drain — then approved replies post automatically.

Setup that applies once the workers run (and for a manual dev run):

1. Put an Apify token in `~/.noelle/.env` (see above), or add one on the dashboard **Connections** page.
2. Apply migrations: `noelle migrate` (the `reddit_watchlist` migration is picked up by the ledger). Confirm: `select role,status from noelle.agent_instances where role='reddit_intern';` → `Orion`.
3. Seed the watchlist on the agent's **Watchlist** page: add each subreddit by name / `r/<name>` / URL, set its objective and `min_score`.
4. Build before running (workers run `dist/`): at minimum `@noelle/runtime` + `@noelle/reddit-apify` + `@noelle/reddit-intern`. For a hand-run in dev: `cd apps/reddit-intern && ./run.sh <discovery|classifier|drafter>` with the env loaded from `~/.noelle/.env`.
5. Drafts land in the approvals inbox (treated as approved) → the Reddit actuator auto-sends them → edit or **Skip** any you don't want posted.

If the Apify token dies (402 quota wall / 401 invalid): discovery logs the rotation + records `worker_runs.error` when the whole pool is spent; add or replace a token on the Connections page (no restart needed; the pool is read each tick).

### Which api-vm hosts the actuator may talk to (`host_permissions`)

The Reddit actuator is a browser extension, so it can only fetch hosts declared in `host_permissions` in `apps/reddit-actuator/wxt.config.ts`. Alongside `http://localhost/*` and `http://127.0.0.1/*` (the native Mac runtime — api-vm on `:18791`; `127.0.0.1` is listed separately because Chrome's service worker may resolve "localhost" to IPv6 `::1`, which the IPv4 api-vm doesn't answer), the list carries the same three remote origins as the X and LinkedIn actuators:

| Origin | What it is |
|---|---|
| `https://api.trynoelle.com/*` | the prod Cloudflare tunnel (only up when prod is up; for a local-only self-host use the Tailscale address) |

**The rule: when the backend host changes, those lines change with it.** Pointing the extension's Options → API base URL at a host that isn't in the list does not error — MV3 just fails the background fetch, so `fetchQueue` throws and `health()` collapses to `null`, which `passesAutoStartSafety` treats as fail-closed. Auto-start and auto-drain stop firing and never resume, while the extension still looks loaded and idle. Add the **specific** origin (host, no port — a `host_permissions` entry matches every port on that host), never a tailnet-wide wildcard: the list is scoped tight on purpose to keep the extension's fingerprintable footprint small. Same discipline as `docs/linkedin-actuator-second-host.md`.
