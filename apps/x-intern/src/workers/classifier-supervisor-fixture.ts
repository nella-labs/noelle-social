import { expect, vi, type Mock } from "vitest";
import type { ActiveInstance } from "../lib/activation.js";
import type {
  ClassificationClaim,
  claimLeadsForClassification,
  releaseClassificationClaims,
} from "../lib/leads-db.js";
import type { EngineBackend } from "@noelle/runtime";
import { BudgetExceededError } from "@noelle/runtime";
type SupervisorState = {
  onTick: null | ((inst: ActiveInstance) => Promise<void>);
  atCap: boolean;
  cli: boolean;
  byo: boolean;
  reserveDenied: boolean;
  denyFirst: boolean;
  admissions: number;
  claim: Mock<typeof claimLeadsForClassification>;
  release: Mock<typeof releaseClassificationClaims>;
  provider: Mock<EngineBackend["call"]>;
  finish: Mock<(args: Record<string, unknown>) => Promise<void>>;
  writes: unknown[][];
};
const state = vi.hoisted(() => ({
  onTick: null as null | ((inst: ActiveInstance) => Promise<void>),
  atCap: true,
  cli: false,
  byo: false,
  reserveDenied: true,
  denyFirst: false,
  admissions: 0,
  claim: vi.fn<typeof claimLeadsForClassification>(),
  release: vi.fn<typeof releaseClassificationClaims>(),
  provider: vi.fn<EngineBackend["call"]>(),
  finish: vi.fn<(args: Record<string, unknown>) => Promise<void>>(),
  writes: [] as unknown[][],
}));
export function getState(): SupervisorState {
  return state;
}
vi.mock("../env.js", () => ({
  loadEnv: () => ({
    NOELLE_CLASSIFIER_BACKEND: state.cli ? "bedrock" : "vertex",
    NOELLE_CLASSIFIER_BEDROCK_MODEL: "claude-haiku-4-5",
    GCP_PROJECT: "inert",
  }),
}));
vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../lib/db.js", () => ({
  noelleDb: () =>
    Object.assign(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        state.writes.push(values);
        return [];
      },
      { json: (value: unknown) => value, listen: async () => undefined },
    ),
}));
vi.mock("../lib/bus.js", () => ({ busForInstance: () => ({ emit: vi.fn() }) }));
vi.mock("../lib/worker-runs.js", () => ({ recordRun: async () => ({ finish: state.finish }) }));
vi.mock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }), EX_TEMPFAIL: 75 }));
vi.mock("../lib/secrets.js", () => {
  class SecretAccessError extends Error {}
  return {
    SecretAccessError,
    createSecretsClient: () => ({
      getForOrg: async () => {
        if (state.byo) return "inert-byo-key";
        throw new SecretAccessError("NOT_FOUND");
      },
    }),
  };
});
vi.mock("./_runtime.js", () => ({
  installShutdown: () => () => false,
  runWorkerLoop: async (args: { onTick: (inst: ActiveInstance) => Promise<void> }) => {
    state.onTick = args.onTick;
  },
}));
vi.mock("../lib/leads-db.js", async (original) => ({
  ...(await original<object>()),
  reapStaleClaims: async () => ({ requeued: 0, expired: 0 }),
  claimObservedLeadsForClassification: async () => [],
  countPendingApprovalsForInstance: async () => 0,
  claimLeadsForClassification: state.claim,
  releaseClassificationClaims: state.release,
}));
vi.mock("@noelle/runtime", async (original) => ({
  ...(await original<object>()),
  buildEngineRegistry: async (args: { enable?: unknown }) =>
    state.cli && args.enable ? { "claude-cli": { call: state.provider } } : {},
  createGeminiKeyBackend: () => ({ call: state.provider }),
  evaluateJevChoice: async () => ({ kind: "unavailable", provider: "jev" }),
}));
vi.mock("@noelle/runtime/gemini-backend-select", () => ({
  selectGeminiBackend: () => ({ call: state.provider }),
}));
vi.mock("@noelle/runtime/notifier", () => ({ createNotifier: () => ({ notify: vi.fn() }) }));
vi.mock("@noelle/runtime/pg-spend-recorder", () => ({
  createPgSpendRecorder: () => ({ record: vi.fn() }),
}));
vi.mock("@noelle/runtime/pg-budget-adapters", () => ({
  CAP_EXEMPT_ENGINES_APIFY_XAPI: [],
  createPgBudgetAdapters: () => ({
    fetchCaps: async () => ({ bucket: 100, org: 100, instance: 100 }),
    fetchSpend: async () => ({ bucket: state.atCap ? 100 : 0, org: 0, instance: 0 }),
    reserveAttempt: async () => {
      if (!state.reserveDenied && !(state.denyFirst && state.admissions++ === 0))
        return { attemptId: "inert-admission" };
      throw new BudgetExceededError({
        layer: "bucket",
        spent_cents: 100,
        cap_cents: 100,
        estimated_cents: 1,
      });
    },
  }),
}));
export const inst = {
  id: "instance",
  org_id: "org",
  status: "active",
  classifier_enabled: true,
  watchlist_enabled: true,
} as ActiveInstance;
export function reset() {
  vi.resetModules();
  state.onTick = null;
  state.denyFirst = false;
  state.admissions = 0;
  state.writes = [];
  state.atCap = true;
  state.cli = false;
  state.byo = false;
  state.reserveDenied = true;
  state.claim.mockReset();
  state.provider.mockReset();
  state.finish.mockReset();
  state.release.mockReset().mockResolvedValue(1);
  state.claim.mockImplementation(async () => {
    return [{ ...sourceLead("lead"), priority: true, classification_claimed_at: "lease-1" }];
  });
}
export async function boot() {
  await import("./classifier.js");
  await vi.waitFor(() => expect(state.onTick).not.toBeNull());
}

export function sourceLead(id: string, payload: Record<string, unknown> = {}): ClassificationClaim {
  return {
    id,
    external_id: id,
    author_handle: "builder",
    author_id: "author",
    status: "classifying",
    tier: null,
    classifier_label: null,
    classifier_score: null,
    priority: false,
    classification_claimed_at: `lease-${id}`,
    payload: {
      text: `Question from ${id}: how should our database tool handle schema changes?`,
      author_followers: 5000,
      ...payload,
    },
  };
}
export function verdict(id: number, q = 90, reply_kind = "substantial") {
  return {
    id,
    on_brand: true,
    on_brand_reason: "Useful source post",
    kind: "question",
    velocity_score: 80,
    q,
    reply_kind,
    tier: "T1",
    ai_slop: false,
  };
}
export const usage = { input_tokens: 20, output_tokens: 20, cost_usd: 0 };
