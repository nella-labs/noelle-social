import http from "node:http";
import https from "node:https";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { FeederInstance } from "../lib/account-feeder-db.js";

const f = vi.hoisted(() => ({
  ready: (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  })(),
  tick: undefined as ((instance: FeederInstance) => Promise<void>) | undefined,
  writes: [] as { query: string; values: unknown[] }[],
  sources: vi.fn().mockResolvedValue([]),
  paid: vi.fn(async () => {
    throw new Error("Paid dispatch forbidden");
  }),
  sql(strings: TemplateStringsArray, ...values: unknown[]) {
    const query = strings.join("?");
    f.writes.push({ query, values });
    return Promise.resolve(query.includes("returning id") ? [{ id: "run" }] : []);
  },
}));
vi.mock("../env.js", () => ({ loadEnv: () => ({ GCP_PROJECT: "inert" }) }));
vi.mock("../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../lib/db.js", () => ({ noelleDb: () => f.sql }));
vi.mock("../lib/bus.js", () => ({ busForInstance: () => ({ emit: async () => undefined }) }));
vi.mock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }), EX_TEMPFAIL: 75 }));
vi.mock("../lib/secrets.js", () => ({
  createSecretsClient: () => ({}),
  APIFY_TOKEN_SECRET_ID: "inert",
}));
vi.mock("../lib/apify-resolver.js", () => ({ createApifyResolver: () => f.paid }));
vi.mock("@noelle/runtime/pg-spend-recorder", () => ({ createPgSpendRecorder: () => ({}) }));
vi.mock("@noelle/runtime/pg-budget-adapters", () => ({
  createPgBudgetAdapters: () => ({}),
  CAP_EXEMPT_ENGINES_APIFY: [],
  CAP_EXEMPT_ENGINES_APIFY_XAPI: [],
}));
vi.mock("@noelle/runtime/gemini-backend-select", () => ({
  selectGeminiBackend: () => ({ call: f.paid }),
}));
vi.mock("../lib/account-feeder-db.js", async (original) => ({
  ...(await original<object>()),
  listEnabledFeederSources: f.sources,
}));
vi.mock("./_runtime.js", () => ({
  installShutdown: () => () => true,
  runWorkerLoop: async (args: { onTick: (instance: FeederInstance) => Promise<void> }) => {
    f.tick = args.onTick;
    f.ready.resolve();
  },
}));
const instance: FeederInstance = {
  id: "22222222-2222-4222-8222-222222222222",
  org_id: "11111111-1111-4111-8111-111111111111",
  status: "paused",
  objective: null,
};
beforeAll(async () => {
  const forbidden = () => {
    throw new Error("Network forbidden in feeder entry tests");
  };
  vi.stubGlobal("fetch", forbidden);
  for (const network of [http, https])
    for (const method of ["request", "get"] as const)
      vi.spyOn(network, method).mockImplementation(forbidden);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Unexpected worker exit");
  });
  await import("./account-feeder.js");
  await f.ready.promise;
});
beforeEach(() => {
  f.writes.length = 0;
  f.sources.mockReset().mockResolvedValue([]);
  f.paid.mockClear();
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("manual paused zero-source run records its instance and completes without paid dispatch", async () => {
  await f.tick!(instance);
  expect(
    f.writes.find((write) => write.query.includes("insert into noelle.worker_runs"))?.values,
  ).toEqual(["linkedin_feeder", instance.id]);
  expect(f.writes.find((write) => write.query.includes("finished_at = now()"))?.values).toEqual([
    0,
    null,
    "run",
  ]);
  expect(
    f.writes.find((write) => write.query.includes("account_feeder_last_run_at = now()"))?.values,
  ).toEqual([instance.id]);
  expect(f.paid).not.toHaveBeenCalled();
});
test("failed source read stays bound to the same instance in its error receipt", async () => {
  f.sources.mockRejectedValueOnce(new Error("Source read failed"));
  await expect(f.tick!(instance)).rejects.toThrow("Source read failed");
  expect(
    f.writes.find((write) => write.query.includes("insert into noelle.worker_runs"))?.values,
  ).toEqual(["linkedin_feeder", instance.id]);
  expect(f.writes.find((write) => write.query.includes("finished_at = now()"))?.values).toEqual([
    0,
    "Source read failed",
    "run",
  ]);
  expect(f.paid).not.toHaveBeenCalled();
});
