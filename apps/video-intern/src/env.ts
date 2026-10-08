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
  NOELLE_WORKER_KIND: z
    .enum(["harvester", "teardown", "distiller", "scripter", "ideator", "skiller", "briefer"])
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
  // Where the skiller writes one SKILL.md per distilled viral pattern. Explicit
  // override; otherwise it defaults to <NOELLE_VAULT_DIR>/skills/video-patterns
  // (see videoSkillsDir in lib/skill-emit.ts). Unset + no vault → skiller no-ops.
  NOELLE_VIDEO_SKILLS_DIR: z.string().optional(),
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

  // Gemini API key (generativelanguage) — the reliable multimodal path for the
  // teardown analyzer on Lima (Vertex user-ADC dies with invalid_rapt). Also the
  // last-resort fallback for the TEXT generators (ideator/scripter/grader) when
  // neither claude-cli nor Bedrock creds are present.
  NOELLE_GEMINI_API_KEY: z.string().optional(),

  // Route the TEXT generators (ideator/scripter/objective-grader) through the
  // local `claude -p` subscription ($0, Opus) instead of Vertex Gemini — the
  // same flag the agent workers use. Set on the Lima VM, where Gemini text calls
  // flake/empty. Falls back to Bedrock creds, then the Gemini key.
  NOELLE_CLAUDE_CLI: z.string().optional(),
  // Bedrock model handle for the text generators when routed to Bedrock (claude-cli
  // ignores it and always uses Opus). Default a strong, available model.
  // NOELLE_VAULT_DIR / NOELLE_VOICE_DIRS (above) also feed the ideator/scripter
  // brand-voice grounding now, not just the teardown analyzer.
  NOELLE_VIDEO_TEXT_MODEL: z.string().default("claude-sonnet-4-6"),

  // Grade niche/viral clips against the instance objective at harvest time
  // (Vega-style relevance filter). Default OFF; fail-open when on.
  NOELLE_NOVA_OBJECTIVE_GRADE: boolFlag,

  // 24/7 own-account tracking. The harvester periodically re-pulls is_own
  // sources (the operator's own IG/TikTok handle) and snapshots their post
  // performance, independent of the manual harvest flag.
  // Default OFF: Nova is parked in maintenance mode while focus is on the text
  // platforms (Vega, Lyra, Orion). This sweep is Nova's only automatic loop, so
  // OFF-by-default means Nova does nothing until harvested by hand. Set to 1 to
  // reactivate own-account tracking when Nova comes back.
  NOELLE_VIDEO_SELF_TRACK: boolFlag.default("0"),
  // How often the own-account sweep runs (ms). Default 6h.
  NOELLE_VIDEO_SELF_TRACK_MS: z.coerce.number().int().positive().default(6 * 60 * 60_000),
  // How many of the operator's own posts to pull each refresh.
  NOELLE_VIDEO_SELF_TRACK_POSTS: z.coerce.number().int().positive().default(50),
  // How far back to look for the operator's posts (days).
  NOELLE_VIDEO_SELF_TRACK_WINDOW_DAYS: z.coerce.number().int().positive().default(365),

  // Codex CLI binary path (preinstalled on VM).
  CODEX_BIN: z.string().default("codex"),

  // Poll cadences (ms).
  DISCOVERY_POLL_MS: z.coerce.number().int().positive().default(15 * 60_000),
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
  REDDIT_DAILY_SUBSTANTIAL_CAP: z.coerce.number().int().positive().default(30),
  // Daily ceiling on how many LIGHT (short supportive) posts the drafter drafts
  // per instance per calendar day. Independent of the substantial cap.
  REDDIT_DAILY_LIGHT_CAP: z.coerce.number().int().positive().default(20),

  // Goal stall-guard: auto-pause a goal-run that has made no progress (0 new
  // leads) for this many minutes. Stops an unreachable target from polling Apify
  // forever. Default 2h.
  REDDIT_GOAL_STALL_MIN: z.coerce.number().int().positive().default(120),

  // Posts fetched per subreddit per DISCOVERY tick. Small + gentle — discovery
  // only needs the freshest handful; Apify bills per post.
  REDDIT_DISCOVERY_LIMIT: z.coerce.number().int().positive().default(15),

  // Apify (posts transport). Token comes from secrets (NOELLE_SECRET_APIFY_TOKEN);
  // the actor id defaults to parseforge~reddit-posts-scraper in @noelle/reddit-apify
  // and is overridable here when the actor rotates.
  INSTAGRAM_ACTOR_ID: z.string().optional(),
  TIKTOK_ACTOR_ID: z.string().optional(),

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
  // Run the post-draft verifier + regenerate loop on Nova's SCRIPTS (voice /
  // grounding / relevance / format). Off → scripts written unverified (legacy).
  NOELLE_DRAFTER_VERIFY: boolFlag,
  // Max regenerate attempts on a failed verdict before keeping the best try.
  NOELLE_DRAFTER_VERIFY_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  // Voice floor (0-1). A script whose voice score is below this fails the verdict
  // (marked 'below bar' in the trace) and regenerates. 0 disables it. Default 0.65.
  NOELLE_DRAFTER_VOICE_FLOOR: z.coerce.number().min(0).max(1).default(0.65),
  // Voice variety: per lead, randomly assign a "register" and inject it into the
  // comment-drafting prompt so comments vary in length + energy across the feed
  // (see lib/register.ts). Default OFF → byte-identical drafts. Mirrors x-intern.
  NOELLE_DRAFTER_VARIETY: boolFlag,
  // Per-author memory: how many of the replies Orion already sent/queued to a
  // post's author to inject into the comment prompt ("do not repeat these").
  // 0 disables it. Default 3.
  REDDIT_DRAFTER_SENT_TOPK: z.coerce.number().int().min(0).default(3),
  // Global phrasing memory: how many of Orion's most recent replies across the
  // WHOLE feed (all authors) to inject as an avoid-list. 0 disables it. Default 10.
  REDDIT_DRAFTER_RECENT_PHRASINGS_TOPK: z.coerce.number().int().min(0).default(10),
  // Vision caption fallback. When no BYO org `gemini-api-key` is configured (the
  // self-host case), caption post images via Vertex Gemini using the worker's
  // attached service account / ADC instead. Default ON; set 0 to force text-only.
  NOELLE_VERTEX_ENABLED: boolFlag.default("1"),
  // Vertex region for the ADC vision caption (and any Vertex engine fallback).
  VERTEX_LOCATION: z.string().default("us-central1"),

  // ── Phase 2: teardown (W2) + distiller (W3) ──
  TEARDOWN_POLL_MS: z.coerce.number().int().positive().default(60_000),
  TEARDOWN_BATCH: z.coerce.number().int().positive().default(8),
  TEARDOWN_DAILY_CAP: z.coerce.number().int().positive().default(200),
  // faster-whisper model size for transcription (base/small/medium). Unset → base.
  WHISPER_MODEL: z.string().optional(),
  DISTILLER_POLL_MS: z.coerce.number().int().positive().default(300_000),
  DISTILLER_EMBED_BATCH: z.coerce.number().int().positive().default(50),
  // W3b Skiller — how often it re-emits SKILL.md files from the Brand Guides.
  // Cheap (pure FS writes), so it can trail the distiller loosely. Default 10 min.
  SKILLER_POLL_MS: z.coerce.number().int().positive().default(600_000),
  // ── Phase 3: ideator (W4 Muse) + scripter (W4 Scribe) ──
  IDEATOR_POLL_MS: z.coerce.number().int().positive().default(30_000),
  SCRIPTER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  SCRIPTER_BATCH: z.coerce.number().int().positive().default(4),
  // ── Phase 6: briefer (W6 media intern) — recording briefs for approved drafts ──
  // Flag-gated so the worker is DORMANT until enabled (merging is safe). Off →
  // the briefer entrypoint logs and exits without touching the DB.
  NOELLE_BRIEFER: boolFlag,
  BRIEFER_POLL_MS: z.coerce.number().int().positive().default(30_000),
  BRIEFER_BATCH: z.coerce.number().int().positive().default(4),
  // Voyage key for clip embeddings (the dense retrieval layer). Unset → embedding
  // skipped (dormant, like the account-feeder dense path until a key is set).
  VOYAGE_API_KEY: z.string().optional(),

  // ── Personal brand state (all default OFF → dormant until opted in). When on,
  //    the distiller regenerates <vault>/<first voice dir>/personal-brand-state.md
  //    (account profile + self metrics + brand-doc snippets) after each account
  //    distillation, and the scripter PREFERS that artifact ahead of BM25 anchors.
  //    Fully fail-open: a missing vault/file leaves live behavior byte-identical. ──
  NOELLE_PERSONAL_BRAND_STATE: boolFlag,
  // Override the artifact path. Default: <NOELLE_VAULT_DIR>/<first NOELLE_VOICE_DIRS
  // entry>/personal-brand-state.md (vault root only when no voice dirs are set).
  // Must live under a scanned dir, or the KB won't index it for retrieval.
  NOELLE_PERSONAL_BRAND_STATE_PATH: z.string().optional(),
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
