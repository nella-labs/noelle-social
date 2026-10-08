import { randomUUID } from "node:crypto";
import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveOrPausedLinkedinInternInstances, isPostsLaneEnabled } from "../lib/activation.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient } from "../lib/secrets.js";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY } from "@noelle/runtime/pg-budget-adapters";
import {
  createGcsNellaClientWithSdk,
  createLocalFsKnowledgeBase,
  knowledgeBaseFromNella,
  parseIncludeDirs,
  buildEngineRegistry,
  getRepliedPostSources,
} from "@noelle/runtime";
import type { KnowledgeBase } from "@noelle/runtime";
import { getWatchlistAuthorEngagement } from "../lib/leads-engagement-db.js";
import { getTopPlaybooks } from "../lib/playbooks-db.js";
import {
  claimIdeationRequests,
  finishIdeationRequest,
  type IdeationRequest,
} from "../lib/ideation-requests-db.js";
import { createPostIdeasClient } from "../lib/post-ideas-client.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runIdeationTick } from "./ideation-tick.js";
import { runPolishTick } from "./polish-tick.js";
import type { IdeationGather } from "../lib/ideation.js";

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "ideation", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });

  const boot = await runBootChecks({
    log,
    checks: [{ name: "db.ping", kind: "transient", run: async () => { await sql`select 1 as ok`; } }],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const engines = await buildEngineRegistry({ secrets, log: (msg, meta) => log.info(meta ?? {}, msg) });
  if (Object.keys(engines).length === 0) {
    log.warn({}, "no LLM provider credentials configured; ideation will fail until one is provisioned");
  }

  const recorder = createPgSpendRecorder(sql);
  const runner = createCodexRunner({ engines, sql, budget: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY }) }, recorder });
  const ideasClient = createPostIdeasClient({ baseUrl: env.CP_BASE_URL, hmacSecret: env.NOELLE_HMAC_SECRET });

  // Knowledge base — voice grounding (gcs/local, mirrors the drafter).
  const kbBackend = env.NOELLE_KB_BACKEND ?? env.NOELLE_NELLA_BACKEND;
  let sharedKb: KnowledgeBase | null = null;
  if (kbBackend === "gcs") {
    sharedKb = knowledgeBaseFromNella(
      await createGcsNellaClientWithSdk({ bucket: env.NOELLE_VAULT_BUCKET }),
      env.NELLA_WORKSPACE,
    );
  } else if (kbBackend === "local" && env.NOELLE_VAULT_DIR) {
    const voiceDirs = parseIncludeDirs(env.NOELLE_VOICE_DIRS);
    sharedKb = createLocalFsKnowledgeBase({
      dir: env.NOELLE_VAULT_DIR,
      cacheTtlMs: env.NOELLE_KB_CACHE_TTL_MS,
      includeDirs: voiceDirs,
    });
  }
  const pillars = env.NOELLE_POSTS_PILLARS.split(",").map((s) => s.trim()).filter(Boolean);

  log.info({}, "linkedin ideation worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "ideation",
    pollMs: env.IDEATION_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveOrPausedLinkedinInternInstances(sql),
    onTick: async (inst) => {
      // The Posts lane must be enabled (lane_config, 0049) for ideation to run.
      if (!isPostsLaneEnabled(inst)) return;
      // Cheap queue read first: most ticks find no pending operator requests.
      const requests = await claimIdeationRequests(sql, {
        agentInstanceId: inst.id,
        batch: env.IDEATION_BATCH,
      });
      if (requests.length === 0) return;

      const gather = async (req: IdeationRequest): Promise<IdeationGather> => {
        const repliedPosts = await getRepliedPostSources(sql, {
          orgId: inst.org_id,
          platform: "linkedin",
        }).catch((err) => {
          log.warn({ err: (err as Error).message }, "ideation replied-post source read failed");
          return [];
        });

        const topAuthors = await getWatchlistAuthorEngagement(sql, {
          agentInstanceId: inst.id,
          windowDays: env.LINKEDIN_ANALYST_WINDOW_DAYS,
          limitAuthors: env.LINKEDIN_ANALYST_TOP_AUTHORS,
          samplePosts: env.LINKEDIN_ANALYST_SAMPLE_POSTS,
          minPosts: env.LINKEDIN_ANALYST_MIN_POSTS,
        });

        const playbooks = await getTopPlaybooks(sql, {
          orgId: inst.org_id,
          agentInstanceId: inst.id,
          platform: "linkedin",
          limit: env.LINKEDIN_ANALYST_TOP_AUTHORS,
        });

        let voiceAnchors: string[] = [];
        if (sharedKb) {
          const q = req.topics.length
            ? req.topics.join(" ")
            : inst.objective ?? "the operator's voice and the topics they post about";
          try {
            const hits = await sharedKb.search(q, env.NOELLE_IDEATION_VOICE_TOPK, {
              filterDirs: parseIncludeDirs(env.NOELLE_VOICE_DIRS),
            });
            voiceAnchors = hits.map((h) => h.snippet).filter(Boolean);
          } catch (err) {
            log.warn({ err: (err as Error).message }, "ideation voice search failed");
          }
        }

        return { repliedPosts, topAuthors, keywordPosts: [], playbooks, voiceAnchors, pillars };
      };

      for (const req of requests) {
        const bus = busForInstance(inst);
        const run = await recordRun({ sql, kind: "ideation", bus });
        try {
          const n =
            req.mode === "polish"
              ? await runPolishTick({
                  log,
                  instance: inst,
                  request: req,
                  runner,
                  // Load the target idea, scoped to this instance (tenancy).
                  loadIdea: async (ideaId) => {
                    const rows = await sql<
                      { hook: string; thesis: string | null; angle: string | null; pillar: string | null }[]
                    >`
                      select hook, thesis, angle, pillar
                      from noelle.post_ideas
                      where id = ${ideaId} and agent_instance_id = ${inst.id}
                      limit 1
                    `;
                    return rows[0] ?? null;
                  },
                  // Same voice-anchor retrieval the ideation gather uses.
                  voiceAnchors: async (idea) => {
                    if (!sharedKb) return [];
                    try {
                      const hits = await sharedKb.search(idea.hook, env.NOELLE_IDEATION_VOICE_TOPK, {
                        filterDirs: parseIncludeDirs(env.NOELLE_VOICE_DIRS),
                      });
                      return hits.map((h) => h.snippet).filter(Boolean);
                    } catch {
                      return [];
                    }
                  },
                  apply: async (ideaId, result) => {
                    await sql`
                      update noelle.post_ideas
                      set hook = ${result.hook}, thesis = ${result.thesis}, updated_at = now()
                      where id = ${ideaId} and agent_instance_id = ${inst.id}
                    `;
                  },
                })
              : await runIdeationTick({
                  log,
                  instance: inst,
                  request: req,
                  gather,
                  runner,
                  sink: (ideas) => ideasClient.postIdeas({ platform: "linkedin", ideas, ideationRequestId: req.id }),
                  idFactory: () => randomUUID(),
                  defaultCount: env.IDEATION_DEFAULT_COUNT,
                });
          await finishIdeationRequest(sql, { id: req.id, status: "done" });
          await run.finish({ status: "ok", rowsProcessed: n });
        } catch (err) {
          await finishIdeationRequest(sql, {
            id: req.id,
            status: "error",
            errorMessage: (err as Error).message,
          });
          await run.finish({ status: "error", errorMessage: (err as Error).message });
          log.error({ instance: inst.id, req: req.id, err: (err as Error).message }, "ideation request failed");
        }
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("ideation fatal:", err);
  process.exit(EX_TEMPFAIL);
});
