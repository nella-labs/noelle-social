import { loadEnv } from "../env.js";
import { createLogger } from "../lib/logger.js";
import { noelleDb } from "../lib/db.js";
import { listActiveOrPausedPostPipelineInstances, isPostsLaneEnabled } from "../lib/activation.js";
import { recordRun } from "../lib/worker-runs.js";
import { busForInstance } from "../lib/bus.js";
import { runBootChecks, EX_TEMPFAIL } from "../lib/boot.js";
import { createSecretsClient } from "../lib/secrets.js";
import { createCodexRunner } from "../lib/codex-runner.js";
import { createPgSpendRecorder } from "@noelle/runtime/pg-spend-recorder";
import {
  createPgBudgetAdapters,
  CAP_EXEMPT_ENGINES_APIFY,
} from "@noelle/runtime/pg-budget-adapters";
import {
  createGcsNellaClientWithSdk,
  createLocalFsKnowledgeBase,
  knowledgeBaseFromNella,
  parseIncludeDirs,
  buildEngineRegistry,
} from "@noelle/runtime";
import type { KnowledgeBase, VerifierCall, AgentRole, ModelRouting } from "@noelle/runtime";
import { resolveWorkerRouting } from "@noelle/runtime";
import { linkedinInternRouting } from "../lib/routing.js";
import { getTopPlaybooks } from "../lib/playbooks-db.js";
import {
  claimApprovedIdeas,
  getInspirationPostTexts,
  getStandingRules,
  getIdeaChatGuidance,
  releaseIdeaToApproved,
  clearPendingPlatforms,
  type ApprovedIdea,
} from "../lib/post-ideas-db.js";
import { createPostDraftsClient } from "../lib/post-drafts-client.js";
import { runWorkerLoop, installShutdown } from "./_runtime.js";
import { runPostDrafterTick } from "./post-drafter-tick.js";
import type { PostDraftContext } from "../lib/post-drafter.js";
import { gatherPostKnowledgeAnchors } from "../lib/post-drafter-context.js";
import {
  listStyleExemplars,
  listStyleExemplarsForHandle,
  listUltraProfiles,
  getUltraProfileForHandle,
  type StyleExemplarRow,
  type UltraProfileRow,
} from "../lib/account-feeder-db.js";
import { readPinnedHandle, pinnedSelectConfig } from "@noelle/runtime";
import { AccountFeederConfigSchema } from "@noelle/contracts";

