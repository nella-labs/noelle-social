// Connection Follow-up — Lyra's on-demand relationship helper.
//
// The operator just connected with someone on LinkedIn and wants to build a
// GENUINE relationship. They name the person; Lyra scrapes that person's recent
// posts + the comments they've authored on others' posts (via the same Apify
// actors the profiler uses — no li_at, no session fragility), reuses any prior
// Lyra profile summary, and generates a connection brief: common ground, talking
// points, a list of genuine questions, and a warm follow-up DM. Draft-only.
//
// This is a ONE-SHOT command, not a poll loop. Run it on the Lima VM the same way
// every worker is invoked:
//     cd apps/linkedin-intern && ./run.sh followup --person <url|/in/slug|slug>
// Flags: --posts <n> (default 20), --comments <n> (default 12), --json.
//
// Wiring mirrors workers/profiler.ts (db, secrets, Apify resolver, Bedrock +
// CodexRunner). Diagnostics go to STDERR so stdout stays clean for --json.

import { loadEnv } from "../env.js";
import { loadOperatorEnvFile } from "../lib/dotenv.js";
import { noelleDb } from "../lib/db.js";
import { createSecretsClient, SecretAccessError, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { createApifyResolver } from "../lib/apify-resolver.js";
import { createCodexRunner } from "../lib/codex-runner.js";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import {
  createBedrockBackend,
  createClaudeCliBackend,
  type EngineBackend,
  type CreateClaudeCliBackendOptions,
} from "@noelle/runtime";
import { linkedinPublicId } from "@noelle/contracts";
import {
  listProfilerLinkedinInternInstances,
  type ActiveInstance,
} from "../lib/activation.js";
import { getWatchlistProfiles } from "../lib/watchlist-db.js";
import { linkedinInternRouting, opusOverrideRouting } from "../lib/routing.js";
import {
  buildConnectionBrief,
  type ConnectionBrief,
  type FollowupPerson,
  type FollowupPost,
} from "../lib/followup.js";

interface FollowupArgs {
  person?: string;
  posts: number;
  comments: number;
  json: boolean;
  orgId?: string;
  instanceId?: string;
}

function parseArgs(argv: string[]): FollowupArgs {
  const a: FollowupArgs = { posts: 20, comments: 12, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--person" || t === "-p") a.person = argv[++i];
    else if (t === "--posts") a.posts = Number(argv[++i]);
    else if (t === "--comments") a.comments = Number(argv[++i]);
    else if (t === "--json") a.json = true;
    else if (t === "--org") a.orgId = argv[++i];
    else if (t === "--instance") a.instanceId = argv[++i];
    else if (t && !t.startsWith("-")) positional.push(t);
    // unknown --flags are ignored
  }
  if (!a.person && positional.length > 0) a.person = positional[0];
  return a;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Pick the linkedin_intern instance to attribute this run to. Filter by
 *  --instance / --org when given; otherwise the first (self-host is single-tenant). */
function selectInstance(instances: ActiveInstance[], args: FollowupArgs): ActiveInstance | null {
  let pool = instances;
  if (args.instanceId) pool = pool.filter((i) => i.id === args.instanceId);
  if (args.orgId) pool = pool.filter((i) => i.org_id === args.orgId);
  return pool[0] ?? null;
}

function printBrief(
  brief: ConnectionBrief,
  grounded: { posts: number; comments: number; usedSummary: boolean },
): void {
  const out: string[] = [];
  const who = brief.person.name ?? brief.person.publicId ?? "this person";
  const slug = brief.person.publicId ? ` (linkedin.com/in/${brief.person.publicId})` : "";
  out.push("");
  out.push(`Connection follow-up · ${who}${slug}`);
  if (brief.person.headline) out.push(brief.person.headline);
  const src = [
    `${grounded.posts} post${grounded.posts === 1 ? "" : "s"}`,
    `${grounded.comments} comment${grounded.comments === 1 ? "" : "s"}`,
    grounded.usedSummary ? "prior profile" : null,
  ]
    .filter(Boolean)
    .join(", ");
  out.push(`grounded on ${src} · ${brief.model}`);

  if (brief.commonGround.length > 0) {
    out.push("", "COMMON GROUND");
    for (const c of brief.commonGround) out.push(`  • ${c}`);
  }
  if (brief.talkingPoints.length > 0) {
    out.push("", "TALKING POINTS");
    for (const t of brief.talkingPoints) out.push(`  • ${t}`);
  }
  out.push("", "GENUINE QUESTIONS TO ASK");
  brief.questions.forEach((q, i) => out.push(`  ${i + 1}. ${q}`));

  out.push("", "FOLLOW-UP DM (draft — copy + send by hand; Lyra never sends)");
  for (const line of brief.followupDm.split("\n")) out.push(`  ${line}`);
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const publicId = linkedinPublicId(args.person ?? "");
  if (!publicId) {
    console.error(
      "followup: name the person you connected with — --person <profile URL | /in/slug | bare slug>",
    );
    process.exit(2);
  }
  const postLimit = clamp(args.posts, 1, 50, 20);
  const commentLimit = clamp(args.comments, 0, 40, 12);

  // One-shot: pm2 didn't inject ~/.noelle/.env, so load it ourselves (canonical
  // parse, existing env wins) BEFORE the first loadEnv() reads process.env.
  loadOperatorEnvFile();

  const env = loadEnv();
  const sql = noelleDb();
  try {
    const secrets = createSecretsClient({ project: env.GCP_PROJECT });

    const instances = await listProfilerLinkedinInternInstances(sql);
    const inst = selectInstance(instances, args);
    if (!inst) {
      console.error("followup: no linkedin_intern instance found — run `noelle migrate` first.");
      process.exit(1);
    }

    const resolveApify = createApifyResolver({
      sql,
      secrets,
      apifyTokenSecretId: APIFY_TOKEN_SECRET_ID,
      profilePostsActorId: env.APIFY_PROFILE_POSTS_ACTOR_ID,
      log: { warn: (obj, msg) => console.error(`followup: ${msg}`, obj) },
    });
    const apify = await resolveApify(inst.org_id);
    if (!apify) {
      console.error(
        "followup: no Apify token configured — add one on the dashboard Connections page (Data sources → Apify).",
      );
      process.exit(1);
    }

    const recorder = createPgSpendRecorder(sql);

    // 1) Their recent posts.
    console.error(`followup: scraping linkedin.com/in/${publicId} (${postLimit} posts) …`);
    const rawPosts = await withMeteredApifyCall({ client: apify.client, recorder,
      log: { warn: (obj, message) => console.error(`followup: ${message}`, obj) },
      orgId: inst.org_id, instanceId: inst.id, agentRole: "linkedin_intern", worker: "followup",
      actor: "linkedin-profile-posts", startedAt: new Date(), credentialId: apify.credentialId },
      operation => operation.profilePosts({ publicId, maxPosts: postLimit }));

    // 2) Comments they authored on others' posts (their engagement voice). Best-effort.
    let rawComments: Awaited<ReturnType<typeof apify.client.authoredComments>> = [];
    if (commentLimit > 0) {
      try {
        rawComments = await withMeteredApifyCall({ client: apify.client, recorder,
          log: { warn: (obj, message) => console.error(`followup: ${message}`, obj) },
          orgId: inst.org_id, instanceId: inst.id, agentRole: "linkedin_intern", worker: "followup",
          actor: "linkedin-profile-comments", startedAt: new Date(), credentialId: apify.credentialId },
          operation => operation.authoredComments({ publicId, maxComments: commentLimit }));
      } catch (err) {
        console.error(
          "followup: authored-comments fetch failed (continuing with posts only):",
          (err as Error).message,
        );
      }
    }

    // 3) Reuse a prior Lyra profile summary if this person is already watched.
    let existingSummary: string | null = null;
    try {
      const profiles = await getWatchlistProfiles(sql, inst.id);
      for (const p of profiles.values()) {
        if (p.publicId && p.publicId.toLowerCase() === publicId && p.summary) {
          existingSummary = p.summary;
