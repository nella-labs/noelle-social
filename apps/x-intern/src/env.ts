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