async function main() {
  const env = loadEnv();
  const log = createLogger({ kind: "post-drafter", workerId: env.WORKER_ID });
  const sql = noelleDb();
  const secrets = createSecretsClient({ project: env.GCP_PROJECT });

  const boot = await runBootChecks({
    log,
    checks: [
      {
        name: "db.ping",
        kind: "transient",
        run: async () => {
          await sql`select 1 as ok`;
        },
      },
    ],
  });
  if (!boot.ok) process.exit(boot.exitCode);

  const engines = await buildEngineRegistry({
    secrets,
    log: (msg, meta) => log.info(meta ?? {}, msg),
  });
  if (Object.keys(engines).length === 0) {
    log.warn(
      {},
      "no LLM provider credentials configured; post-drafter will fail until one is provisioned",
    );
  }

  const recorder = createPgSpendRecorder(sql);
  const runner = createCodexRunner({
    engines,
    sql,
    budget: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY }) },
    recorder,
  });
  const draftsClient = createPostDraftsClient({
    baseUrl: env.CP_BASE_URL,
    hmacSecret: env.NOELLE_HMAC_SECRET,
  });

  // Voice knowledge base (gcs/local), mirrors the reply drafter + ideation.
  const kbBackend = env.NOELLE_KB_BACKEND ?? env.NOELLE_NELLA_BACKEND;
  let sharedKb: KnowledgeBase | null = null;
  if (kbBackend === "gcs") {
    sharedKb = knowledgeBaseFromNella(
      await createGcsNellaClientWithSdk({ bucket: env.NOELLE_VAULT_BUCKET }),
      env.NELLA_WORKSPACE,
    );
  } else if (kbBackend === "local" && env.NOELLE_VAULT_DIR) {
    sharedKb = createLocalFsKnowledgeBase({
      dir: env.NOELLE_VAULT_DIR,
      cacheTtlMs: env.NOELLE_KB_CACHE_TTL_MS,
      includeDirs: [
        ...new Set([
          ...parseIncludeDirs(env.NOELLE_VOICE_DIRS),
          ...parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS),
        ]),
      ],
    });
  }

  log.info({}, "linkedin post-drafter worker ready");
  const shouldStop = installShutdown(log);

  await runWorkerLoop({
    log,
    kind: "post-drafter",
    pollMs: env.POST_DRAFTER_POLL_MS,
    idlePollMs: env.IDLE_POLL_MS,
    listActive: () => listActiveOrPausedPostPipelineInstances(sql),
    onTick: async (inst) => {
      // X-owned ideas (Vega) belong to the X intern, which has no lane_config —
      // its posts lane is "on" whenever it has approved ideas (queue-driven, like
      // X ideation). LinkedIn keeps its lane_config gate for recurring post work,
      // but explicit MCP/operator generation requests still run while the lane is
      // off by switching the claim to request-only mode below.
      const isX = inst.role === "x_intern";
      const includeRecurring = isX || isPostsLaneEnabled(inst);
      // Attribute spend + pick routing per owning intern; the LinkedIn path is
      // byte-identical to before (linkedinInternRouting + linkedin_intern role).
      const agentRole: AgentRole = isX ? "x_intern" : "linkedin_intern";
      const routing: ModelRouting = isX
        ? (resolveWorkerRouting(
            "drafter",
            inst.model_overrides as Parameters<typeof resolveWorkerRouting>[1],
          ) ?? linkedinInternRouting(inst))
        : linkedinInternRouting(inst);
      const ideas = await claimApprovedIdeas(sql, {
        agentInstanceId: inst.id,
        batch: env.POST_DRAFTER_BATCH,
        requestOnly: !includeRecurring,
      });
      if (ideas.length === 0) return;

      const playbooks = await getTopPlaybooks(sql, {
        orgId: inst.org_id,
        agentInstanceId: inst.id,
        platform: isX ? "x" : "linkedin",
        limit: env.LINKEDIN_ANALYST_TOP_AUTHORS,
      });
      const hookPatterns = [...new Set(playbooks.flatMap((p) => p.hookPatterns))].slice(0, 12);
      const standingRules = await getStandingRules(sql, {
        agentInstanceId: inst.id,
        lane: "posts",
      });

      // Account Feeder STYLE for posts (kind='post'). Two modes, both fail-open:
      //  - PINNED (account_feeder_config.pinnedStyleHandle set): ground the STYLE
      //    block in ONLY that account's real posts + ultra profile (enabled-
      //    independent), and force style ON even if NOELLE_POST_STYLE is off — the
      //    operator asked for this voice by name.
      //  - AUTO (no pin, NOELLE_POST_STYLE on): the F8 blend over the enabled pool.
      // Loaded ONCE per tick and reused across the batch. Any error → no style.
      const style = await loadPostStyleInputs(
        sql,
        inst,
        env.NOELLE_POST_STYLE,
        env.NOELLE_POST_STYLE_POOL,
      ).catch((err: unknown) => {
        log.warn(
          { instance: inst.id, err: String(err) },
          "post-style load failed; drafting without style",
        );
        return {
          stylePool: [],
          styleUltraProfiles: [],
          postStyleEnabled: false,
          styleConfig: undefined,
        } as PostStyleInputs;
      });

      const gather = async (idea: ApprovedIdea): Promise<PostDraftContext> => {
        let voiceAnchors: string[] = [];
        let knowledgeAnchors: string[] = [];
        const query = [idea.hook, idea.thesis ?? ""].join(" ");
        if (sharedKb) {
          try {
            const hits = await sharedKb.search(query, env.NOELLE_IDEATION_VOICE_TOPK, {
              filterDirs: parseIncludeDirs(env.NOELLE_VOICE_DIRS),
            });
            voiceAnchors = hits.map((h) => h.snippet).filter(Boolean);
          } catch (err) {
            log.warn({ err: (err as Error).message }, "post-drafter voice search failed");
          }
          try {
            knowledgeAnchors = await gatherPostKnowledgeAnchors(
              sharedKb,
              query,
              parseIncludeDirs(env.NOELLE_KNOWLEDGE_DIRS),
              env.NOELLE_DRAFTER_KNOWLEDGE_TOPK,
            );
          } catch (err) {
            log.warn({ err: (err as Error).message }, "post-drafter factual search failed");
          }
        }
        const externalIds = idea.inspirationRefs
          .map((r) => r.leadId)
          .filter((x): x is string => Boolean(x));
        const inspirationExcerpts = await getInspirationPostTexts(sql, {
          agentInstanceId: inst.id,
          externalIds,
        });
        const chatGuidance = await getIdeaChatGuidance(sql, idea.id);
        return {
          hook: idea.hook,
          thesis: idea.thesis,
          angle: idea.angle,
          pillar: idea.pillar,
          voiceAnchors,
          knowledgeAnchors,
          inspirationExcerpts,
          hookPatterns,
          standingRules,
          chatGuidance,
        };
      };

      const makeVerifierCalls = (opts?: { force?: boolean }): VerifierCall[] => {
        if (!env.NOELLE_POST_VERIFY && !opts?.force) return [];
        const call: VerifierCall = async (system, prompt) => {
          const res = await runner.draft({
            bucket: "post-drafter",
            routing,
            orgId: inst.org_id,
            instanceId: inst.id,
            worker: "post-verifier",
            agentRole,
            system,
            prompt,
          });
          return res.text;
        };
        return [call];
      };

      const bus = busForInstance(inst);
      const run = await recordRun({ sql, kind: "post-drafter", bus });
      try {
        const n = await runPostDrafterTick({
          log,
          instance: inst,
          ideas,
          gather,
          runner,
          agentRole,
          routing,
          makeVerifierCalls,
          verifyRetries: env.NOELLE_POST_VERIFY_RETRIES,
          sink: (draft) => draftsClient.postDraft(draft),
          release: (ideaId) => releaseIdeaToApproved(sql, ideaId),
          clearPending: (ideaId) => clearPendingPlatforms(sql, ideaId),
          cta: {
            product: env.NOELLE_POSTS_CTA_PRODUCT || undefined,
            url: env.NOELLE_POSTS_CTA_URL || undefined,
            tagline: env.NOELLE_POSTS_CTA_TAGLINE || undefined,
          },
          stylePool: style.stylePool,
          styleUltraProfiles: style.styleUltraProfiles,
          postStyleEnabled: style.postStyleEnabled,
          styleConfig: style.styleConfig,
        });
        await run.finish({ status: "ok", rowsProcessed: n });
      } catch (err) {
        await run.finish({ status: "error", errorMessage: (err as Error).message });
        throw err;
      }
    },
    shouldStop,
  });
}

