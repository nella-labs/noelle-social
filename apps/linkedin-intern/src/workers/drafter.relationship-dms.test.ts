import { describe, expect, it, vi } from "vitest";

describe("LinkedIn drafter relationship-DM lane", () => {
  async function checkRuleAdmission(state: "off" | "unavailable" | "ready" | "held" | "recovery") {
    const commentState = state === "held" || state === "recovery" ? "off" : state;
    vi.resetModules();

    const finish = vi.fn();
    const held = new Error("standing rules unavailable");
    const loadActivePatternRules = vi.fn(async () => []);
    if (state === "held" || state === "recovery")
      loadActivePatternRules.mockRejectedValueOnce(held);
    const runRelationshipDmsForInstance = vi.fn(async () => 3);
    const claimDmRequestLeads = vi.fn(async () => [{ id: "dm-lead" }]);
    const claimReplyRequestLeads = vi.fn(async () => [{ id: "reply-lead" }]);
    const runDmRequestTick = vi.fn(async () => 2);
    const runDrafterTick = vi.fn(async () => 1);
    const runnerDraft = vi.fn().mockResolvedValue({ text: "judge verdict" });
    const enforceGoal = vi.fn(async () => null);
    const countPendingApprovalsForInstance = vi.fn(async () => 0);
    const claimLeadsForDrafting = vi.fn(async () => []);
    const claimWatchlistLeadsForDrafting = vi.fn(async () => []);
    const warn = vi.fn();
    const resolveApify = vi.fn(async () => {
      if (commentState === "unavailable") throw new Error("fixture credential read unavailable");
      return { client: { postComments: vi.fn() }, credentialId: "fixture-credential" };
    });
    const tickErrors: unknown[] = [];
    let finishTick!: () => void;
    const tickDone = new Promise<void>((resolve) => {
      finishTick = resolve;
    });

    vi.doMock("../env.js", () => ({
      loadEnv: () => ({
        WORKER_ID: "test-worker",
        GCP_PROJECT: "test-project",
        DRAFTER_POLL_MS: 100,
        IDLE_POLL_MS: 100,
        CP_BASE_URL: "https://api.test",
        NOELLE_HMAC_SECRET: "secret",
        LINKEDIN_DRAFTER_COMMENT_MAX: commentState === "off" ? 0 : 3,
        LINKEDIN_GOAL_STALL_MIN: 120,
        NOELLE_DRAFTER_VERIFY: false,
        LINKEDIN_UNATTENDED_AUTOSEND: false,
        LINKEDIN_INTRO_DM_ENABLED: false,
        LINKEDIN_INTRO_DM_DAILY_CAP: 5,
        LINKEDIN_PATTERN_BREAKER: false,
      }),
    }));
    vi.doMock("../lib/logger.js", () => ({
      createLogger: () => ({ info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() }),
    }));
    vi.doMock("../lib/db.js", () => ({
      noelleDb: () => Object.assign(vi.fn(), { listen: vi.fn(async () => ({ unlisten: vi.fn() })) }),
    }));
    vi.doMock("../lib/activation.js", () => ({
      listActiveOrPausedLinkedinInternInstances: vi.fn(),
      isWorkerEnabled: (inst: Record<string, boolean | undefined>, kind: string) =>
        inst[`${kind}_enabled`] !== false,
    }));
    vi.doMock("../lib/goal.js", () => ({
      effectiveDraftsCap: vi.fn(() => null),
      enforceGoal,
      goalTarget: vi.fn(() => null),
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
      APIFY_TOKEN_SECRET_ID: "apify-token",
      SecretAccessError: class SecretAccessError extends Error {},
      createSecretsClient: () => ({ getForOrg: vi.fn(async () => "nella-key") }),
    }));
    vi.doMock("../lib/apify-resolver.js", () => ({ createApifyResolver: () => resolveApify }));
    vi.doMock("../lib/leads-db.js", () => ({
      claimLeadsForDrafting,
      claimObservedLeadsForDrafting: vi.fn(async () => []),
      claimWatchlistLeadsForDrafting,
      claimNotificationLeadsForDrafting: vi.fn(async () => []),
      claimDmRequestLeads,
      claimReplyRequestLeads,
      countDraftedTodayByKind: vi.fn(),
      countPendingApprovalsForInstance,
      createStartupDraftingRecovery: vi.fn(() => vi.fn(async () => ({ requeued: 0, reconciled: 0, approvalsRepaired: 0 }))),
      markLeadStatus: vi.fn(),
      reapStaleClaims: vi.fn(async () => ({ requeued: 0, expired: 0 })),
    }));
    vi.doMock("../lib/codex-runner.js", () => ({ createCodexRunner: () => ({ draft: runnerDraft }) }));
    vi.doMock("@noelle/runtime/outbound-client", () => ({
      createOutboundClient: () => ({ postOutbound: vi.fn(async () => null) }),
    }));
    vi.doMock("../lib/watchlist-db.js", () => ({ claimIntroDmPeople: vi.fn(async () => []) }));
    vi.doMock("../lib/prior-replies-db.js", () => ({
      getRecentRepliesToAuthor: vi.fn(async () => []),
      getRecentReplyPhrasings: vi.fn(async () => []),
    }));
    vi.doMock("../lib/account-feeder-db.js", () => ({
      listStyleExemplars: vi.fn(async () => []),
      listUltraProfiles: vi.fn(async () => []),
      listStyleExemplarsForHandle: vi.fn(async () => []),
      getUltraProfileForHandle: vi.fn(async () => null),
    }));
    vi.doMock("@noelle/contracts", () => ({
      AccountFeederConfigSchema: {
        safeParse: vi.fn(() => ({
          success: true,
          data: { minPerformancePercentile: 0, batchLightLeads: true },
        })),
        parse: vi.fn(() => ({ minPerformancePercentile: 0, batchLightLeads: true })),
      },
    }));
    vi.doMock("./_runtime.js", () => ({
      installShutdown: vi.fn(() => () => false),
      runWorkerLoop: vi.fn(async ({ onTick }) => {
        for (let tick = 0; tick < (state === "recovery" ? 2 : 1); tick++) {
          try {
            await onTick({
              id: "inst-li",
              org_id: "org-1",
              status: "paused",
              drafter_enabled: false,
              notifications_enabled: false,
              watchlist_enabled: false,
              lane_config: { dms: { relationship_dms_enabled: false } },
              goal_target: 40,
              goal_started_at: "2026-09-14T00:00:00.000Z",
            });
          } catch (err) {
            tickErrors.push(err);
          }
        }
        finishTick();
      }),
    }));
    vi.doMock("./drafter-tick.js", () => ({
      runDrafterTick,
      runDmRequestTick,
      runIntroDmTick: vi.fn(async () => 0),
    }));
    vi.doMock("./pattern-breaker-tick.js", () => ({
      runPatternBreakerTick: vi.fn(),
      runPatternRefineTick: vi.fn(),
    }));
    vi.doMock("../lib/pattern-breaker-db.js", () => ({
      loadActivePatternRules,
      loadRecentPosts: vi.fn(),
      loadActiveRuleLabels: vi.fn(),
      loadRefiningAlerts: vi.fn(),
      persistPattern: vi.fn(),
      applyRefinedRule: vi.fn(),
    }));
    vi.doMock("../lib/routing.js", () => ({
      judgeRouting: vi.fn(() => ({ primary: { engine: "bedrock", model: "judge" } })),
      linkedinInternRouting: vi.fn(() => ({ primary: { engine: "bedrock", model: "drafter" } })),
    }));
    vi.doMock("../lib/relationship-dms.js", () => ({
      isRelationshipDmsLaneEnabled: vi.fn(() => false),
      runRelationshipDmsForInstance,
    }));
    vi.doMock("@noelle/runtime/notifier", () => ({
      createNotifier: vi.fn(() => ({ notify: vi.fn() })),
    }));
    vi.doMock("@noelle/runtime/ready-cache", () => ({
      createReadyCache: vi.fn(() => ({
        ensure: vi.fn(async (_org, _kind, fn) => fn()),
        reset: vi.fn(),
      })),
    }));
    vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({
      createPgSpendRecorder: vi.fn(() => ({})),
    }));
    vi.doMock("@noelle/runtime/pg-budget-adapters", () => ({
      createPgBudgetAdapters: vi.fn(() => ({})),
      CAP_EXEMPT_ENGINES_APIFY: [],
    }));
    vi.doMock("@noelle/runtime", () => ({
      buildEngineRegistry: vi.fn(async () => ({ test: {} })),
      createNellaClient: vi.fn(() => ({})),
      createGcsNellaClientWithSdk: vi.fn(),
      createLocalFsKnowledgeBase: vi.fn(),
      knowledgeBaseFromNella: vi.fn(() => ({})),
      parseIncludeDirs: vi.fn(() => []),
      createGeminiCaptionFn: vi.fn(),
      createVertexCaptionFn: vi.fn(),
      createBedrockCaptionFn: vi.fn(),
      readFaithfulVoices: vi.fn(() => []),
      readFaithfulVoiceWeights: vi.fn(() => ({})),
      readStyleExemplarKinds: vi.fn(() => ["reply"]),
      pinnedSelectConfig: vi.fn((config) => config),
    }));
    const getVoiceExemplars = vi.fn(async () => []);
    vi.doMock("@noelle/runtime/prior-replies", () => ({ getVoiceExemplars }));

    await import("./drafter.js");
    await tickDone;

    expect(loadActivePatternRules).toHaveBeenCalledWith(expect.any(Function), {
      orgId: "org-1",
      agentInstanceId: "inst-li",
      role: "linkedin_intern",
    });
    expect(tickErrors).toEqual(state === "held" || state === "recovery" ? [held] : []);
    if (tickErrors.length)
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    if (state === "held") {
      for (const effect of [
        resolveApify,
        runRelationshipDmsForInstance,
        claimDmRequestLeads,
        claimReplyRequestLeads,
        runDmRequestTick,
        runDrafterTick,
        runnerDraft,
        claimWatchlistLeadsForDrafting,
        claimLeadsForDrafting,
      ])
        expect(effect).not.toHaveBeenCalled();
      return;
    }
    expect(loadActivePatternRules.mock.invocationCallOrder.at(-1)).toBeLessThan(
      claimDmRequestLeads.mock.invocationCallOrder[0]!,
    );
    expect(resolveApify).toHaveBeenCalledTimes(commentState === "off" ? 0 : 1);
    expect(runDrafterTick).toHaveBeenCalledWith(expect.objectContaining({
      fetchPostComments: commentState === "ready" ? expect.any(Function) : undefined,
    }));
    if (commentState === "unavailable") {
      expect(warn).toHaveBeenCalledWith(
        { org_id: "org-1" },
        "apify credential lookup failed; drafting without comment context",
      );
    }

    expect(getVoiceExemplars).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      agentInstanceId: "inst-li", humanOnly: true,
    }));

    expect(runRelationshipDmsForInstance).toHaveBeenCalledTimes(1);
    expect(runRelationshipDmsForInstance).toHaveBeenCalledWith(expect.objectContaining({
      instance: expect.objectContaining({ status: "paused", goal_target: 40 }),
    }));
    expect(claimDmRequestLeads).toHaveBeenCalledWith(expect.any(Function), {
      agentInstanceId: "inst-li",
      cap: 5,
    });
    expect(runDmRequestTick).toHaveBeenCalledTimes(1);
    expect(claimReplyRequestLeads).toHaveBeenCalledWith(expect.any(Function), {
      agentInstanceId: "inst-li",
      cap: 5,
    });
    expect(runDrafterTick).toHaveBeenCalledWith(expect.objectContaining({
      claimedLeads: [{ id: "reply-lead" }],
      patternRules: [],
      verify: expect.objectContaining({ enabled: true }),
    }));
    const tickArgs = (runDrafterTick.mock.calls as unknown as Array<[{
      verify: {
        makeCalls: (
          priority: boolean,
          options?: { directRouting?: boolean },
        ) => Array<(system: string, prompt: string) => Promise<string>>;
      };
    }]>)[0]![0];
    const verify = tickArgs.verify as {
      makeCalls: (
        priority: boolean,
        options?: { directRouting?: boolean },
      ) => Array<(system: string, prompt: string) => Promise<string>>;
    };
    await verify.makeCalls(false, { directRouting: true })[0]!("system", "prompt");
    await verify.makeCalls(false)[0]!("system", "prompt");
    expect(runnerDraft.mock.calls[0]![0]).toMatchObject({ directRouting: true });
    expect(runnerDraft.mock.calls[1]![0]).not.toHaveProperty("directRouting");
    expect(finish).toHaveBeenCalledWith({ status: "ok", rowsProcessed: 6 });
    expect(enforceGoal).not.toHaveBeenCalled();
    expect(countPendingApprovalsForInstance).not.toHaveBeenCalled();
    expect(claimWatchlistLeadsForDrafting).not.toHaveBeenCalled();
    expect(claimLeadsForDrafting).not.toHaveBeenCalled();
  }

  it.each(["off", "unavailable", "ready", "held", "recovery"] as const)(
    "admits standing rules before requested work: %s",
    checkRuleAdmission,
  );
});
