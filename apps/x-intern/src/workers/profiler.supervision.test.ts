import { expect, it, vi } from "vitest";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";

const state = vi.hoisted(() => ({
  finish: vi.fn().mockResolvedValue(undefined),
  markAttempted: vi.fn().mockResolvedValue(undefined),
  userTweets: vi.fn(),
  tick: null as null | ((instance: unknown) => Promise<void>),
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../env.js", () => ({ loadEnv: () => ({}) }));
vi.mock("../lib/logger.js", () => ({ createLogger: () => state.log }));
vi.mock("../lib/db.js", () => ({ noelleDb: () => vi.fn() }));
vi.mock("../lib/activation.js", () => ({
  listProfilerXInternInstances: vi.fn(),
  isWorkerEnabled: () => true,
}));
vi.mock("../lib/worker-runs.js", () => ({ recordRun: async () => ({ finish: state.finish }) }));
vi.mock("../lib/bus.js", () => ({ busForInstance: () => ({}) }));
vi.mock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }), EX_TEMPFAIL: 75 }));
vi.mock("../lib/secrets.js", () => ({
  createSecretsClient: () => ({ get: async () => "fixture" }),
  SecretAccessError: class extends Error {},
  APIFY_TOKEN_SECRET_ID: "fixture",
}));
vi.mock("../lib/apify-resolver.js", () => ({
  createApifyResolver: () => async () => ({
    client: { userTweets: state.userTweets },
    credentialId: null,
  }),
}));
vi.mock("../lib/rate-bucket.js", () => ({ createRateBucket: () => ({ tryTake: () => true }) }));
vi.mock("../lib/codex-runner.js", () => ({ createCodexRunner: () => ({ draft: vi.fn() }) }));
vi.mock("@noelle/runtime/pg-spend-recorder", () => ({
  createPgSpendRecorder: () => ({ record: vi.fn() }),
}));
vi.mock("@noelle/runtime/pg-budget-adapters", () => ({
  createPgBudgetAdapters: vi.fn(),
  CAP_EXEMPT_ENGINES_APIFY_XAPI: [],
}));
vi.mock("@noelle/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@noelle/runtime")>()),
  createBedrockBackend: vi.fn(),
  createClaudeCliBackend: vi.fn(),
}));
vi.mock("../lib/profiles-db.js", () => ({
  listWatchlistPeopleNeedingProfile: async () => [{ handle: "first" }, { handle: "remaining" }],
  listRepliedPeopleNeedingProfile: async () => [],
  upsertWatchlistProfile: vi.fn(),
  markProfileAttempted: state.markAttempted,
}));
vi.mock("./_runtime.js", () => ({
  installShutdown: () => () => false,
  runWorkerLoop: async (args: { onTick: typeof state.tick }) => {
    state.tick = args.onTick;
  },
}));

it("records pool exhaustion as a supervisor error without backing off remaining people", async () => {
  const exhausted = new AllApifyTokensExhaustedError(2, "monthly cap");
  state.userTweets.mockRejectedValue(exhausted);
  await import("./profiler.js");
  await vi.waitFor(() => expect(state.tick).not.toBeNull());
  await state.tick!({ id: "instance", org_id: "org" });
  expect(state.finish).toHaveBeenCalledOnce();
  expect(state.finish).toHaveBeenCalledWith({ status: "error", errorMessage: exhausted.message });
  expect(state.userTweets).toHaveBeenCalledOnce();
  expect(state.markAttempted).not.toHaveBeenCalled();
});
