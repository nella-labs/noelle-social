import { z } from "zod";
import { XReplyMaxAgeHoursSchema } from "@noelle/contracts";

// Truthy env flag ("1"/"true", case-insensitive). Unset → false. (z.coerce.boolean
// is unsafe here — Boolean("false") is true.)
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || (v ?? "").toLowerCase() === "true");

// Worker env. All real secrets resolved later via lib/secrets.ts at boot;
// this struct only holds the non-secret runtime config that systemd
// EnvironmentFile=/etc/noelle/worker.env injects.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  NOELLE_WORKER_KIND: z.enum(["discovery", "classifier", "drafter", "send", "profiler", "ideation", "content-publish", "account-feeder"]).optional(),
  WORKER_ID: z.string().default("0"),
  WORKER_COUNT: z.coerce.number().int().positive().default(1),

  // Cloud SQL via Auth Proxy on the VM. Local dev uses public IP + sslmode=require.
  NOELLE_DATABASE_URL: z.string().min(1),

  // HMAC for POST /api/outbound. Worker side; api-vm side reads the same value.
  NOELLE_HMAC_SECRET: z.string().min(32),

  // Hono base. Drafter posts here; send worker hits no Hono endpoint.
  CP_BASE_URL: z.string().url().default("https://api.trynoelle.com"),

  // GCP — for Secret Manager pulls at boot.
  GCP_PROJECT: z.string().default("noelle-agents"),

  // Self-host Gemini escape hatch: classifiers, captioning, and Account Feeder
  // call generativelanguage.googleapis.com with this key instead of Vertex ADC.
  // Unset → Vertex ADC fallback. See @noelle/runtime/gemini-backend-select.
  NOELLE_GEMINI_API_KEY: z.string().optional(),

  // Remote voice retrieval requires an explicit workspace at adapter creation.
  NELLA_BASE_URL: z.string().url().default("https://nella.getnella.dev"),
  NELLA_WORKSPACE: z.string().trim().default(""),

  // Anchor retrieval backend. `gcs` uses the in-process GCS shim
  // (`createGcsNellaClientWithSdk`) — reads markdown directly from
  // `gs://<NOELLE_VAULT_BUCKET>/<slug>/`, does in-process keyword
  // scoring. `http` uses the legacy `createNellaClient` pointed at
  // `NELLA_BASE_URL`. `local` (self-host) reads markdown from
  // `NOELLE_VAULT_DIR` on disk and BM25-ranks in-process — no GCS/GCP.
  // Default `gcs` because the legacy host doesn't resolve in DNS today and
  // the GCS path actually ships anchors.
  NOELLE_NELLA_BACKEND: z.enum(["gcs", "http", "local"]).default("gcs"),
  // Preferred, Nella-agnostic name for the knowledge-base backend. When set it
  // takes precedence over NOELLE_NELLA_BACKEND (kept for managed-prod
  // back-compat). Self-host sets this to `local`.
  NOELLE_KB_BACKEND: z.enum(["gcs", "http", "local"]).optional(),
  NOELLE_VAULT_BUCKET: z.string().default("noelle-vaults"),
  // Local vault dir for the `local` KB backend (self-host). Markdown is
  // scanned recursively; voice anchors are BM25-ranked in-process, and new
  // files are picked up live (fs.watch + mtime check, no restart).
  NOELLE_VAULT_DIR: z.string().optional(),
  // Curated voice base: comma-separated, vault-root-relative subdirs the local KB
  // restricts indexing to (e.g. "noelle-voice,content/voice-anchors,02-brand").
  // The drafter grounds on the operator's voice/style, NOT on whatever shares
  // keywords with the post. Unset = index the whole NOELLE_VAULT_DIR (back-compat:
  // existing self-hosts that haven't opted in keep their current behavior). This
  // is what keeps polluted dirs (content/replies + content/dms `## Original`
  // quote blocks: earnings reports, leaked AI system prompts) out of retrieval.
  NOELLE_VOICE_DIRS: z.string().optional(),
  // TTL backstop ceiling for the local KB index (ms). Default 15 min.
  NOELLE_KB_CACHE_TTL_MS: z.coerce.number().int().positive().default(15 * 60_000),

  // Noelle-billed classifier backend. `vertex` (default, managed prod) scores
  // via Vertex Gemini through the worker's attached SA/ADC. `bedrock` scores
  // via Bedrock Claude using the worker's AWS keys — used on the self-host VM,
  // where Vertex user-ADC dies with invalid_rapt. (A BYO org `gemini-api-key`
  // still overrides either, billing the org's own Google account.)
  NOELLE_CLASSIFIER_BACKEND: z.enum(["vertex", "bedrock"]).default("vertex"),
  // Bedrock model handle for the classifier when NOELLE_CLASSIFIER_BACKEND=bedrock.
  NOELLE_CLASSIFIER_BEDROCK_MODEL: z.string().default("claude-haiku-4-5"),

  // Codex CLI binary path (preinstalled on VM).
  CODEX_BIN: z.string().default("codex"),

  // Poll cadences (ms). Defaults match the design doc § 3.2.
  DISCOVERY_POLL_MS: z.coerce.number().int().positive().default(5 * 60_000),
  // Browser discovery now sources reply leads. Follower enrichment and comment
  // context have separate paths; this legacy source can be re-enabled explicitly.
  X_APIFY_REPLY_LEADS: boolFlag.default("0"),
  // Per-Apify-run timeout for X discovery. The X scraper actor runs on a POOL of
  // free-tier Apify accounts (each ~$5/mo); a free run that will succeed does so
  // inside the first ~60s `waitForFinish` window, but an over-quota/queued free
  // run stays non-terminal — so the x-apify default (120s) is wasted waiting on a
  // run that never finishes. 90s gives a legit run room while abandoning a stuck
  // one sooner. Bounds the TAIL; the tick budget below bounds the WHOLE tick.
  X_DISCOVERY_APIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  // Wall-clock budget for ONE discovery tick's Apify work. The tick loops over
  // every watched handle + keyword, one actor run each; without a cap, a pool of
  // slow/queued free runs (90s apiece) made a single tick take 10+ minutes and
  // the worker looked hung. Once the tick has spent this long, it stops issuing
  // new runs and defers the rest to the next tick (poll interval later), so one
  // stuck token can never freeze the worker.
  X_DISCOVERY_TICK_BUDGET_MS: z.coerce.number().int().positive().default(120_000),
  // ── Concurrent multi-token discovery (sharding) ────────────────────────────
  // How many Apify runs may be in flight at once. The token pool is split into
  // this many DISJOINT shards (round-robin), so no two concurrent runs ever hold
  // the same token — that is what makes concurrency safe rather than a way to
  // rate-limit one token N times over. Capped by how many tokens are actually
  // available, so a thin pool just yields fewer shards.
  //
  // Default 1 = OFF, byte-identical to the sequential path: with a starved pool
  // (the situation this shipped into) concurrency buys nothing, and the tick's
  // wall-clock budget already bounds the damage. Raise it once the pool has
  // several usable tokens — that is when serialisation, not supply, is the
  // bottleneck. Mirrors Lyra's NOELLE_APIFY_MAX_CONCURRENCY.
  NOELLE_APIFY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  // Per-shard launch stagger (ms). Shard i waits ~i*base + rand(0..base) before
  // its FIRST request so N tokens don't all egress simultaneously from one box.
  // Only the STARTS are spread; the shards still overlap. 0 disables.
  X_DISCOVERY_SHARD_STAGGER_MS: z.coerce.number().int().min(0).default(1_500),
  // ── Proactive Apify-token health sweep ─────────────────────────────────────
  // Probes every active token against /v2/users/me/limits and flags only a
  // definitive 401, so a token that DIED while parked as a spare (or while
  // benched as exhausted) still earns its invalid flag instead of masquerading
  // as usable. A capped token answers 200 there, so it correctly stays
  // exhausted; 429/5xx/network errors are never treated as a kill signal.
  //
  // Vega hosts this as well as Lyra. The sweep mutates the SHARED
  // noelle.connections pool, so hosting it in one worker only meant the pool
  // went unprobed exactly when that worker was down — and Vega, which reads the
  // same pool, had no way to notice. Running it from both is additive, not
  // duplicative: the probe is one GET and flagging a 401 is idempotent.
  // ── Person-first discovery (candidate retention + polling) ─────────────────
  // Authors seen in the keyword lane whose BIO matches icp_config are retained
  // in noelle.x_discovered_people, and their timelines are polled on later ticks
  // as ordinary non-priority leads. This is the X analogue of Lyra's
  // profile-first lane (#185) — X has no people-search actor, so candidates come
  // from the keyword lane rather than a profile search.
  //
  // Requires icp_config to be set: with no ICP there is no "right person" test,
  // and retaining every author would just be an expensive way to poll strangers.
  // 0 candidates per tick disables the polling half while still retaining.
  // ── Human-hours gate for the X-touching READ workers (discovery/profiler) ──
  // Scraping round the clock is a bot signal; the actuator already has a write
  // curfew, this covers the read half. START==END (the default) disables it, so
  // it ships inert — set e.g. 8/23 with the operator's UTC offset to enable.
  X_ACTIVE_HOURS_START: z.coerce.number().int().min(0).max(23).default(0),
  X_ACTIVE_HOURS_END: z.coerce.number().int().min(0).max(23).default(0),
  X_TZ_OFFSET_MIN: z.coerce.number().int().default(-300), // America/Bogota
  // ── Daily extract cap + watch-lane reserve ────────────────────────────────
  // ONE daily cap across all lanes; the top band is reserved for the always-on
  // WATCH lane so the keyword lane cannot starve the operator's hand-picked
  // accounts. 0 = unlimited (the default, byte-identical to today).
  X_DAILY_EXTRACT_CAP: z.coerce.number().int().min(0).default(0),
  X_WATCHLIST_DAILY_RESERVE: z.coerce.number().int().min(0).default(0),
  // ── Engagement Analyst (per-author PLAYBOOKS) ─────────────────────────────
  // Reverse-engineers WHY a watched person's best posts work into a reusable
  // playbook (hook patterns, structure, cadence, topics) the ideation lane and
  // drafter borrow the SHAPE from. Costs NO Apify — the engagement counts are
  // already on the leads — just one cheap LLM call per author needing a refresh.
  //
  // NOTE the X_ANALYST_* knobs further down belong to the ideation lane's "topic
  // radar", a DIFFERENT job (what to post about) tuned for breadth. These are
  // tuned for depth: a teardown needs more sample posts and a higher floor than
  // a radar does, so they are separate rather than shared names meaning two
  // things. Default OFF; additionally throttled by playbook staleness.
  X_ENGAGEMENT_ANALYST: boolFlag,
  X_PLAYBOOK_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  X_PLAYBOOK_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  X_PLAYBOOK_MAX_AUTHORS: z.coerce.number().int().positive().default(25),
  X_PLAYBOOK_MAX_PER_TICK: z.coerce.number().int().positive().default(3),
  X_PLAYBOOK_SAMPLE_POSTS: z.coerce.number().int().positive().default(6),
  X_PLAYBOOK_MIN_POSTS: z.coerce.number().int().positive().default(3),
  X_PLAYBOOK_STALE_DAYS: z.coerce.number().int().positive().default(14),
  X_PERSON_LANE_ENABLED: boolFlag.default("1"),
  // ── Follower feeder (person DISCOVERY) ─────────────────────────────────────
  // Scrapes the followers of seed accounts and keeps the ones whose BIO matches
  // icp_config. This is the X answer to Lyra's profile-search feeder: X has no
  // keyword→user search actor trustworthy on a free plan, and "who follows this
  // account" is a stronger ICP signal than a bio keyword match anyway.
  //
  // DEFAULT OFF, and that is deliberate: unlike every other discovery knob this
  // one spends money per RUN rather than per useful lead. The actor floors its
  // list size at 200 users (~$0.03 a run at ~$0.15/1k), so an unbounded loop on
  // a $5/mo free-tier token would drain a month of credit in a couple of days.
  // The three guards below are what make it safe to turn on:
  //   INTERVAL_HOURS — one run per seed per window (default 24h, so a seed's
  //     audience is re-harvested daily at most; their followers barely change).
  //   MAX_USERS      — hard ceiling per run.
  //   SEEDS_PER_RUN  — how many seeds one run may cover (1 = one seed per day).
  X_FOLLOWER_FEEDER_ENABLED: boolFlag,
  X_FOLLOWER_FEEDER_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  X_FOLLOWER_FEEDER_MAX_USERS: z.coerce.number().int().min(1).max(2000).default(200),
  X_FOLLOWER_FEEDER_SEEDS_PER_RUN: z.coerce.number().int().min(1).max(5).default(1),
  /** How many retained candidates to poll per tick. Each costs one Apify run. */
  X_PERSON_POLL_PER_TICK: z.coerce.number().int().min(0).max(20).default(3),
  /** Hours before a polled candidate is eligible again (prevents starvation). */
  X_PERSON_POLL_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(12),
  X_APIFY_HEALTH_SWEEP_ENABLED: boolFlag.default("1"),
  X_APIFY_HEALTH_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60_000),
  /** How many tokens to probe at once. Cheap GETs, so a small fan-out is fine. */
  X_APIFY_HEALTH_SWEEP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  CLASSIFIER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  DRAFTER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  SEND_POLL_MS: z.coerce.number().int().positive().default(60_000),
  // content-publish worker (Vega-only X API auto-posting of scheduled slots).
  CONTENT_PUBLISH_POLL_MS: z.coerce.number().int().positive().default(60_000),
  // Minimum spacing between two auto-published posts (ms). The tick publishes at
  // most ONE slot and won't publish again until this window elapses, so a backlog
  // of overdue slots drains one-per-window instead of bursting in a single tick.
  // Velocity is X's #1 lock trigger (docs/x-account-safety.md). 0 disables the
  // gate (still one publish per tick). Default 5 min.
  CONTENT_PUBLISH_MIN_SPACING_MS: z.coerce.number().int().min(0).default(5 * 60_000),
  // Content media (self-host): where the api-vm wrote uploaded image bytes. The
  // publish worker reads them from here to upload+attach to an auto-post. Set to
  // the SAME dir the api-vm + app use (docs/content-workspace.md § Media storage).
  // On the `gcs` backend the worker fetches content_media.url instead, so the
  // dir is unused. Default `local` matches the api-vm default.
  NOELLE_MEDIA_BACKEND: z.enum(["local", "gcs"]).default("local"),
  NOELLE_MEDIA_DIR: z.string().optional(),
  // ── X self-track (the LEARN loop) ──────────────────────────────────────────
  // Measure the operator's OWN published posts and feed engagement back into
  // ideation. Bolted onto the content-publish worker as an interval sweep
  // (mirrors Nova's self-track). Vega-only in practice (draft-only agents never
  // publish, so they have no own posts to measure).
  NOELLE_X_SELF_TRACK: boolFlag.default("1"),
  // Sweep cadence and how far back to keep re-measuring a published post.
  NOELLE_X_SELF_TRACK_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  NOELLE_X_SELF_TRACK_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  // Max own posts pulled from Apify + max slots re-measured per instance per sweep.
  NOELLE_X_SELF_TRACK_MAX: z.coerce.number().int().positive().default(50),
  // ── X own-account snapshot (what the drafter is allowed to say about itself) ─
  // Refresh the operator's own handle + follower/following/post counts onto the
  // shared memory bus (bucket `own_account`), so the drafter states a real number
  // instead of inventing one. Distinct from self-track above: that one only ever
  // saw a follower count riding along on a recently published post, so it went
  // dark with nothing published in 30 days (and died outright once the Apify pool
  // was exhausted). This asks the X API who the token belongs to — one read per
  // sweep, no write budget, no dependence on having posted.
  NOELLE_X_OWN_ACCOUNT: boolFlag.default("1"),
  // Sweep cadence. A follower count moves slowly and the free X API tier meters
  // reads tightly, so 12h (≈60 calls/month) keeps it fresh at negligible cost.
  NOELLE_X_OWN_ACCOUNT_MS: z.coerce.number().int().positive().default(12 * 60 * 60_000),
  // ── X API metrics (real per-post engagement for the Performance tab) ────────
  // The official-API twin of self-track: re-measures the operator's OWN published
  // posts via GET /2/tweets (public_metrics → real IMPRESSIONS, which Apify can't
  // see) and appends to the same own_post_metrics table. Runs as a throttled
  // sweep inside content-publish (which already builds the write-token client).
  NOELLE_X_METRICS: boolFlag.default("1"),
  // Sweep cadence. A read costs no write budget, but engagement moves slowly, so
  // ~3h keeps the Performance tab fresh without hammering the API.
  NOELLE_X_METRICS_MS: z.coerce.number().int().positive().default(3 * 60 * 60_000),
  // Official X API OAuth2 app credentials (used for token refresh on the write path).
  X_API_CLIENT_ID: z.string().optional(),
  X_API_CLIENT_SECRET: z.string().optional(),
  // Anti-flag daily ceiling: max replies auto-sent per instance in a rolling
  // 24h, on top of auto_send_max_per_hour. Caps queued batches no matter how
  // many the operator selected.
  AUTOSEND_MAX_PER_DAY: z.coerce.number().int().positive().default(50),
  // Anti-flag velocity guard: max auto-sends per rolling 30 min (velocity, not
  // daily total, is X's #1 lock trigger). The send worker also claims at most
  // 2 rows per tick so a backlog can't burst.
  AUTOSEND_MAX_PER_30MIN: z.coerce.number().int().positive().default(6),
  // Block external links on the unattended auto-send path. Default ON (fail-closed:
  // blocking is the safe state; set "0"/"false" only to DISABLE the guard). When on,
  // an auto-sent reply carrying an external (non-x.com/twitter.com/t.co) link is
  // never posted unattended — the drafter withholds the schedule and the send
  // worker reverts any already-stamped link row to the human-review inbox. Autonomous
  // links in replies are a documented top-tier spam signal (docs/x-account-safety.md).
  NOELLE_AUTOSEND_BLOCK_EXTERNAL_LINKS: boolFlag.default("1"),
  // Persist the X send worker's 429 cooldown + escalating streak to
  // noelle.agent_instances so a merge-driven pm2 restart can't resume posting into
  // an actively rate-limited account. Default OFF → in-memory-only, exactly as
  // today (no new query, no updated_at churn). On → the read FAILS CLOSED on boot
  // (unreadable cooldown ⇒ assume in-cooldown, skip sends this tick), with a
  // 120-min ceiling so a stale row self-heals. See lib/send-backoff.ts + 0082.
  X_PERSIST_SEND_COOLDOWN: boolFlag,
  // Reply-freshness ceiling, in hours of TARGET-TWEET age (payload.posted_at).
  // Applied at draft claim (0088 RPCs), at auto-send claim + retry, and as the
  // expiry sweep on pending approvals: a reply to a tweet older than this is
  // never drafted or posted — on X it reads as necro-engagement and earns
  // nothing from the ranker. 0 disables every age gate (legacy behavior).
  // Ceiling on TARGET-TWEET age for a reply (hours). Default 25: on X a reply to
  // a tweet much older than a day is dead — outside the live-conversation window
  // the ranker rewards; the extra hour past 24 keeps a lead that arrived late in
  // yesterday's cycle from aging out one tick before the actuator reaches it.
  // Enforced at draft claim (0088 RPC), the drafter's expiry sweeps, and the
  // browser-actuator feed (apps/api-vm actionable-x reads the SAME env). 0
  // disables every age gate. The api-vm side defaults to 25 too, so set this
  // once in ~/.noelle/.env to change both.
  // .int() is REQUIRED: the value is bound into `make_interval(hours => $n)` in
  // raw postgres.js queries, and a fractional hours arg throws
  // `function make_interval(hours => numeric) does not exist` — which would
  // fail-closed every freshness sweep/claim for the whole tick. Reject a
  // non-integer at boot instead.
  X_REPLY_MAX_AGE_HOURS: XReplyMaxAgeHoursSchema,
  // Overnight quiet window (UTC hours, [start,end), wraps) — the send worker
  // won't fire NEW auto-sends inside it (24/7 flat cadence is a bot signature).
  // Default 4–12 UTC ≈ overnight for UTC-5; matches the api-vm schedule's quiet.
  AUTOSEND_QUIET_START_UTC: z.coerce.number().int().min(0).max(23).default(4),
  AUTOSEND_QUIET_END_UTC: z.coerce.number().int().min(0).max(24).default(12),
  // When on, the drafter's stamped auto_send_target_at never lands in the quiet
  // window (pushed to its end, matching what send.ts already enforces). Default
  // false → computeAutoSendTargetAt is called WITHOUT quiet params (byte-identical
  // to today). See lib/auto-send.ts + docs/x-account-safety.md §8.
  AUTOSEND_STAMP_HONORS_QUIET: boolFlag,
  // Cross-tick inter-send floor (anti-velocity-burst; default OFF -> no behavior
  // change until enabled). ON => at most ONE reply per tick + a JITTERED gap
  // (persisted in memory, like the 429 cooldown) since the last successful post,
  // so a post-downtime backlog drains one-at-a-time. Velocity is X's #1 lock
  // trigger (docs/x-account-safety.md §2/§4). Strictly slows sends => fail-safe.
  NOELLE_AUTOSEND_INTERSEND_FLOOR: boolFlag,
  AUTOSEND_INTERSEND_MIN_MS: z.coerce.number().int().min(0).default(60_000),
  AUTOSEND_INTERSEND_MAX_MS: z.coerce.number().int().min(0).default(120_000),
  PROFILER_POLL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  IDLE_POLL_MS: z.coerce.number().int().positive().default(30_000),

  // ---- X Account Feeder (manual, cost-gated style-learning run) -------------
  // The feeder pulls recent tweets (originals + authored replies) from a curated
  // list of admired source accounts via Apify, then fans out Gemini extractors to
  // distil each account's writing STYLE into an "ultra profile" + a style corpus
  // the drafter samples per-lead. Runs ONLY when an operator has flipped the
  // manual run flag (account_feeder_run_requested_at) — never on a schedule
  // (Apify cost). Ported from Lyra's Account Feeder.
  //
  // How often the feeder polls for a pending manual run. Cheap index-only read.
  X_FEEDER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  // Original posts kept per source account per run. Billed per result by Apify,
  // so keep it bounded.
  X_FEEDER_POST_LIMIT: z.coerce.number().int().positive().default(40),
  // Authored replies kept per source account per run — their real outbound reply
  // voice. Same per-result billing.
  X_FEEDER_COMMENT_LIMIT: z.coerce.number().int().positive().default(40),
  // Max parallel Gemini style-extractors (one per source account) the feeder runs
  // at once via batchMap. Bounds Gemini concurrency per manual run.
  X_FEEDER_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // ── X ideation worker (operator-triggered "Generate ideas" on the X lane). ──
  // How often to drain the ideation_requests queue, and how many per tick.
  IDEATION_POLL_MS: z.coerce.number().int().positive().default(30_000),
  IDEATION_BATCH: z.coerce.number().int().positive().default(2),
  // Single-mode idea count when the request omits one (batch is always 7).
  IDEATION_DEFAULT_COUNT: z.coerce.number().int().min(1).max(10).default(3),
  // Net-new viral lane: max posts to keep per keyword search (0 disables the
  // Apify keyword source; the watchlist + voice sources still produce ideas).
  X_IDEATION_KEYWORD_LIMIT: z.coerce.number().int().min(0).default(10),
  // Virality floor for the net-new search (min_faves). The ideation lane only
  // borrows structure from posts that actually performed.
  X_IDEATION_MIN_FAVES: z.coerce.number().int().min(0).default(30),
  // Recency window (hours) for the net-new search. Default 7 days.
  X_IDEATION_WINDOW_HOURS: z.coerce.number().int().positive().default(168),
  // Watchlist author engagement ("topic radar") source tuning.
  X_ANALYST_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  X_ANALYST_TOP_AUTHORS: z.coerce.number().int().positive().default(8),
  X_ANALYST_SAMPLE_POSTS: z.coerce.number().int().positive().default(3),
  X_ANALYST_MIN_POSTS: z.coerce.number().int().positive().default(1),
  // How many voice anchors to retrieve from the vault per ideation run.
  NOELLE_IDEATION_VOICE_TOPK: z.coerce.number().int().positive().default(8),
  // Operator content pillars (CSV) — the breadth scaffold for ideation.
  NOELLE_POSTS_PILLARS: z.string().default(""),
  // Learn loop → ideation: how many of the operator's OWN top posts to surface
  // as the "what's working for you" bias block (0 disables the own-performance
  // source; the pillar/angle rollup still surfaces if any posts are measured).
  X_IDEATION_OWN_PERF_POSTS: z.coerce.number().int().min(0).default(5),
  // How long a watchlist-person profile stays fresh before the profiler regenerates it.
  PROFILE_REFRESH_DAYS: z.coerce.number().int().positive().default(3),
  // How many people to (re)profile per profiler tick (one fetch + LLM call each).
  PROFILER_BATCH: z.coerce.number().int().positive().default(3),
  // Profile anyone we've SENT strictly more than this many replies to, even when
  // they aren't (or are no longer) on the watchlist — a backstop for the gaps in
  // auto-promote. 0 = profile anyone we've replied to at all.
  PROFILER_MIN_REPLIES: z.coerce.number().int().min(0).default(5),
  // Only replies sent within this window count toward PROFILER_MIN_REPLIES, so
  // a person we stopped talking to eventually leaves the queue instead of being
  // re-profiled forever.
  PROFILER_REPLY_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

  // X graphql token bucket (req per WINDOW_MS).
  X_RATE_TOKENS: z.coerce.number().int().positive().default(100),
  X_RATE_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),

  // Drafter retrieval-score gate. Leads whose strongest anchor falls below this
  // threshold are skipped without invoking the LLM. Default 6 — calibrated on the
  // NORMALIZED BM25 scale (score ÷ matched-query-term count) against the live
  // mars voice base scoped to [noelle-voice, content/voice-anchors, 02-brand]:
  // 60 real posts scored a top anchor of 8.5–516 (short on-theme posts ≥ ~10.8),
  // while off-topic controls scored 4.8 (recipe) / 8.1 (finance). 6 sits in the
  // gap — it drops clear off-topic noise with a wide margin below real content,
  // and is a no-op on an UNSCOPED corpus (whole-vault scores run ~80–800), so the
  // managed GCS path does not regress. Raise it for stricter topical gating.
  DRAFTER_RELEVANCE_THRESHOLD: z.coerce.number().min(0).default(6),

  // Classifier quality gate. A non-priority (keyword-lane) lead must score at
  // least this (the classifier's 0-100 quality score) to be drafted. Leads the
  // classifier scored below it — or could not score at all (label=other carries
  // a null score) — are dropped to 'skipped' instead of reaching the inbox.
  // Watchlist (priority) leads always bypass (they're forced score=1). X had NO
  // quality gate before this, so q<50 / unscored junk was being drafted. Default
  // 50. Set 0 to disable. Mirrors LinkedIn's LINKEDIN_Q_THRESHOLD (75).
  X_Q_THRESHOLD: z.coerce.number().int().min(0).max(100).default(50),
  // Engagement-tiered model escalation (ported from Lyra). A lead whose post has
  // real traction is drafted by the smarter, costlier model:
  //   useOpus = likes > X_OPUS_LIKES || (replies > X_OPUS_REPLIES && !comment_bait)
