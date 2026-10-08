import { randomUUID } from "node:crypto";
import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listWatchlistOrActiveXInternInstances } from "../lib/activation.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient, APIFY_TOKEN_SECRET_ID } from "../lib/secrets.js";
import { createApifyResolver, type ApifyHandle } from "../lib/apify-resolver.js";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";
import { X_SCRAPER_ACTOR } from "@noelle/x-apify";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY_XAPI } from "@noelle/runtime/pg-budget-adapters";
import {
  createGcsNellaClientWithSdk,
  createLocalFsKnowledgeBase,
  getRepliedPostSources,
  knowledgeBaseFromNella,
  parseIncludeDirs,
  buildEngineRegistry,
} from "@noelle/runtime";
import type { KnowledgeBase } from "@noelle/runtime";
import { getXWatchlistAuthorEngagement } from "../lib/x-ideation-gather-db.js";
import { getOwnPostPerformance } from "../lib/own-post-metrics-db.js";
import {
  claimIdeationRequests,
  finishIdeationRequest,
  type IdeationRequest,
} from "../lib/ideation-requests-db.js";
import { createPostIdeasClient } from "../lib/post-ideas-client.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runIdeationTick } from "./ideation-tick.js";
import { runXSelfTrackTick } from "./x-self-track-tick.js";
import { runOwnAccountTick } from "./own-account-tick.js";
import { readXApiTokens } from "../lib/x-api-tokens.js";
import { buildXApiClient } from "../lib/x-api-client-factory.js";
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
  const ownReader = (apify: ApifyHandle, inst: { id: string; org_id: string }, worker: string) => ({
    userTweets: (args: { handle: string; limit?: number }) => withMeteredApifyCall({
      client: apify.client, recorder, log, orgId: inst.org_id, instanceId: inst.id,
      agentRole: "x_intern", worker, actor: X_SCRAPER_ACTOR, startedAt: new Date(),
      credentialId: apify.credentialId,
    }, operation => operation.userTweets(args)),
  });
  const runner = createCodexRunner({ engines, sql, budget: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI }) }, recorder });
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

  log.info({}, "x ideation worker ready");
  const shouldStop = installShutdown(log);

  // Learn-loop capture sweep: measure the operator's OWN published posts on an
  // interval and snapshot engagement (the feedback consumed by ideation below).
  // Hosted here because ideation is always alive and already resolves Apify, and
  // the interns are draft-only so there's no posting worker to hang it off. A
  // re-entrancy guard prevents overlap; fail-open — a bad sweep never affects
  // ideation. Per-instance failures are isolated inside runXSelfTrackTick.
  if (env.NOELLE_X_SELF_TRACK) {
    const resolveApifyST = createApifyResolver({ sql, secrets, apifyTokenSecretId: APIFY_TOKEN_SECRET_ID, log });
    let sweeping = false;
    const sweep = async () => {
      if (sweeping || shouldStop()) return;
      sweeping = true;
      try {
        const insts = await listWatchlistOrActiveXInternInstances(sql);
        for (const inst of insts) {
          try {
            const apify = await resolveApifyST(inst.org_id);
            if (!apify) continue;
            const res = await runXSelfTrackTick({
              sql,
              instanceId: inst.id,
              orgId: inst.org_id,
              reader: ownReader(apify, inst, "x_self_track"),
              windowDays: env.NOELLE_X_SELF_TRACK_WINDOW_DAYS,
              maxPosts: env.NOELLE_X_SELF_TRACK_MAX,
              log,
            });
            if (res.measured > 0) {
              log.info({ instance: inst.id, measured: res.measured, considered: res.postsConsidered }, "x-self-track sweep");
            }
          } catch (err) {
            log.warn({ instance: inst.id, err: (err as Error).message }, "x-self-track instance failed");
          }
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, "x-self-track sweep failed");
      } finally {
        sweeping = false;
      }
    };
    void sweep(); // prime on boot
    const timer = setInterval(() => void sweep(), env.NOELLE_X_SELF_TRACK_MS);
    if (typeof timer.unref === "function") timer.unref();
    log.info({ everyMs: env.NOELLE_X_SELF_TRACK_MS }, "x own-post tracking enabled");
  }

  // Own-ACCOUNT sweep: refresh the operator's follower/following/post counts onto
  // the bus so the drafter states a real number instead of inventing one (see
  // lib/own-account.ts for the incident this fixes). Hosted here beside the
  // own-POST sweep because ideation is the always-alive worker, but it is a
  // separate loop on purpose: it must keep working when the post sweep cannot
  // (no recent posts, or an exhausted Apify pool), since that is exactly when
  // the follower count went stale. One X API read per sweep.
  if (env.NOELLE_X_OWN_ACCOUNT) {
    const resolveApifyOA = createApifyResolver({ sql, secrets, apifyTokenSecretId: APIFY_TOKEN_SECRET_ID, log });
    let sweepingOA = false;
    const sweepOwnAccount = async () => {
      if (sweepingOA || shouldStop()) return;
      sweepingOA = true;
      try {
        const insts = await listWatchlistOrActiveXInternInstances(sql);
        for (const inst of insts) {
          try {
            const tokens = await readXApiTokens(sql, inst.id);
            const api = tokens
              ? await buildXApiClient({
                  sql,
                  instanceId: inst.id,
                  tokens,
                  envClientId: env.X_API_CLIENT_ID,
                  envClientSecret: env.X_API_CLIENT_SECRET,
                  log,
                })
              : null;
            const res = await runOwnAccountTick({
              bus: busForInstance(inst),
              api,
              // Lazy: never resolves a token when the X API path succeeds, which
              // matters while the pool sits exhausted.
              apify: async () => {
                const apify = await resolveApifyOA(inst.org_id).catch(() => null);
                return apify ? ownReader(apify, inst, "own_account") : null;
              },
              fallbackHandle: tokens?.xHandle ?? null,
              now: new Date(),
              log,
            });
            if (res.snapshot) {
              log.info(
                { instance: inst.id, handle: res.snapshot.handle, followers: res.snapshot.followers, via: res.outcome },
                "own-account snapshot refreshed",
              );
            } else {
              log.warn({ instance: inst.id, outcome: res.outcome }, "own-account snapshot not refreshed");
            }
          } catch (err) {
            log.warn({ instance: inst.id, err: (err as Error).message }, "own-account instance failed");
          }
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, "own-account sweep failed");
      } finally {
        sweepingOA = false;
      }
    };
    void sweepOwnAccount(); // prime on boot
    const timerOA = setInterval(() => void sweepOwnAccount(), env.NOELLE_X_OWN_ACCOUNT_MS);
    if (typeof timerOA.unref === "function") timerOA.unref();
    log.info({ everyMs: env.NOELLE_X_OWN_ACCOUNT_MS }, "x own-account tracking enabled");
  }

  await runWorkerLoop({
    log,
    kind: "ideation",
    pollMs: env.IDEATION_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listWatchlistOrActiveXInternInstances(sql),
    onTick: async (inst) => {
      // Cheap queue read first: most ticks find no pending operator requests.
      const requests = await claimIdeationRequests(sql, {
        agentInstanceId: inst.id,
        batch: env.IDEATION_BATCH,
      });
      if (requests.length === 0) return;

      const gather = async (req: IdeationRequest): Promise<IdeationGather> => {
        const topAuthors = await getXWatchlistAuthorEngagement(sql, {
          agentInstanceId: inst.id,
          windowDays: env.X_ANALYST_WINDOW_DAYS,
          limitAuthors: env.X_ANALYST_TOP_AUTHORS,
          samplePosts: env.X_ANALYST_SAMPLE_POSTS,
          minPosts: env.X_ANALYST_MIN_POSTS,
        });

        let repliedPosts: IdeationGather["repliedPosts"] = [];
        try {
          repliedPosts = await getRepliedPostSources(sql, {
            orgId: inst.org_id,
            platform: "x",
          });
        } catch (err) {
          log.warn({ err: (err as Error).message }, "x ideation replied-post source read failed");
        }

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
            log.warn({ err: (err as Error).message }, "x ideation voice search failed");
          }
        }

        // The LEARN signal: the operator's own measured posts, rolled up by
        // pillar/angle. Fail-open — a read error just drops the bias block.
        let ownPerformance = null;
        if (env.X_IDEATION_OWN_PERF_POSTS > 0) {
          try {
            ownPerformance = await getOwnPostPerformance(sql, {
              instanceId: inst.id,
              windowDays: env.NOELLE_X_SELF_TRACK_WINDOW_DAYS,
              topPosts: env.X_IDEATION_OWN_PERF_POSTS,
            });
          } catch (err) {
            log.warn({ err: (err as Error).message }, "x ideation own-performance read failed");
          }
        }

        return { repliedPosts, topAuthors, keywordPosts: [], voiceAnchors, pillars, ownPerformance };
      };

      for (const req of requests) {
        const bus = busForInstance(inst);
        const run = await recordRun({ sql, kind: "ideation", bus });
        try {
          // X v1 has no polish path (the polish/voice-spec stack is LinkedIn-only
          // so far). Finish a polish request cleanly rather than hang it.
          if (req.mode === "polish") {
            log.info({ req: req.id }, "x ideation: polish not supported yet; no-op");
            await finishIdeationRequest(sql, { id: req.id, status: "done" });
            await run.finish({ status: "ok", rowsProcessed: 0 });
            continue;
          }
          const n = await runIdeationTick({
            log,
            instance: inst,
            request: req,
            gather,
            runner,
            sink: (ideas) => ideasClient.postIdeas({ platform: "x", ideationRequestId: req.id, ideas }),
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
          log.error({ instance: inst.id, req: req.id, err: (err as Error).message }, "x ideation request failed");
        }
      }
    },
    shouldStop,
  });
}

main().catch((err) => {
  console.error("x ideation fatal:", err);
  process.exit(EX_TEMPFAIL);
});