interface PostStyleInputs {
  stylePool: StyleExemplarRow[];
  styleUltraProfiles: UltraProfileRow[];
  postStyleEnabled: boolean;
  /** Config override for selectStyleExemplars (pinned mode bumps exemplars). */
  styleConfig?: unknown;
}

/**
 * Load the post-lane STYLE inputs (kind='post', LinkedIn corpus) for one instance.
 * PINNED mode wins over AUTO and over the env gate; both fail open to no style.
 * X-owned (Vega) instances have no LinkedIn style corpus, so the queries just
 * return empty for them — a harmless no-op.
 */
async function loadPostStyleInputs(
  sql: ReturnType<typeof noelleDb>,
  inst: { id: string; account_feeder_config?: unknown },
  postStyleFlag: boolean,
  poolLimit: number,
): Promise<PostStyleInputs> {
  const off: PostStyleInputs = { stylePool: [], styleUltraProfiles: [], postStyleEnabled: false };
  const pinnedHandle = readPinnedHandle(inst.account_feeder_config);

  if (pinnedHandle) {
    const [pool, profile] = await Promise.all([
      listStyleExemplarsForHandle(sql, {
        agentInstanceId: inst.id,
        platform: "linkedin",
        kind: "post",
        handle: pinnedHandle,
        limit: poolLimit,
      }),
      getUltraProfileForHandle(sql, {
        agentInstanceId: inst.id,
        platform: "linkedin",
        handle: pinnedHandle,
      }),
    ]);
    // Pinned source with no post corpus yet → fail open to no style (don't silently
    // fall back to the blend the operator explicitly opted out of).
    if (pool.length === 0) return off;
    return {
      stylePool: pool,
      styleUltraProfiles: profile ? [profile] : [],
      postStyleEnabled: true,
      styleConfig: pinnedSelectConfig(inst.account_feeder_config),
    };
  }

  if (!postStyleFlag) return off;
  const parsed = AccountFeederConfigSchema.safeParse(
    inst.account_feeder_config && typeof inst.account_feeder_config === "object"
      ? inst.account_feeder_config
      : {},
  );
  const minPerformancePercentile = parsed.success
    ? parsed.data.minPerformancePercentile
    : AccountFeederConfigSchema.parse({}).minPerformancePercentile;
  const [pool, profiles] = await Promise.all([
    listStyleExemplars(sql, {
      agentInstanceId: inst.id,
      platform: "linkedin",
      kind: "post",
      limit: poolLimit,
      minPerformancePercentile,
    }),
    listUltraProfiles(sql, { agentInstanceId: inst.id, platform: "linkedin" }),
  ]);
  return {
    stylePool: pool,
    styleUltraProfiles: profiles,
    postStyleEnabled: true,
    styleConfig: inst.account_feeder_config,
  };
}

main().catch((err) => {
  console.error("post-drafter fatal:", err);
  process.exit(EX_TEMPFAIL);
});
