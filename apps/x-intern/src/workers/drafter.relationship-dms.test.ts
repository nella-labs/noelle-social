import { describe, expect, it, vi } from "vitest";

describe("X drafter relationship-DM lane", () => {
  async function checkRuleAdmission(state: "empty" | "held" | "recovery") {
    vi.resetModules();

    const finish = vi.fn();
    const held = new Error("standing rules unavailable");
    const loadActivePatternRules = vi.fn(async () => []);
    if (state !== "empty") loadActivePatternRules.mockRejectedValueOnce(held);
    const tickErrors: unknown[] = [];
    const runRelationshipDmsForInstance = vi.fn(async () => 4);
    const claimDmRequestLeads = vi.fn(async () => [{ id: "dm-lead" }]);
    const claimReplyRequestLeads = vi.fn(async () => [{ id: "reply-lead" }]);
    const runDmRequestTick = vi.fn(async () => 2);
    const runDrafterTick = vi.fn(async () => 1);
    const enforceGoal = vi.fn(async () => null);
    const countPendingApprovalsForInstance = vi.fn(async () => 0);
    const claimLeadsForDrafting = vi.fn(async () => []);
    const claimWatchlistLeadsForDrafting = vi.fn(async () => []);
    const expireStaleClassifiedLeads = vi.fn(async () => 0);
    const expireStaleApprovals = vi.fn(async () => ({ pending: 0, limbo: 0 }));
    const createNellaClient = vi.fn(() => ({}));
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
        X_REPLY_MAX_AGE_HOURS: 0,
        NOELLE_DRAFTER_COMMENT_ENERGY: false,
        NOELLE_DRAFTER_VERIFY: false,
        NOELLE_DRAFTER_VOICE_FLOOR: 0.65,
        NOELLE_PATTERN_BREAKER: false,
      }),
    }));
    vi.doMock("../lib/logger.js", () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
    }));
    vi.doMock("../lib/db.js", () => ({ noelleDb: () => Object.assign(vi.fn(), {
      listen: vi.fn(async () => ({})),
    }) }));
    vi.doMock("../lib/activation.js", () => ({
      listWatchlistOrActiveXInternInstances: vi.fn(),
      isWorkerEnabled: (inst: Record<string, boolean | undefined>, kind: string) =>
        inst[`${kind}_enabled`] !== false,
    }));
    vi.doMock("../lib/goal.js", () => ({
      effectiveDraftsCap: vi.fn(() => null),
      enforceGoal,
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
    vi.doMock("../lib/apify-resolver.js", () => ({ createApifyResolver: vi.fn() }));
    vi.doMock("@noelle/x-apify", () => ({ X_SCRAPER_ACTOR: "x-scraper" }));
    vi.doMock("../lib/leads-db.js", () => ({
      WATCHLIST_PENDING_CAP: 5,
      claimLeadsForDrafting,
      claimWatchlistLeadsForDrafting,
      claimDmRequestLeads,
      claimReplyRequestLeads,
      expireStaleClassifiedLeads,
      supersedeOlderPriorityLeads: vi.fn(),
      countPendingApprovalsForInstance,
      markLeadStatus: vi.fn(),
      reapStaleClaims: vi.fn(async () => ({ requeued: 0, expired: 0 })),
    }));
    vi.doMock("../lib/send-db.js", () => ({ expireStaleApprovals }));
    vi.doMock("../lib/codex-runner.js", () => ({ createCodexRunner: () => ({ draft: vi.fn() }) }));
    vi.doMock("@noelle/runtime/outbound-client", () => ({
      createOutboundClient: () => ({ postOutbound: vi.fn(async () => null) }),
    }));
    vi.doMock("../lib/routing.js", () => ({
      judgeRouting: vi.fn(() => ({ primary: { engine: "bedrock", model: "judge" } })),
      xInternRouting: vi.fn(() => ({ primary: { engine: "bedrock", model: "drafter" } })),
    }));
    vi.doMock("../lib/examples-db.js", () => ({ getRecentSentExamples: vi.fn(async () => []) }));
    vi.doMock("@noelle/runtime/prior-replies", () => ({
      getRecentRepliesToAuthor: vi.fn(async () => []),
      getRecentReplyPhrasings: vi.fn(async () => []),
      getVoiceExemplars: vi.fn(async () => []),
    }));
    vi.doMock("../lib/autosend-quality.js", () => ({
      resolveAutosendQuality: vi.fn(() => ({ variety: false, diversityGate: false })),
    }));
    vi.doMock("../lib/relationship-dms.js", () => ({
      isRelationshipDmsLaneEnabled: vi.fn(() => false),
      runRelationshipDmsForInstance,
    }));
    vi.doMock("./_runtime.js", () => ({
      installShutdown: vi.fn(() => () => false),
      runWorkerLoop: vi.fn(async ({ onTick }) => {
        for (let tick = 0; tick < (state === "recovery" ? 2 : 1); tick++) {
          try {
            await onTick({
              id: "inst-x",
              org_id: "org-1",
              status: "paused",
              drafter_enabled: false,
              watchlist_enabled: false,
              dm_autodraft_enabled: false,
              lane_config: { dms: { relationship_dms_enabled: false } },
              goal_target: 15,
              goal_started_at: "2026-09-14T00:00:00.000Z",
            });
          } catch (error) {
            tickErrors.push(error);
          }
        }
        finishTick();
      }),
    }));
    vi.doMock("./drafter-tick.js", () => ({
      runDrafterTick,
      runDmRequestTick,
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
      applyRefinedRule: vi.fn(),
      persistPattern: vi.fn(),
    }));
    vi.doMock("@noelle/runtime", () => ({
      buildEngineRegistry: vi.fn(async () => ({ test: {} })),
      createNellaClient,
      createGcsNellaClientWithSdk: vi.fn(),
      createLocalFsKnowledgeBase: vi.fn(),
      knowledgeBaseFromNella: vi.fn(() => ({})),
      parseIncludeDirs: vi.fn(() => []),
      createGeminiCaptionFn: vi.fn(),
      createBedrockCaptionFn: vi.fn(),
      apifySpendRow: vi.fn(),
      readFaithfulVoices: vi.fn(() => []),
    }));
    vi.doMock("@noelle/runtime/notifier", () => ({
      createNotifier: vi.fn(() => ({ notify: vi.fn() })),
    }));
    vi.doMock("@noelle/runtime/ready-cache", () => ({
      createReadyCache: vi.fn(() => ({ ensure: vi.fn(), reset: vi.fn() })),
    }));
    vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({
      createPgSpendRecorder: vi.fn(() => ({})),
    }));
    vi.doMock("@noelle/runtime/pg-budget-adapters", () => ({
      createPgBudgetAdapters: vi.fn(() => ({})),
      CAP_EXEMPT_ENGINES_APIFY_XAPI: [],
    }));

    await import("./drafter.js");
    await tickDone;

    expect(loadActivePatternRules).toHaveBeenCalledWith(expect.any(Function), {
      orgId: "org-1",
      agentInstanceId: "inst-x",
      role: "x_intern",
    });
    expect(tickErrors).toEqual(state === "empty" ? [] : [held]);
    if (state !== "empty")
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    if (state === "held") {
      for (const effect of [
        runRelationshipDmsForInstance,
        claimDmRequestLeads,
        claimReplyRequestLeads,
        runDmRequestTick,
        runDrafterTick,
        claimLeadsForDrafting,
        claimWatchlistLeadsForDrafting,
        expireStaleClassifiedLeads,
        expireStaleApprovals,
      ]) {
        expect(effect).not.toHaveBeenCalled();
      }
      return;
    }
    expect(loadActivePatternRules.mock.invocationCallOrder.at(-1)).toBeLessThan(
