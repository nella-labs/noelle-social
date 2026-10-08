import { expect, it, vi } from "vitest";

it("drains browser-qualified X leads one per tick without waking an empty queue", async () => {
  vi.resetModules();
  const observed = { id: "browser-lead", author_handle: "builder", payload: { source: "extension_observed" }, priority: true };
  const nextObserved = { id: "next-browser-lead", author_handle: "another-builder", payload: { source: "extension_observed" }, priority: true };
  const legacySameAuthor = { id: "legacy-lead", author_handle: "Builder", payload: { source: "watchlist" }, priority: true };
  const remainingObserved = [observed, nextObserved];
  const claimObservedLeadsForDrafting = vi.fn(async (_sql: unknown, args: { cap: number }) =>
    remainingObserved.splice(0, args.cap));
  let watchlistClaims = 0;
  const claimWatchlistLeadsForDrafting = vi.fn(async () =>
    watchlistClaims++ === 0 ? [legacySameAuthor] : []);
  const markLeadStatus = vi.fn();
  const runDrafterTick = vi.fn(async () => 1);
  const runnerDraft = vi.fn().mockResolvedValue({ text: "judge verdict" });
  let tickDone!: () => void;
  const completed = new Promise<void>((resolve) => { tickDone = resolve; });
  let notifyDrafter!: () => void;
  const sql = Object.assign(vi.fn(async () => []), {
    listen: vi.fn(async (_channel: string, callback: () => void) => {
      notifyDrafter = callback;
      return {};
    }),
  });
  const immediatePolls: boolean[] = [];

  vi.doMock("../env.js", () => ({ loadEnv: () => ({
    WORKER_ID: "test", GCP_PROJECT: "test", CP_BASE_URL: "https://api.test",
    NOELLE_HMAC_SECRET: "secret", X_REPLY_MAX_AGE_HOURS: 0,
    NOELLE_DRAFTER_VERIFY: false, NOELLE_DRAFTER_VOICE_FLOOR: 0.65,
    NOELLE_DRAFTER_COMMENT_ENERGY: false, DRAFTER_POLL_MS: 100,
    IDLE_POLL_MS: 100,
  }) }));
  vi.doMock("../lib/logger.js", () => ({ createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  }) }));
  vi.doMock("../lib/db.js", () => ({ noelleDb: () => sql }));
  vi.doMock("../lib/activation.js", () => ({
    listWatchlistOrActiveXInternInstances: vi.fn(),
    isWorkerEnabled: (_inst: unknown, kind: string) => kind === "watchlist",
  }));
  vi.doMock("../lib/goal.js", () => ({ effectiveDraftsCap: vi.fn(), enforceGoal: vi.fn() }));
  vi.doMock("../lib/worker-runs.js", () => ({ recordRun: vi.fn(async () => ({ finish: vi.fn() })) }));
  vi.doMock("../lib/bus.js", () => ({ busForInstance: () => ({}) }));
  vi.doMock("../lib/boot.js", () => ({ EX_TEMPFAIL: 75, runBootChecks: vi.fn(async () => ({ ok: true })) }));
  vi.doMock("../lib/secrets.js", () => ({
    APIFY_TOKEN_SECRET_ID: "apify-token",
    SecretAccessError: class extends Error {},
    createSecretsClient: () => ({ getForOrg: vi.fn(async () => "key") }),
  }));
  vi.doMock("../lib/apify-resolver.js", () => ({ createApifyResolver: vi.fn() }));
  vi.doMock("@noelle/x-apify", () => ({ X_SCRAPER_ACTOR: "x-scraper" }));
  vi.doMock("../lib/leads-db.js", () => ({
    WATCHLIST_PENDING_CAP: 100,
    OBSERVED_REPLY_ACTIVE_CAP: 12,
    claimObservedLeadsForDrafting,
    claimWatchlistLeadsForDrafting,
    claimLeadsForDrafting: vi.fn(async () => []),
    claimReplyRequestLeads: vi.fn(async () => []),
    claimDmRequestLeads: vi.fn(async () => []),
    expireStaleClassifiedLeads: vi.fn(async () => 0),
    supersedeOlderPriorityLeads: vi.fn(),
    countPendingApprovalsForInstance: vi.fn(async () => 0),
    markLeadStatus,
    reapStaleClaims: vi.fn(async () => ({ requeued: 0, expired: 0 })),
  }));
  vi.doMock("../lib/send-db.js", () => ({ expireStaleApprovals: vi.fn(async () => ({ pending: 0, limbo: 0 })) }));
  vi.doMock("../lib/codex-runner.js", () => ({ createCodexRunner: () => ({ draft: runnerDraft }) }));
  vi.doMock("@noelle/runtime/outbound-client", () => ({
    createOutboundClient: () => ({ postOutbound: vi.fn() }),
  }));
  vi.doMock("../lib/routing.js", () => ({ judgeRouting: vi.fn(() => ({})), xInternRouting: vi.fn(() => ({})) }));
  vi.doMock("../lib/examples-db.js", () => ({ getRecentSentExamples: vi.fn(async () => []) }));
  vi.doMock("@noelle/runtime/prior-replies", () => ({
    getRecentRepliesToAuthor: vi.fn(async () => []),
    getRecentReplyPhrasings: vi.fn(async () => []),
    getVoiceExemplars: vi.fn(async () => []),
  }));
  vi.doMock("../lib/autosend-quality.js", () => ({
    resolveAutosendQuality: () => ({ variety: false, diversityGate: false }),
  }));
  vi.doMock("../lib/relationship-dms.js", () => ({
    isRelationshipDmsLaneEnabled: () => false,
    runRelationshipDmsForInstance: vi.fn(async () => 0),
  }));
  vi.doMock("./_runtime.js", () => ({
    installShutdown: () => () => false,
    runWorkerLoop: async ({ onTick, sleep }: {
      onTick: (inst: unknown) => Promise<void>;
      sleep: (ms: number) => Promise<void>;
    }) => {
      const instance = { id: "instance", org_id: "org", status: "paused" };
      for (let tick = 0; tick < 3; tick++) {
        await onTick(instance);
        let resumed = false;
        const poll = sleep(10_000).then(() => { resumed = true; });
        await Promise.resolve();
        immediatePolls.push(resumed);
        if (!resumed) notifyDrafter(); // Release the test's pending sleep.
        await poll;
      }
      tickDone();
    },
  }));
  vi.doMock("./drafter-tick.js", () => ({ runDrafterTick, runDmRequestTick: vi.fn() }));
  vi.doMock("./pattern-breaker-tick.js", () => ({ runPatternBreakerTick: vi.fn(), runPatternRefineTick: vi.fn() }));
  vi.doMock("../lib/pattern-breaker-db.js", () => ({
    loadActivePatternRules: vi.fn(async () => []),
    loadRecentPosts: vi.fn(), loadActiveRuleLabels: vi.fn(), loadRefiningAlerts: vi.fn(),
    applyRefinedRule: vi.fn(), persistPattern: vi.fn(),
  }));
  vi.doMock("@noelle/runtime", () => ({
    buildEngineRegistry: vi.fn(async () => ({ test: {} })),
    createNellaClient: vi.fn(() => ({})), createGcsNellaClientWithSdk: vi.fn(),
    createLocalFsKnowledgeBase: vi.fn(), knowledgeBaseFromNella: vi.fn(() => ({})),
    parseIncludeDirs: vi.fn(() => []), createGeminiCaptionFn: vi.fn(),
    createBedrockCaptionFn: vi.fn(), apifySpendRow: vi.fn(), readFaithfulVoices: vi.fn(() => []),
  }));
  vi.doMock("@noelle/runtime/notifier", () => ({ createNotifier: () => ({ notify: vi.fn() }) }));
  vi.doMock("@noelle/runtime/ready-cache", () => ({ createReadyCache: () => ({ ensure: vi.fn(), reset: vi.fn() }) }));
  vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({ createPgSpendRecorder: () => ({}) }));
  vi.doMock("@noelle/runtime/pg-budget-adapters", () => ({
    createPgBudgetAdapters: () => ({}), CAP_EXEMPT_ENGINES_APIFY_XAPI: [],
  }));

  await import("./drafter.js");
  await completed;
  expect(sql.listen).toHaveBeenCalledWith("noelle_x_priority", expect.any(Function));
  expect(claimObservedLeadsForDrafting).toHaveBeenCalledWith(sql, { agentInstanceId: "instance", cap: 1 });
  expect(runDrafterTick).toHaveBeenCalledWith(expect.objectContaining({
    claimedLeads: [observed], verify: expect.objectContaining({ enabled: true }),
  }));
  expect(runDrafterTick).toHaveBeenCalledWith(expect.objectContaining({ claimedLeads: [nextObserved] }));
  expect(immediatePolls).toEqual([true, true, false]);
  const tickArgs = (runDrafterTick.mock.calls as unknown as Array<[{
    verify: {
      makeCalls: (
        priority: boolean,
        options?: { directRouting?: boolean; codexSubscriptionOnly?: boolean },
      ) => Array<(system: string, prompt: string) => Promise<string>>;
    };
  }]>)[0]![0];
  const verify = tickArgs.verify as {
    makeCalls: (
      priority: boolean,
      options?: { directRouting?: boolean; codexSubscriptionOnly?: boolean },
    ) => Array<(system: string, prompt: string) => Promise<string>>;
  };
  expect(verify.makeCalls(true, { codexSubscriptionOnly: true })).toHaveLength(1);
  expect(verify.makeCalls(true)).toHaveLength(3);
  await verify.makeCalls(false, { directRouting: true })[0]!("system", "prompt");
  await verify.makeCalls(false)[0]!("system", "prompt");
  expect(runnerDraft.mock.calls[0]![0]).toMatchObject({ directRouting: true });
  expect(runnerDraft.mock.calls[1]![0]).not.toHaveProperty("directRouting");
  expect(claimWatchlistLeadsForDrafting).toHaveBeenCalled();
  expect(markLeadStatus).toHaveBeenCalledWith(sql, { leadId: "legacy-lead", status: "classified" });
  expect(runDrafterTick).toHaveBeenCalledTimes(2);
}, 30_000);
