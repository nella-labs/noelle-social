import { describe, expect, it, vi } from "vitest";

describe("LinkedIn post-drafter explicit MCP requests", () => {
  it("claims only request-backed ideas when the recurring Posts lane is disabled", async () => {
    vi.resetModules();

    const finish = vi.fn();
    const knowledgeBase = {
      ready: async () => true,
      search: async (_query: string, _topK: number, opts?: { filterDirs?: string[] }) =>
        opts?.filterDirs?.includes("facts")
          ? [
              {
                snippet: "p95 fell from 210ms to 180ms",
                source: { filePath: "facts/release.md", startLine: 4, endLine: 5 },
                score: 1,
                highlights: [],
              },
            ]
          : [
              {
                snippet: "voice example only",
                source: { filePath: "voice/style.md", startLine: 1, endLine: 2 },
                score: 1,
                highlights: [],
              },
            ],
    };
    const claimApprovedIdeas = vi.fn(async () => [
      {
        id: "idea-requested",
        orgId: "org-1",
        agentInstanceId: "inst-li",
        platform: "linkedin",
        targetPlatforms: ["linkedin"],
        pendingPlatforms: ["linkedin"],
        generationRequestId: "11111111-1111-1111-1111-111111111111",
        generationReviewRequired: true,
        hook: "Requested post",
        thesis: null,
        angle: null,
        pillar: null,
        inspirationRefs: [],
      },
    ]);
    const runPostDrafterTick = vi.fn(async (_args: unknown) => 1);
    let tickDone!: Promise<void>;
    let finishTick!: () => void;
    tickDone = new Promise((resolve) => {
      finishTick = resolve;
    });

    vi.doMock("../env.js", () => ({
      loadEnv: () => ({
        WORKER_ID: "test-worker",
        GCP_PROJECT: "test-project",
        POST_DRAFTER_POLL_MS: 100,
        IDLE_POLL_MS: 100,
        POST_DRAFTER_BATCH: 5,
        CP_BASE_URL: "https://api.test",
        NOELLE_HMAC_SECRET: "secret",
        NOELLE_POST_VERIFY: false,
        NOELLE_POST_VERIFY_RETRIES: 0,
        NOELLE_POST_STYLE: false,
        NOELLE_POST_STYLE_POOL: 0,
        LINKEDIN_ANALYST_TOP_AUTHORS: 3,
        NOELLE_IDEATION_VOICE_TOPK: 2,
        NOELLE_KB_BACKEND: "local",
        NOELLE_VAULT_DIR: "/tmp/post-drafter-vault",
        NOELLE_VOICE_DIRS: "voice",
        NOELLE_KNOWLEDGE_DIRS: "facts",
        NOELLE_DRAFTER_KNOWLEDGE_TOPK: 4,
        NOELLE_POSTS_CTA_PRODUCT: "",
        NOELLE_POSTS_CTA_URL: "",
        NOELLE_POSTS_CTA_TAGLINE: "",
      }),
    }));
    vi.doMock("../lib/logger.js", () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
    }));
    vi.doMock("../lib/db.js", () => ({ noelleDb: () => vi.fn() }));
    vi.doMock("../lib/activation.js", () => ({
      listActiveOrPausedPostPipelineInstances: vi.fn(),
      isPostsLaneEnabled: vi.fn(() => false),
    }));
    vi.doMock("../lib/worker-runs.js", () => ({
      recordRun: vi.fn(async () => ({ finish })),
    }));
    vi.doMock("../lib/bus.js", () => ({ busForInstance: vi.fn(() => ({})) }));
    vi.doMock("../lib/boot.js", () => ({
      EX_TEMPFAIL: 75,
      runBootChecks: vi.fn(async () => ({ ok: true })),
    }));
    vi.doMock("../lib/secrets.js", () => ({
      createSecretsClient: () => ({ getForOrg: vi.fn(async () => "secret") }),
    }));
    vi.doMock("../lib/codex-runner.js", () => ({ createCodexRunner: () => ({ draft: vi.fn() }) }));
    vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({
      createPgSpendRecorder: vi.fn(() => ({})),
    }));
    vi.doMock("@noelle/runtime/pg-budget-adapters", () => ({
      createPgBudgetAdapters: vi.fn(() => ({})),
      CAP_EXEMPT_ENGINES_APIFY: [],
    }));
    vi.doMock("@noelle/runtime", () => ({
      buildEngineRegistry: vi.fn(async () => ({ test: {} })),
      createGcsNellaClientWithSdk: vi.fn(),
      createLocalFsKnowledgeBase: vi.fn(() => knowledgeBase),
      knowledgeBaseFromNella: vi.fn(),
      parseIncludeDirs: (dirs?: string) => (dirs ?? "").split(",").filter(Boolean),
      resolveWorkerRouting: vi.fn(() => null),
      readPinnedHandle: vi.fn(() => null),
      pinnedSelectConfig: vi.fn((config) => config),
    }));
    vi.doMock("../lib/routing.js", () => ({
      linkedinInternRouting: vi.fn(() => ({ primary: { engine: "test", model: "model" } })),
    }));
    vi.doMock("../lib/playbooks-db.js", () => ({ getTopPlaybooks: vi.fn(async () => []) }));
    vi.doMock("../lib/post-ideas-db.js", () => ({
      claimApprovedIdeas,
      getInspirationPostTexts: vi.fn(async () => []),
      getStandingRules: vi.fn(async () => []),
      getIdeaChatGuidance: vi.fn(async () => []),
      releaseIdeaToApproved: vi.fn(),
      clearPendingPlatforms: vi.fn(),
    }));
    vi.doMock("../lib/post-drafts-client.js", () => ({
      createPostDraftsClient: () => ({ postDraft: vi.fn(async () => ({ draft_id: "d1" })) }),
    }));
    vi.doMock("../lib/account-feeder-db.js", () => ({
      listStyleExemplars: vi.fn(async () => []),
      listUltraProfiles: vi.fn(async () => []),
      listStyleExemplarsForHandle: vi.fn(async () => []),
      getUltraProfileForHandle: vi.fn(async () => null),
    }));
    vi.doMock("@noelle/contracts", () => ({
      AccountFeederConfigSchema: {
        safeParse: vi.fn(() => ({ success: true, data: { minPerformancePercentile: 0 } })),
        parse: vi.fn(() => ({ minPerformancePercentile: 0 })),
      },
    }));
    vi.doMock("./_runtime.js", () => ({
      installShutdown: vi.fn(() => () => false),
      runWorkerLoop: vi.fn(async ({ onTick }) => {
        await onTick({
          id: "inst-li",
          org_id: "org-1",
          role: "linkedin_intern",
          status: "paused",
          lane_config: { posts: { enabled: false } },
          model_overrides: null,
          objective: null,
          account_feeder_config: null,
        });
        finishTick();
      }),
    }));
    vi.doMock("./post-drafter-tick.js", () => ({ runPostDrafterTick }));

    await import("./post-drafter.js");
    await tickDone;

    expect(claimApprovedIdeas).toHaveBeenCalledWith(expect.any(Function), {
      agentInstanceId: "inst-li",
      batch: 5,
      requestOnly: true,
    });
    expect(runPostDrafterTick).toHaveBeenCalledWith(
      expect.objectContaining({ ideas: [expect.objectContaining({ id: "idea-requested" })] }),
    );
    expect(finish).toHaveBeenCalledWith({ status: "ok", rowsProcessed: 1 });
    const tickArgs = runPostDrafterTick.mock.calls[0]![0] as unknown as {
      gather: (idea: unknown) => Promise<{ voiceAnchors: string[]; knowledgeAnchors?: string[] }>;
    };
    const context = await tickArgs.gather((await claimApprovedIdeas())[0]);
    expect(context.voiceAnchors).toEqual(["voice example only"]);
    expect(context.knowledgeAnchors).toEqual([
      "[facts/release.md:4-5] p95 fell from 210ms to 180ms",
    ]);
  });
});
