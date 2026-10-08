import { z } from "zod";

// Truthy env flag ("1"/"true", case-insensitive). Unset → false. (z.coerce.boolean
// is unsafe here — Boolean("false") is true.)
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || (v ?? "").toLowerCase() === "true");

// Worker env for the Reddit intern (Orion). Mirrors apps/linkedin-intern/src/env.ts;
// all real secrets (the Apify token) are resolved later via lib/secrets.ts at
// boot. This struct only holds the non-secret runtime config injected by the
// pm2 ecosystem / EnvironmentFile.
//
// Orion is draft-only (it never POSTS to Reddit — no send worker) but it DOES
// classify: discovery → classifier → drafter. NOELLE_WORKER_KIND is constrained
// to those three workers; `send` is intentionally absent.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  NOELLE_WORKER_KIND: z.enum(["discovery", "classifier", "drafter"]).optional(),
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
  // Curated voice base: comma-separated, vault-root-relative subdirs the local KB
  // restricts indexing to. Orion grounds on the operator's voice/style, NOT on
  // whatever shares keywords with the post. Unset = index the whole
  // NOELLE_VAULT_DIR (back-compat). Mirrors x-intern.
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

  // Codex CLI binary path (preinstalled on VM).
  CODEX_BIN: z.string().default("codex"),

  // Poll cadences (ms).
  //
  // DISCOVERY is REDDIT_-prefixed on purpose: it is the only Apify-SPENDING tick,
  // and the unprefixed DISCOVERY_POLL_MS in the shared ~/.noelle/.env (set for the
  // X/LinkedIn interns) otherwise dragged Orion's discovery to that common cadence
  // (2 min live) with no independent knob — ~720 full-price actor runs/subreddit/
  // day toward token exhaustion. This is the knob docs/reddit-intern.md documents;
  // default 15 min. The cheap, no-Apify classifier/drafter/idle ticks stay
  // unprefixed at 30s (intended — they only read the in-DB backlog).
  REDDIT_DISCOVERY_POLL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  // Classifier scores the cheap, in-DB backlog (no Apify calls) so it runs fast.
  CLASSIFIER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  DRAFTER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  IDLE_POLL_MS: z.coerce.number().int().positive().default(30_000),

  // How many status='new' leads the classifier scores per tick (one cheap Gemini
  // call each). Mirrors x-intern's batch of 10.
  CLASSIFIER_BATCH: z.coerce.number().int().positive().default(10),

  // ---- Quality pipeline (Reddit-specific volume rules) ---------------------
  // The classifier's reply-worthiness threshold. A post scoring q >= this is a
  // 'substantial' lead (worth a real, value-adding reply); below it the post may
  // still earn a short 'light' supportive comment, otherwise it's skipped.
  // Tier bands within 'substantial': q>=90 → T1, 80-89 → T2, [threshold]-79 → T3.
  REDDIT_Q_THRESHOLD: z.coerce.number().int().min(0).max(100).default(75),
  // Daily ceiling on how many posts discovery EXTRACTS (inserts as status='new')
  // per instance per calendar day. Discovery stops fetching once the day's count
  // reaches this, so we never balloon the classifier backlog.
  REDDIT_DAILY_EXTRACT_CAP: z.coerce.number().int().positive().default(80),
  // Daily ceiling on how many SUBSTANTIAL posts the drafter drafts per instance
  // per calendar day. When hit, substantial leads are left 'classified' for a
  // later day rather than downgraded.
  // 0 = UNLIMITED (no daily cap) — the default. Orion is draft-only (it fills
  // the approval queue and never posts to Reddit), so a daily bucket protects
  // nothing and only starves the queue: the 24/7 drafter drains the whole day's
  // quota against the overnight backlog within ~an hour of the midnight reset,
  // leaving every later run deferring its leads. Set a positive value to
  // re-impose a hard ceiling.
  REDDIT_DAILY_SUBSTANTIAL_CAP: z.coerce.number().int().nonnegative().default(0),
  // Daily ceiling on how many LIGHT (short supportive) posts the drafter drafts
  // per instance per calendar day. Independent of the substantial cap.
  // 0 = UNLIMITED (no daily cap) — the default, same reasoning as above.
  REDDIT_DAILY_LIGHT_CAP: z.coerce.number().int().nonnegative().default(0),

  // Goal stall-guard: auto-pause a goal-run that has made no progress (0 new
  // leads) for this many minutes. Stops an unreachable target from polling Apify
  // forever. Default 2h.
  REDDIT_GOAL_STALL_MIN: z.coerce.number().int().positive().default(120),

  // Max post age (hours) the drafter will still spend a reply draft on. A claimed
  // classified lead whose post is older than this is SKIPPED (reason
  // 'post-too-old'), not drafted — so the scarce daily draft budget and the
  // operator's approval queue are never spent on a thread whose live upvote
  // window has closed (a reply there rides no ranking curve = necro-engagement).
  // Pairs with the freshest-first claim order: ordering decides WHAT to draft
  // first, this decides what's too stale to bother. Default 0 = OFF (no age
  // cull) — Reddit content is also a durable LLM-search surface (cited posts
  // average ~900 days old), so hard-dropping by age is opt-in; operators chasing
  // live-vote velocity set 24-48.
  REDDIT_MAX_POST_AGE_HOURS: z.coerce.number().int().nonnegative().default(0),

  // Posts fetched per subreddit per DISCOVERY tick. Small + gentle — discovery
  // only needs the freshest handful; Apify bills per post.
  REDDIT_DISCOVERY_LIMIT: z.coerce.number().int().positive().default(15),

  // Top comments requested + kept per post at discovery time (the actor fetches
  // them with the posts). They ride along on the lead payload so the drafter can
  // read the room and target the most-upvoted comment. 0 disables comment fetch.
  REDDIT_COMMENTS_PER_POST: z.coerce.number().int().nonnegative().default(8),

  // Watchlist per-subreddit re-poll cooldown (hours): a watched subreddit's
  // posts are fetched at most once per window. The daily extract cap counts new
  // LEADS, not actor calls, so without this every subreddit is re-fetched every
  // 15-min tick (~96×/day/subreddit) — quiet subreddits burn full-price Apify
  // runs returning nothing. In-memory per process (a restart = one extra full
  // sweep). Default 0 = OFF (byte-identical every-tick behaviour); activate at
  // 1-2h via env — subreddits move faster than one person's profile, so the
  // LinkedIn intern's 4h default is deliberately NOT copied here.
  REDDIT_WATCHLIST_REPOLL_HOURS: z.coerce.number().nonnegative().default(0),

  // Apify (posts transport). Token comes from secrets (NOELLE_SECRET_APIFY_TOKEN);
  // the actor id defaults to parseforge~reddit-posts-scraper in @noelle/reddit-apify
  // and is overridable here when the actor rotates.
  APIFY_SUBREDDIT_POSTS_ACTOR_ID: z.string().optional(),

  // Discovery fan-out stagger (ms): shard i waits ~i*base + rand(0..base) before its
  // first Apify call, so N free tokens don't all egress at once from one residential
  // IP — the multi-account-abuse signal that gets Apify free accounts banned as a
  // cohort. 0 disables the stagger. Mirrors the LinkedIn intern.
  NOELLE_APIFY_SHARD_STAGGER_MS: z.coerce.number().int().nonnegative().default(800),
  // Discovery fan-out concurrency CAP — at most this many Apify actor calls egress
  // from this box at once. The main lever against cohort-ban pressure (firing every
  // free token's shard simultaneously is the trigger). Default 3; 0/unset → 3
  // (capping is the whole point, never unlimited). Mirrors the LinkedIn intern.
  NOELLE_APIFY_MAX_CONCURRENCY: z.coerce
    .number()
    .int()
    .transform((n) => (n > 0 ? n : 3))
    .default(3),

  // Drafter retrieval-score gate. Leads whose strongest anchor falls below this
  // threshold are skipped without invoking the LLM. Light leads bypass it.
  // Calibrated on the NORMALIZED BM25 scale (score ÷ matched-query-term count).
  // Mirrors x-intern. Raise it for stricter topical gating.
  DRAFTER_RELEVANCE_THRESHOLD: z.coerce.number().min(0).default(6),

  // ---- Score-based Opus tiering (high-engagement → stronger model) ----------
  // When a lead's source post is high-engagement (Reddit score / comment count),
  // the drafter uses the strongest model (Opus) so the comment is excellent — a
  // great comment on a high-eyeball post earns reciprocal engagement. Engagement
  // data is reused from Apify (payload.score, payload.numComments); NO extra API
  // calls. The rule:
  //   useOpus = score > REDDIT_OPUS_SCORE || comments > REDDIT_OPUS_COMMENTS
  REDDIT_OPUS_SCORE: z.coerce.number().int().nonnegative().default(500),
  REDDIT_OPUS_COMMENTS: z.coerce.number().int().nonnegative().default(100),
  // The Opus model handle the drafter overrides to for a high-engagement lead.
  // Defaults to the top Opus the Bedrock backend has access to (claude-opus-4-6).
  // If the runtime can't serve it, the call falls back to the instance's normal
  // routing primary so a missing Opus never blocks a draft.
  NOELLE_DRAFTER_OPUS_MODEL: z.string().default("claude-opus-4-6"),

  // ── Grounded-drafting pipeline (all default OFF → live behavior unchanged
  //    until the operator opts in). Mirrors apps/x-intern/src/env.ts. ──
  // Scope a SECOND, knowledge retrieval pass to these subdirs (product /
  // positioning / ICP), parsed the same way as NOELLE_VOICE_DIRS. When set, the
  // drafter grounds factual claims in retrieved operator knowledge instead of
  // model priors. Empty → no pass.
  NOELLE_KNOWLEDGE_DIRS: z.string().optional(),
  // How many knowledge chunks to retrieve in the second pass.
  NOELLE_DRAFTER_KNOWLEDGE_TOPK: z.coerce.number().int().min(0).default(4),
  // Run the post-draft verifier + regenerate loop.
  NOELLE_DRAFTER_VERIFY: boolFlag,
  // Max regenerate attempts on a failed verdict before queueing the best try.
  NOELLE_DRAFTER_VERIFY_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  // Voice floor (0-1). After the verifier + retries, a reply whose voice score
  // is below this is DROPPED (lead skipped 'low-voice') instead of served.
  // 0 disables the gate. Default 0.65.
  NOELLE_DRAFTER_VOICE_FLOOR: z.coerce.number().min(0).max(1).default(0.65),
  // Voice variety: per lead, randomly assign a "register" and inject it into the
  // comment-drafting prompt so comments vary in length + energy across the feed
  // (see lib/register.ts). Default OFF → byte-identical drafts. Mirrors x-intern.
  NOELLE_DRAFTER_VARIETY: boolFlag,
  // Post-energy mirroring (default OFF). When on, the drafter detects each thread's
  // ENERGY (celebration / joke / hot_take / vent / question / analytical) and (a)
  // picks an energy-aware register when variety is on — DEADPAN on a joke, never HYPE
  // on a serious thread — and (b) injects a "POST ENERGY" hint so the comment MIRRORS
  // the thread: answer a joke with a joke, a vent with commiseration, not philosophy.
  // Off/unset → blind register only, byte-identical to today. See packages/runtime/src/register.ts.
  NOELLE_DRAFTER_ENERGY: boolFlag,
  // Sibling-comment "read the room" fetch (default OFF). When on, the drafter pulls
  // the top OTHER comments on each thread via Reddit's FREE public .json endpoint (no
  // token, no Apify spend, fail-open) and injects a digest so the comment mirrors the
  // room's energy and never echoes a take already made. Off/unset → no fetch, no
  // block, byte-identical. See packages/runtime/src/commentDigest.ts.
  NOELLE_DRAFTER_COMMENT_ENERGY: boolFlag,
  // Max sibling comments to fetch + show per lead when NOELLE_DRAFTER_COMMENT_ENERGY
  // is on. Keeps the prompt bounded. Default 12.
  NOELLE_DRAFTER_COMMENT_MAX: z.coerce.number().int().min(1).max(50).default(12),
  // Per-author memory: how many of the replies Orion already sent/queued to a
  // post's author to inject into the comment prompt ("do not repeat these").
  // 0 disables it. Default 3.
  REDDIT_DRAFTER_SENT_TOPK: z.coerce.number().int().min(0).default(3),
  // Global phrasing memory: how many of Orion's most recent replies across the
  // WHOLE feed (all authors) to inject as an avoid-list. 0 disables it. Default 10.
  REDDIT_DRAFTER_RECENT_PHRASINGS_TOPK: z.coerce.number().int().min(0).default(10),
  // Prompt-injection fence (SECURITY). When ON, the drafter wraps the UNTRUSTED
  // Reddit post text, image caption, and top-comments digest in delimiters with a
  // "data, never instructions" guard so a hostile post/comment can't hijack the
  // model. DEFAULT ON for Reddit — Reddit text is attacker-authored and was
  // previously injected UNFENCED. Set 0 only to reproduce the legacy prompt.
  NOELLE_DRAFTER_FENCE: boolFlag.default("1"),
  // Comment targeting. When ON and a post's most-upvoted comment clears
  // REDDIT_COMMENT_TARGET_MIN_SCORE, the drafter grounds the reply in THAT comment
  // (replying under it) instead of the post. DEFAULT ON. Set 0 to always reply to
  // the post.
  REDDIT_COMMENT_TARGETING: boolFlag.default("1"),
  // Minimum score the top comment must have before the drafter targets it (rather
  // than the post). Keeps Orion replying to genuinely-surfaced comments, not a
  // 2-upvote aside. Default 30.
  REDDIT_COMMENT_TARGET_MIN_SCORE: z.coerce.number().int().nonnegative().default(30),

  // ---- Pattern Breaker -----------------------------------------------------
  // Default OFF. When on, the drafter worker (a) drains the AI-refine queue
  // every tick (cheap) and (b) re-analyzes the operator's last-N sent replies
  // for over-used structural patterns at most once per interval, per instance.
  // Mirrors LINKEDIN_PATTERN_BREAKER (docs/pattern-breaker.md); the knob names
  // below are shared with the LinkedIn intern deliberately.
  REDDIT_PATTERN_BREAKER: boolFlag,
  // How often (ms) the full analysis re-runs per instance. Default 6h — it's a
  // corpus-level audit, not a per-lead pass.
  PATTERN_BREAKER_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  // Min posts in a window for a pattern to be flagged (also the corpus floor).
  PATTERN_BREAKER_MIN_FREQUENCY: z.coerce.number().int().positive().default(3),
  // Min SHARE of the window a pattern must cover to count as over-used (0..1).
  PATTERN_BREAKER_MIN_RATIO: z.coerce.number().min(0).max(1).default(0.3),
  // Max posts pulled into the corpus (the largest analysis window).
  PATTERN_BREAKER_MAX_POSTS: z.coerce.number().int().positive().default(100),

  // Vision caption fallback. When no BYO org `gemini-api-key` is configured (the
  // self-host case), caption post images via Vertex Gemini using the worker's
  // attached service account / ADC instead. Default ON; set 0 to force text-only.
  NOELLE_VERTEX_ENABLED: boolFlag.default("1"),
  // Vertex region for the ADC vision caption (and any Vertex engine fallback).
  VERTEX_LOCATION: z.string().default("us-central1"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = EnvSchema.parse(process.env);
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}
