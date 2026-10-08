import { describe, expect, it, vi } from "vitest";

describe("Reddit drafter supervisor rule admission", () => {
  it.each(["empty", "held", "recovery"] as const)(
    "admits current rules before claims: %s",
    async (state) => {
      vi.resetModules();
      const held = new Error("Standing rules unavailable");
      const readRules = vi.fn(async () => []);
      if (state !== "empty") readRules.mockRejectedValueOnce(held);
      const claim = vi.fn(async () => []);
      const reap = vi.fn(async () => ({ requeued: 0, expired: 0 }));
      const draft = vi.fn(async () => 0);
      const finish = vi.fn();
      const runnerDraft = vi.fn();
      const send = vi.fn();
      const errors: unknown[] = [];
      let finished!: () => void;
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      vi.doMock("../env.js", () => ({
        loadEnv: () => ({
          WORKER_ID: "fixture",
          GCP_PROJECT: "fixture",
          DRAFTER_POLL_MS: 100,
          IDLE_POLL_MS: 100,
          CP_BASE_URL: "https://api.test",
          NOELLE_HMAC_SECRET: "fixture",
          NOELLE_KB_BACKEND: "local",
          NOELLE_VAULT_DIR: "/fixture",
          REDDIT_PATTERN_BREAKER: false,
          REDDIT_GOAL_STALL_MIN: 120,
        }),
      }));
      vi.doMock("../lib/logger.js", () => ({ createLogger: () => log }));
      vi.doMock("../lib/db.js", () => ({ noelleDb: () => vi.fn() }));
      vi.doMock("../lib/activation.js", () => ({
        listActiveRedditInternInstances: vi.fn(),
        isWorkerEnabled: () => true,
      }));
      vi.doMock("../lib/goal.js", () => ({
        effectiveDraftsCap: () => null,
        enforceGoal: vi.fn(async () => null),
      }));
      vi.doMock("../lib/worker-runs.js", () => ({ recordRun: vi.fn(async () => ({ finish })) }));
      vi.doMock("../lib/bus.js", () => ({ busForInstance: () => ({}) }));
      vi.doMock("../lib/boot.js", () => ({
        EX_TEMPFAIL: 75,
        runBootChecks: async () => ({ ok: true }),
      }));
      vi.doMock("../lib/secrets.js", () => ({
        SecretAccessError: class extends Error {},
        createSecretsClient: () => ({ getForOrg: async () => "" }),
      }));
      vi.doMock("../lib/leads-db.js", () => ({
        claimLeadsForDrafting: claim,
        reapStaleClaims: reap,
      }));
      vi.doMock("../lib/codex-runner.js", () => ({
        createCodexRunner: () => ({ draft: runnerDraft }),
      }));
      vi.doMock("@noelle/runtime/outbound-client", () => ({
        createOutboundClient: () => ({ postOutbound: send }),
      }));
      vi.doMock("./drafter-tick.js", () => ({ runDrafterTick: draft }));
      vi.doMock("../lib/pattern-breaker-db.js", () => ({ loadActivePatternRules: readRules }));
      vi.doMock("@noelle/runtime/ready-cache", () => ({
        createReadyCache: () => ({ ensure: vi.fn(), reset: vi.fn() }),
      }));
      vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({ createPgSpendRecorder: () => ({}) }));
      vi.doMock("@noelle/runtime/pg-budget-adapters", () => ({
        createPgBudgetAdapters: () => ({}),
        CAP_EXEMPT_ENGINES_APIFY: [],
      }));
      vi.doMock("@noelle/runtime/prior-replies", () => ({ getVoiceExemplars: async () => [] }));
      vi.doMock("@noelle/runtime", () => ({
        buildEngineRegistry: async () => ({ fixture: {} }),
        parseIncludeDirs: () => [],
        createLocalFsKnowledgeBase: () => ({}),
      }));
      vi.doMock("./_runtime.js", () => ({
        installShutdown: () => () => false,
        runWorkerLoop: async ({ onTick }: { onTick: (instance: unknown) => Promise<void> }) => {
          for (let tick = 0; tick < (state === "recovery" ? 2 : 1); tick++) {
            try {
              await onTick({ id: "instance", org_id: "org", status: "active" });
            } catch (error) {
              errors.push(error);
            }
          }
          finished();
        },
      }));
      await import("./drafter.js");
      await done;
      expect(errors).toEqual(state === "empty" ? [] : [held]);
      expect(readRules).toHaveBeenCalledWith(expect.any(Function), {
        orgId: "org",
        agentInstanceId: "instance",
        role: "reddit_intern",
      });
      if (state !== "empty")
        expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
      if (state === "held") {
        for (const effect of [reap, claim, draft, runnerDraft, send])
          expect(effect).not.toHaveBeenCalled();
      } else {
        expect(claim).toHaveBeenCalledOnce();
        expect(draft).toHaveBeenCalledWith(expect.objectContaining({ patternRules: [] }));
        expect(readRules.mock.invocationCallOrder.at(-1)).toBeLessThan(
          claim.mock.invocationCallOrder[0]!,
        );
        expect(finish).toHaveBeenCalledWith({ status: "ok", rowsProcessed: 0 });
      }
    },
  );
});
