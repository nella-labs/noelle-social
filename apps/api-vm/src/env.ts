import { z } from "zod";

// Truthy env flag ("1"/"true", case-insensitive). Unset → false. (z.coerce.boolean
// is unsafe here — Boolean("false") is true.) Mirrors apps/x-intern/src/env.ts.
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === "1" || (v ?? "").toLowerCase() === "true");

const boolFlagOn = z
  .string()
  .optional()
  .transform((v) => v === undefined || v === "1" || v.toLowerCase() === "true");

// All Hono service secrets come from GCP Secret Manager at process start
// (see docs/secrets.md). For local dev we read .env.local; for systemd on
// the VM, an EnvironmentFile fetched by the service unit's ExecStartPre.
//
// This service writes directly into the `noelle.*` schema on the installation's
// Postgres database. Hosted mode verifies Supabase JWTs; database reads and
// writes use the `postgres` template-literal client in src/lib/db.ts.

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(18791),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Cloud SQL Postgres 16. Shape:
  //   postgres://noelle_app:<password>@database.example.test:5432/noelle?sslmode=require
  // Required everywhere except in tests that swap the db client out via
  // __setDbClientForTests(); test setup still has to provide a syntactically
  // valid value so the Zod parse passes.
  NOELLE_DATABASE_URL: z.string().min(1),

  // Supabase Auth stays — it's the IdP. We verify the JWT, extract `sub`,
  // and pass it as the trusted user id into Cloud SQL queries.
  NOELLE_SUPABASE_JWT_SECRET: z.string().min(1).optional(),
  NOELLE_SUPABASE_JWKS_URL: z.string().url().optional(),

  NOELLE_HMAC_SECRET: z.string().min(32),

  // Static bearer token for the LinkedIn Actuator browser extension.
  // When unset, the /actuator/* routes return 503.
  NOELLE_ACTUATOR_TOKEN: z.string().optional(),
  NOELLE_ACTUATOR_ORG_ID: z.string().uuid().optional(),

  // The writer uses this flag to run its verifier. The actuator always requires
  // a genuine passing review before serving an unattended comment.
  LINKEDIN_UNATTENDED_AUTOSEND: z.string().optional(),
  // Voice-score floor for an auto-served comment. 0.7 matches the review bar.
  LINKEDIN_AUTOSEND_VOICE_FLOOR: z.coerce.number().min(0).max(1).default(0.7),

  // Reddit reply Actuator server-side backstops. Documented here for
  // discoverability only; the actuator route reads these via process.env directly
  // (mirroring the X actuator's NOELLE_X_ACTUATOR_* + the NOELLE_LINKEDIN_DAILY_WRITE_CAP
  // pattern), so — like the X actuator knobs — they are NOT consumed via loadEnv:
  //   NOELLE_REDDIT_ACTUATOR_DAILY_WRITE_CAP      — max replies served per org per day (default 8).
  //   NOELLE_REDDIT_ACTUATOR_HALT_ON_CHALLENGE    — '1'/'true' halts the send queue on a Reddit
  //                                                 challenge/throttle in the last hour (default OFF).
  //   NOELLE_REDDIT_ACTUATOR_BLOCK_EXTERNAL_LINKS — withhold replies whose body carries a
  //                                                 non-reddit link (default ON; set "0" to allow).

  // GCP Secret Manager project. Used by the synchronous X-post path in
  // POST /api/drafts/:id/send to read per-org x-cookies-ct0 / -auth-token.
  // Defaults to the live project so production never needs to set it; tests
  // override via Zod's parse before the route reads it.
  GCP_PROJECT: z.string().min(1).default("noelle-agents"),

  // X API OAuth 2.0 app credentials. Used as a fallback client id/secret when the
  // manual /send path refreshes an OAuth2 token whose row lacks a stored
  // consumer_key (RC4). Same app as the x-intern workers use.
  X_API_CLIENT_ID: z.string().optional(),
  X_API_CLIENT_SECRET: z.string().optional(),

  PUSHOVER_USER_KEY: z.string().optional(),
  PUSHOVER_APP_TOKEN: z.string().optional(),

  // Dashboard origin used for Pushover deeplinks. When unset we skip the
  // Pushover fire entirely so local-dev runs do not send broken dashboard links.
  NOELLE_APP_BASE_URL: z.string().url().optional(),

  // Notify only once per this many drafted bundles per agent, instead of once
  // per lead (a busy keyword/goal run otherwise pages the operator on every
  // single draft). 1 = every lead (default, back-compat). Self-host sets this to
  // 10. In-memory per-agent count in the api-vm process; resets on restart.
  NOELLE_NOTIFY_BATCH: z.coerce.number().int().min(1).default(1),

  // Content-media storage. self-host = "local" (files under NOELLE_MEDIA_DIR,
  // served same-origin by the Next app at /media/<key>); prod = "gcs" (per-org
  // bucket). NOELLE_MEDIA_PUBLIC_BASE_URL prefixes local urls (default ""→ the
  // relative "/media/<key>", which is reachable wherever the dashboard is).
  NOELLE_MEDIA_BACKEND: z.enum(["local", "gcs"]).default("local"),
  NOELLE_MEDIA_DIR: z.string().default("./.noelle-media"),
  NOELLE_MEDIA_BUCKET: z.string().optional(),
  NOELLE_MEDIA_PUBLIC_BASE_URL: z.string().default(""),

  // ── Vega auto-curate (grade-gated auto-schedule) ──────────────────────────
  // The master on/off switch. When ON, Vega's (x_intern) X posts skip the
  // per-idea + per-draft manual review: freshly-ideated X ideas auto-approve so
  // the post-drafter drafts them, and each generated X draft is GRADE-GATED at
  // POST /api/post-drafts — a draft scoring at/above MIN_SCORE is auto-scheduled
  // (paced) into a content_schedule_slot; one below is dismissed. Default OFF:
  // with it unset the Content pipeline is byte-identical to today (review-first).
  // X/Vega-only, fail-open, and — for auto_publish — still gated downstream by
  // the instance's x_api_write_enabled + send_enabled (nothing posts otherwise).
  // Requires the post-drafter's NOELLE_POST_VERIFY to be ON: with no score the
  // gate can't grade, so it falls back to manual review (never blind-schedules).
  NOELLE_POST_AUTOSCHEDULE: boolFlag,
  // The overall-score bar on a 0-100 scale (the draft's quality_score is the
  // 0..1 mean of voice/grounding/relevance/format; we normalize /100). A draft
  // at/above this AND not verifier-failed is scheduled; otherwise dismissed.
  NOELLE_POST_AUTOSCHEDULE_MIN_SCORE: z.coerce.number().min(0).max(100).default(70),
  // Whether qualifying slots carry auto_publish=true (Vega posts them via the
  // official X API, still gated by x_api_write_enabled) or false (a `ready`
  // copy-out slot on the calendar — schedule without auto-posting). Default true
  // matches "auto_publish=true"; flip to false to get the pacing without posting.
  NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH: boolFlagOn,
  // Pacing ("don't burst"): minimum minutes between two auto-scheduled slots.
  // Each new qualifying draft is placed spacing-minutes after the last active
  // future slot, so a batch fans out over time instead of firing at once.
  NOELLE_POST_AUTOSCHEDULE_SPACING_MIN: z.coerce.number().int().min(1).default(180),
  // The earliest an auto-scheduled slot may fire, in minutes from now (a small
  // lead so a just-graded post isn't slotted in the past / this instant).
  NOELLE_POST_AUTOSCHEDULE_LEAD_MIN: z.coerce.number().int().min(0).default(15),

  // ── Recurring scheduled run (0085_run_schedule.sql) ───────────────────────
  // Global kill switch for the api-vm scheduler loop, which auto-fires armed
  // per-instance schedules (run_schedule) on their cadence. Default ON: the loop
  // only ever acts on rows an operator has explicitly armed from the agent page,
  // so running it changes nothing until a schedule exists. Set to "0"/"false" to
  // stop the loop process-wide (armed schedules then simply never fire).
  NOELLE_RUN_SCHEDULER: boolFlagOn,
  // How often the scheduler polls for due schedules, in ms. 60s is well below the
  // finest cadence (hourly) so a run fires within a minute of its scheduled time.
  NOELLE_RUN_SCHEDULER_POLL_MS: z.coerce.number().int().min(5_000).default(60_000),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = EnvSchema.parse(process.env);
  return cached;
}

// Test-only escape hatch (vitest sets process.env per test) — clears the
// memoized parse so a re-load picks up the new values.
export function resetEnvForTests() {
  cached = undefined;
}
