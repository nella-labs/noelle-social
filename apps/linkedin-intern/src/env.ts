import { z } from "zod";

// Truthy env flag ("1"/"true", case-insensitive). Unset → false. (z.coerce.boolean
// is unsafe here — Boolean("false") is true.)
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || (v ?? "").toLowerCase() === "true");

// Worker env for the LinkedIn intern (Lyra). Mirrors apps/x-intern/src/env.ts;
// all real secrets (the LinkedIn li_at) are resolved later via lib/secrets.ts at
// boot. This struct only holds the non-secret runtime config injected by the
// pm2 ecosystem / EnvironmentFile.
//
// Lyra is draft-only (it never POSTS to LinkedIn — no send worker) but it DOES
// classify: discovery → classifier → drafter → profiler, plus the Posts lane's
// ideation + post-drafter. NOELLE_WORKER_KIND is constrained to those workers;
// `send` is intentionally absent.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  // `followup` is the on-demand connection-follow-up ONE-SHOT (not a pm2 app);
  // run.sh exports NOELLE_WORKER_KIND for it too, so it must be a valid member or
  // loadEnv() throws before the tool runs. `send` is intentionally absent.
  NOELLE_WORKER_KIND: z
    .enum([
      "discovery",
      "classifier",
      "profiler",
      "drafter",
      "ideation",
      "post-drafter",
      "feeder",
      "followup",
    ])
    .optional(),
  WORKER_ID: z.string().default("0"),
  WORKER_COUNT: z.coerce.number().int().positive().default(1),

  // Cloud SQL via Auth Proxy on the VM. Self-host uses a local Postgres URL.
  NOELLE_DATABASE_URL: z.string().min(1),

  // HMAC for POST /api/outbound. Worker side; api-vm side reads the same value.
  NOELLE_HMAC_SECRET: z.string().min(32),

  // Hono base. The drafter posts shape-validated outbound here.
  CP_BASE_URL: z.string().url().default("https://api.trynoelle.com"),

  // GCP — for Secret Manager pulls at boot (managed). Self-host uses env secrets.
  GCP_PROJECT: z.string().default("noelle-agents"),

  // Remote voice retrieval requires an explicit workspace at adapter creation.
  NELLA_BASE_URL: z.string().url().default("https://nella.getnella.dev"),
  NELLA_WORKSPACE: z.string().trim().default(""),

  // Anchor retrieval backend. `gcs` uses the in-process GCS shim; `http` uses
  // the legacy per-org Nella HTTP client; `local` (self-host) reads markdown
  // from NOELLE_VAULT_DIR on disk and BM25-ranks in-process. Mirrors x-intern.
  NOELLE_NELLA_BACKEND: z.enum(["gcs", "http", "local"]).default("gcs"),
  // Preferred, Nella-agnostic name for the knowledge-base backend. When set it
  // takes precedence over NOELLE_NELLA_BACKEND. Self-host sets this to `local`.
  NOELLE_KB_BACKEND: z.enum(["gcs", "http", "local"]).optional(),
  NOELLE_VAULT_BUCKET: z.string().default("noelle-vaults"),
  // Local vault dir for the `local` KB backend (self-host).
  NOELLE_VAULT_DIR: z.string().optional(),
  // The operator's VOICE SPEC — a markdown file in the vault that is the single
  // source of voice truth (the `voice-post` skill + this drafter read the same
  // file). Defaults to `<NOELLE_VAULT_DIR>/voice-spec.md` when unset; absent ⇒
  // the drafter falls back to its inlined rules (byte-identical to before).
  NOELLE_VOICE_SPEC_PATH: z.string().optional(),
  // Curated voice base: comma-separated, vault-root-relative subdirs the local KB
  // restricts indexing to (e.g. "noelle-voice,content/voice-anchors,02-brand").
  // Lyra grounds on the operator's voice/style, NOT on whatever shares keywords
  // with the post. Unset = index the whole NOELLE_VAULT_DIR (back-compat). Keeps
  // polluted dirs (content/replies + content/dms `## Original` quote blocks:
  // earnings reports, leaked AI system prompts) out of retrieval. Mirrors x-intern.
  NOELLE_VOICE_DIRS: z.string().optional(),
  // TTL backstop ceiling for the local KB index (ms). Default 15 min.
  NOELLE_KB_CACHE_TTL_MS: z.coerce.number().int().positive().default(15 * 60_000),

  // Noelle-billed classifier backend. `vertex` (default, managed prod) scores via
  // Vertex Gemini through the worker's attached SA/ADC. `bedrock` scores via
  // Bedrock Claude using the worker's AWS keys — used on the self-host Lima VM,
  // where Vertex user-ADC dies with invalid_rapt. A BYO org `gemini-api-key`
  // still overrides either, billing the org's own Google account. Mirrors x-intern.
  NOELLE_CLASSIFIER_BACKEND: z.enum(["vertex", "bedrock"]).default("vertex"),
  // Bedrock model handle for the classifier when NOELLE_CLASSIFIER_BACKEND=bedrock.
  NOELLE_CLASSIFIER_BEDROCK_MODEL: z.string().default("claude-haiku-4-5"),
  // Google AI Studio key (`AIza…`). Self-host alternative to Vertex ADC: when set
  // on the vertex classifier path, calls go to generativelanguage.googleapis.com
  // with this key instead of Vertex AI + ADC. Eliminates the `invalid_rapt`
  // re-auth wall the Lima VM hits with user-login ADC. Leave unset in managed
  // prod (the SA-attached Vertex ADC never reauths). Mirrors the BYO-key path
  // but is Noelle-billed (charges the Google account that owns the key).
  NOELLE_GEMINI_API_KEY: z.string().optional(),

  // Codex CLI binary path (preinstalled on VM).
  CODEX_BIN: z.string().default("codex"),

  // Poll cadences (ms). LinkedIn is paced conservatively to protect the cookie.
  DISCOVERY_POLL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  // Classifier scores the cheap, in-DB backlog (no LinkedIn calls) so it can run
  // fast like x-intern's classifier.
  CLASSIFIER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  DRAFTER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  PROFILER_POLL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  IDLE_POLL_MS: z.coerce.number().int().positive().default(30_000),
  // How long a watchlist-person profile stays fresh before the profiler regenerates it.
  PROFILE_REFRESH_DAYS: z.coerce.number().int().positive().default(3),
  // How many people to (re)profile per profiler tick (one fetch + LLM call each).
  PROFILER_BATCH: z.coerce.number().int().positive().default(3),
  // Profile anyone we've SENT strictly more than this many replies to, even when
  // they were never hand-added to the watchlist. The keyword/search lane meets
  // people the watchlist never hears about; past this many replies they are a
  // real relationship and every further reply should be grounded. 0 = profile
  // anyone we've replied to at all; raise it to spend less on Apify + LLM.
  PROFILER_MIN_REPLIES: z.coerce.number().int().min(0).default(5),
  // Only replies sent within this window count toward PROFILER_MIN_REPLIES.
  // Without it the tally is monotonic: a person could never leave the queue, so
  // removing them from the watchlist would stop nothing and the profiler would
  // re-fetch them every PROFILE_REFRESH_DAYS forever.
  PROFILER_REPLY_WINDOW_DAYS: z.coerce.number().int().positive().default(90),

  // ---- Account Feeder (manual, cost-gated style-learning run) ---------------
  // The feeder pulls posts + authored comments from a curated list of admired
  // source accounts via Apify, then fans out Gemini extractors to distil each
  // account's writing STYLE into an "ultra profile" + a style corpus the drafter
  // samples per-lead. Runs ONLY when an operator has flipped the manual run flag
  // (account_feeder_run_requested_at) — never on a schedule (Apify cost). See
  // docs/superpowers/specs/2026-06-19-account-feeder-design.md.
  //
  // How often the feeder polls for a pending manual run. Cheap index-only read.
  FEEDER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  // Posts pulled per source account per run (profilePosts maxPosts). A deep read
  // of their recent history so the style extraction is well-grounded. Billed per
  // result by Apify, so keep it bounded.
  LINKEDIN_FEEDER_POST_LIMIT: z.coerce.number().int().positive().default(40),
  // Authored comments pulled per source account per run (authoredComments
  // maxComments) — their real outbound reply voice. Same per-result billing.
  LINKEDIN_FEEDER_COMMENT_LIMIT: z.coerce.number().int().positive().default(40),
  // Max parallel Gemini style-extractors (one per source account) the feeder runs
  // at once via batchMap. Bounds Vertex concurrency per manual run.
  LINKEDIN_FEEDER_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // ---- Engagement Analyst (Intelligence box, runs in the profiler worker) ---
  // How many top watchlist authors to maintain playbooks for. The analyst ranks
  // watched authors by engagement and only the top N earn a teardown.
  LINKEDIN_ANALYST_TOP_AUTHORS: z.coerce.number().int().positive().default(10),
  // How many authors the analyst (re)analyzes per profiler tick (one LLM call each).
  LINKEDIN_ANALYST_BATCH: z.coerce.number().int().positive().default(3),
  // Engagement window (days) the analyst aggregates leads over.
  LINKEDIN_ANALYST_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  // Min posts in the window for an author to be ranked (too few = no signal).
  LINKEDIN_ANALYST_MIN_POSTS: z.coerce.number().int().positive().default(2),
  // How many best posts per author feed the teardown LLM call.
  LINKEDIN_ANALYST_SAMPLE_POSTS: z.coerce.number().int().positive().default(8),

  // ---- Pattern Breaker -----------------------------------------------------
  // Default OFF. When on, the drafter worker (a) drains the AI-refine queue
  // every tick (cheap) and (b) re-analyzes the operator's last-N posts for
  // over-used structural patterns at most once per interval, per instance.
  LINKEDIN_PATTERN_BREAKER: boolFlag,
  // How often (ms) the full analysis re-runs per instance. Default 6h — it's a
  // corpus-level audit, not a per-lead pass.
  PATTERN_BREAKER_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  // Min posts in a window for a pattern to be flagged (also the corpus floor).
  PATTERN_BREAKER_MIN_FREQUENCY: z.coerce.number().int().positive().default(3),
  // Min SHARE of the window a pattern must cover to count as over-used (0..1).
  // Applies to phrase AND structure findings — a tic in 5 of 100 posts (5%) is
  // normal variation, not a habit worth banning. Default 0.3 (a third).
  PATTERN_BREAKER_MIN_RATIO: z.coerce.number().min(0).max(1).default(0.3),
  // Max posts pulled into the corpus (the largest analysis window).
  PATTERN_BREAKER_MAX_POSTS: z.coerce.number().int().positive().default(100),

  // ---- Posts lane: ideation worker -----------------------------------------
  // How often the ideation worker polls for pending operator requests.
  IDEATION_POLL_MS: z.coerce.number().int().positive().default(30_000),
  // How many ideation requests one instance drains per tick.
  IDEATION_BATCH: z.coerce.number().int().positive().default(2),
  // Default idea count for a single-mode request that omits `count`.
  IDEATION_DEFAULT_COUNT: z.coerce.number().int().min(1).max(10).default(5),
  // Max net-new keyword-search posts pulled per ideation run (Apify cost).
  LINKEDIN_IDEATION_KEYWORD_LIMIT: z.coerce.number().int().nonnegative().default(10),
  // Voice anchors pulled from the vault to ground ideas in the operator's voice.
  NOELLE_IDEATION_VOICE_TOPK: z.coerce.number().int().min(0).default(8),
  // The operator's content pillars (CSV). Surfaced to the ideation model so
  // ideas stay on-message. Empty = let the model infer pillars from voice.
  NOELLE_POSTS_PILLARS: z.string().default(""),
  // Post CTA (Nicolas-Dunlap-style sign-off the post-drafter ends every post
  // with). Concrete values so the URL is never hallucinated. All optional: with
  // no product/url the drafter ends on just a topic-matched follow ask.
  NOELLE_POSTS_CTA_PRODUCT: z.string().default(""), // e.g. "Noelle"
  NOELLE_POSTS_CTA_URL: z.string().default(""),     // e.g. "trynoelle.com"
  NOELLE_POSTS_CTA_TAGLINE: z.string().default(""), // Optional operator-supplied call to action.

  // ---- Posts lane: post-drafter worker -------------------------------------
  // How often the post-drafter polls for approved ideas to write.
  POST_DRAFTER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  // How many approved ideas the post-drafter writes per tick.
  POST_DRAFTER_BATCH: z.coerce.number().int().positive().default(2),
  // Run the post verifier (voice/grounding/format judge + regenerate).
  NOELLE_POST_VERIFY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Max regenerate attempts on a failing post verdict.
  NOELLE_POST_VERIFY_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  // How many status='new' leads the classifier scores per tick (one cheap Gemini
  // call each). Mirrors x-intern's batch of 10.
  CLASSIFIER_BATCH: z.coerce.number().int().positive().default(10),

  // ---- Quality pipeline (LinkedIn-specific volume rules) -------------------
  // The classifier's reply-worthiness threshold. A post scoring q >= this is a
  // 'substantial' lead (worth a real, value-adding reply); below it the post may
  // still earn a short 'light' supportive comment, otherwise it's skipped.
  // Tier bands within 'substantial': q>=90 → T1, 80-89 → T2, [threshold]-79 → T3.
  LINKEDIN_Q_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
  // Daily ceiling on how many posts discovery EXTRACTS (inserts as status='new')
  // per instance per calendar day. Discovery stops fetching once the day's count
  // reaches this, so we never balloon the classifier backlog.
  // 0 = UNLIMITED (no daily cap) — the default. Volume is then governed by the
  // goal auto-pause + backlog backpressure (search lane) and the per-tick fetch
  // limits + Apify rate/active-hours limits (both lanes). Set a positive value to
  // re-impose a hard daily ceiling as a cost/ban safety valve.
  LINKEDIN_DAILY_EXTRACT_CAP: z.coerce.number().int().nonnegative().default(0),
  // Of LINKEDIN_DAILY_EXTRACT_CAP, how many extractions/day are RESERVED for the
  // always-on WATCH lane (the operator's hand-picked connections). The keyword +
  // profile SEARCH lanes stop feeding once the day's running total reaches
  // (cap − reserve), so a burst of low-value search/profile leads can never starve
  // the watchlist of its extract budget; the watch lane keeps drawing to the full
  // cap. 0 = no reserve (old shared-pool behaviour, first-come-first-served).
  LINKEDIN_WATCHLIST_DAILY_RESERVE: z.coerce.number().int().nonnegative().default(40),
  // WATCH-lane per-person re-poll cooldown, in HOURS. A watched person's
  // profilePosts is fetched at most once per window (in-memory, per process).
  // The daily extract cap counts new LEADS, not actor calls, so without this
  // every person was re-fetched every 15-min tick (~96×/day/person) — mostly
  // zero-result runs that still burn Apify credit. 4h ⇒ ≤6 sweeps/day/person
  // (~94% fewer watch-lane calls). 0 disables (old every-tick behaviour).
  LINKEDIN_WATCHLIST_REPOLL_HOURS: z.coerce.number().nonnegative().default(4),
  // Daily ceiling on how many SUBSTANTIAL posts the drafter drafts per instance
  // per calendar day. When hit, substantial leads are left 'classified' for a
  // later day rather than downgraded.
  // 0 = UNLIMITED (no daily cap) — the default. Drafting is draft-only: it fills
  // the approval queue and does NOT touch LinkedIn, so the write-side safety
  // valves are auto-send pacing + LINKEDIN_MAX_CALLS_PER_HOUR, not this. A fixed
  // daily bucket also starved the day: the 24/7 drafter drained it against the
  // overnight backlog within ~an hour of the midnight reset, leaving every later
  // run with zero quota. Set a positive value to re-impose a hard ceiling.
  LINKEDIN_DAILY_SUBSTANTIAL_CAP: z.coerce.number().int().nonnegative().default(0),
  // Daily ceiling on how many LIGHT (short supportive) posts the drafter drafts
  // per instance per calendar day. Independent of the substantial cap.
  // 0 = UNLIMITED (no daily cap) — the default, same reasoning as above.
  LINKEDIN_DAILY_LIGHT_CAP: z.coerce.number().int().nonnegative().default(0),

  // ---- Intro DM (one-time relationship-building outreach) -----------------
  // Lyra auto-drafts ONE warm intro DM per watchlist person, ever: a peer note
  // that references their work and asks what they're building. NO pitch. Queued
  // for approval (draft-only). DEFAULT-OFF — the operator enables it at deploy;
  // managed/live Lyra is unchanged until then. Only profiled people are eligible
  // (the DM is personalized off the profile); a daily cap paces the rollout.
  LINKEDIN_INTRO_DM_ENABLED: boolFlag,
  // How many intro DMs the drafter drafts per instance per calendar day. Each
  // person gets exactly one ever (claimIntroDmPeople stamps as it claims), so
  // this just paces the one-time backfill across days. 0 disables the lane.
  LINKEDIN_INTRO_DM_DAILY_CAP: z.coerce.number().int().min(0).default(5),
  // Goal stall-guard: auto-pause a goal-run that has made no progress (0 new
  // leads) for this many minutes. Stops an unreachable target (more than the
  // watchlist can produce) from polling Apify forever. Default 2h.
  LINKEDIN_GOAL_STALL_MIN: z.coerce.number().int().positive().default(120),

  // LinkedIn client pacing: min delay before each Voyager call (ms) + a random
  // jitter on top, giving a human 20–90s window between calls (min 20s + up to
  // 70s). Slow on purpose — cadence is what keeps the cookie alive.
  LINKEDIN_MIN_DELAY_MS: z.coerce.number().int().positive().default(20_000),
  LINKEDIN_JITTER_MS: z.coerce.number().int().nonnegative().default(70_000),
  // Hard rolling-hour ceiling on Voyager calls (one session per process). The
  // client throws when hit so the tick backs off. ~90 leaves headroom over a
  // typical watchlist (one call/person every 15 min).
  LINKEDIN_MAX_CALLS_PER_HOUR: z.coerce.number().int().nonnegative().default(90),
  // Human-hours gate: discovery/profiler only touch LinkedIn between START and
  // END (local hour, via TZ offset). Set START==END to disable (run 24h).
  LINKEDIN_ACTIVE_HOURS_START: z.coerce.number().int().min(0).max(23).default(7),
  LINKEDIN_ACTIVE_HOURS_END: z.coerce.number().int().min(0).max(23).default(23),
  // Minutes offset from UTC for the active-hours check. Default -300 (Bogota, UTC-5).
  LINKEDIN_TZ_OFFSET_MIN: z.coerce.number().int().default(-300),
  // Posts fetched per person per DISCOVERY tick. Small + gentle — discovery only
  // needs the freshest handful; the client already paces every call.
  LINKEDIN_DISCOVERY_LIMIT: z.coerce.number().int().positive().default(5),
  // Browser discovery now sources reply leads. Other Apify enrichment paths
  // remain separate; this legacy source can be re-enabled explicitly.
  LINKEDIN_APIFY_REPLY_LEADS: boolFlag.default("0"),
  // Posts fetched per person for PROFILING — a deep read of their history so the
  // profile is well-grounded. ~40.
  LINKEDIN_PROFILER_LIMIT: z.coerce.number().int().positive().default(40),

  // ---- Keyword discovery lane (net-new high-engagement posts) --------------
  // Lyra's SEARCH lane (parallel to her watched-connections lane): she searches
  // LinkedIn-wide via the Apify post-search actor for posts matching the
  // operator's noelle.linkedin_watchlist keywords, surfacing high-engagement
  // posts from people OUTSIDE the network that fit the objective. Off when the
  // instance has no keywords. The watched-connections lane is unaffected.
  //
  // Posts fetched per keyword per tick. The actor can't sort by engagement, so
  // we over-fetch by recency and apply the engagement floor client-side; Apify
  // bills per result, so keep this modest.
  LINKEDIN_KEYWORD_DISCOVERY_LIMIT: z.coerce.number().int().positive().default(15),
  // Default reaction floor for the keyword lane when the instance's
  // discovery_config sets no minReactions. The whole point of the lane is HIGH
  // engagement, so it must never ingest every stranger's post; a configured
  // minReactions (saved default or per-run override) wins over this.
  LINKEDIN_KEYWORD_MIN_REACTIONS: z.coerce.number().int().nonnegative().default(10),
  // Coarse recency hint passed to the Apify post-search actor ("day"|"week"|
  // "month"). The precise time window still comes from discovery_config and is
  // enforced client-side; this just narrows what the actor returns.
  LINKEDIN_KEYWORD_POSTED_LIMIT: z.string().default("week"),

  // Apify (posts transport). Token comes from secrets (NOELLE_SECRET_APIFY_TOKEN);
  // the actor id defaults to harvestapi/linkedin-profile-posts in @noelle/linkedin-apify
  // and is overridable here when the actor rotates.
  APIFY_PROFILE_POSTS_ACTOR_ID: z.string().optional(),
  // Discovery shard fan-out stagger (ms). The pool resolver returns one client
  // per available Apify token; discovery shards the work across them and runs the
  // shards CONCURRENTLY. Firing every shard's first request simultaneously from
  // one box is the LinkedIn-ban trigger, so each shard i waits ~i*base + rand(0..base)
  // before its first request — spreading the launches without serialising them.
  // 0 disables the stagger (all shards start at once, the old behaviour).
  NOELLE_APIFY_SHARD_STAGGER_MS: z.coerce.number().int().nonnegative().default(800),
  // Discovery fan-out concurrency CAP. At most this many shards run at once, so at
  // most this many Apify actor calls egress from one box simultaneously — the main
  // lever against LinkedIn-ban pressure / rate spikes. Default 3; 0 or unset falls
  // back to 3 (NOT unlimited — capping is the whole point). The stagger above still
  // spreads the starts of each capped batch.
  NOELLE_APIFY_MAX_CONCURRENCY: z.coerce
    .number()
    .int()
    .transform((n) => (n > 0 ? n : 3))
    .default(3),
  // Comment-energy: max comments the drafter fetches per lead to read the room
  // (Apify post-comments actor, billed ~$2/1k). Bounds per-lead cost. 0 disables.
  LINKEDIN_DRAFTER_COMMENT_MAX: z.coerce.number().int().nonnegative().default(40),

  // Proactive Apify-token health sweep (apify-health-sweep.ts). The discovery
  // worker periodically probes every active token's /v2/users/me/limits and flags
  // the definitively-dead (401) ones invalid — closing the gap where a parked or
  // capped-then-died token never gets probed and rots in the pool as "fresh". A
  // capped token returns 200 there, so it's NEVER mis-flagged. Default ON (the
  // 401-only kill signal is safe); set "0" to disable. Cleans the SHARED pool, so
  // running it on Lyra's worker benefits every intern.
  LINKEDIN_APIFY_HEALTH_SWEEP_ENABLED: boolFlag.default("1"),
  // How often the sweep may run, per org (ms). Default 1h. The probe is a free,
  // light management-API GET, but there's no value in hammering it every tick.
  LINKEDIN_APIFY_HEALTH_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),

  // Drafter retrieval-score gate. Leads whose strongest anchor falls below this
  // threshold are skipped without invoking the LLM. Light leads bypass it.
  // Default 6 — calibrated on the NORMALIZED BM25 scale (score ÷ matched-query-
  // term count) against the live mars voice base scoped to [noelle-voice,
  // content/voice-anchors, 02-brand]: 60 real posts scored a top anchor of
  // 8.5–516, off-topic controls 4.8–8.1, so 6 drops clear off-topic noise with a
  // wide margin below real content and is a no-op on an unscoped corpus (whole-
  // vault scores ~80–800), so the managed GCS path does not regress. Mirrors
  // x-intern. Raise it for stricter topical gating.
  DRAFTER_RELEVANCE_THRESHOLD: z.coerce.number().min(0).default(6),

  // ---- Reaction-based Opus tiering (high-engagement → stronger model) -------
  // When a lead's source post is high-engagement, the drafter uses the strongest
  // model (Opus) so the comment is excellent — high-engagement posts get more
  // eyeballs, and a great comment there earns reciprocal engagement. Engagement
  // data is reused from Apify (payload.reactions = likes, payload.comments =
  // comment count); NO extra API calls. The rule the drafter applies:
  //   useOpus = likes > LINKEDIN_OPUS_LIKES
  //          || (comments > LINKEDIN_OPUS_COMMENTS && !comment_bait)
  // Likes are always reliable; the comments trigger is suppressed for
  // engagement-bait posts (the classifier's comment_bait flag) whose comment
  // count is inflated by a comment-farming CTA rather than real discussion.
  LINKEDIN_OPUS_LIKES: z.coerce.number().int().nonnegative().default(80),
  LINKEDIN_OPUS_COMMENTS: z.coerce.number().int().nonnegative().default(30),
  // The Opus model handle the drafter overrides to for a high-engagement lead.
  // Defaults to the top Opus the Bedrock backend has access to (claude-opus-4-6).
  // If the runtime can't serve it, the call falls back to the instance's normal
  // routing primary so a missing Opus never blocks a draft.
  NOELLE_DRAFTER_OPUS_MODEL: z.string().default("claude-opus-4-6"),

  // ── Grounded-drafting pipeline (all default OFF → live behavior unchanged
  //    until the operator opts in). Mirrors apps/x-intern/src/env.ts. See
  //    docs/grounded-drafting.md. NOELLE_VOICE_DIRS (above) already scopes voice
  //    retrieval; these add the knowledge pass + verifier. ──
  // Scope a SECOND, knowledge retrieval pass to these subdirs (product /
  // positioning / ICP, e.g. "01-business,04-automation-contexts"), parsed the
  // same way as NOELLE_VOICE_DIRS. When set, the drafter grounds factual claims
  // in retrieved operator knowledge instead of model priors. Empty → no pass.
  NOELLE_KNOWLEDGE_DIRS: z.string().optional(),
  // How many knowledge chunks to retrieve in the second pass.
  NOELLE_DRAFTER_KNOWLEDGE_TOPK: z.coerce.number().int().min(0).default(4),
  // Run the reply verifier + regenerate loop. Default on so new replies carry
  // a genuine review before the actuator considers unattended sending.
  NOELLE_DRAFTER_VERIFY: boolFlag.default("1"),
