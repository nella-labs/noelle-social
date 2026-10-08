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
