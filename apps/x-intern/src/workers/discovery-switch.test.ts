import { describe, expect, it, vi } from "vitest";

describe("Apify reply-lead discovery switch", () => {
  it("returns before the token pool or lead targets are read when disabled", async () => {
    vi.resetModules();
    const resolveShards = vi.fn(async () => []);
    const recordRun = vi.fn(async () => ({ finish: vi.fn() }));
    let tickDone!: () => void;
    const completed = new Promise<void>((resolve) => { tickDone = resolve; });

    vi.doMock("../env.js", () => ({ loadEnv: () => ({
      WORKER_ID: "test", GCP_PROJECT: "test", X_APIFY_REPLY_LEADS: false,
      X_APIFY_HEALTH_SWEEP_ENABLED: false,
    }) }));
    vi.doMock("../lib/logger.js", () => ({ createLogger: () => ({
      info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    }) }));
    vi.doMock("../lib/db.js", () => ({ noelleDb: () => vi.fn(async () => []) }));
    vi.doMock("../lib/secrets.js", () => ({
      APIFY_TOKEN_SECRET_ID: "apify-token", createSecretsClient: () => ({}),
    }));
    vi.doMock("../lib/boot.js", () => ({ EX_TEMPFAIL: 75, runBootChecks: vi.fn(async () => ({ ok: true })) }));
    vi.doMock("../lib/worker-runs.js", () => ({ recordRun }));
    vi.doMock("../lib/apify-shard-resolver.js", () => ({ createApifyShardResolver: () => resolveShards }));
    vi.doMock("@noelle/runtime/notifier", () => ({ createNotifier: () => ({}) }));
    vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({ createPgSpendRecorder: () => ({}) }));
    vi.doMock("./_runtime.js", () => ({
      installShutdown: () => () => false,
      runWorkerLoop: async ({ onTick }: { onTick: (inst: unknown) => Promise<void> }) => {
        await onTick({ id: "i", org_id: "o", status: "paused" });
        tickDone();
      },
    }));

    await import("./discovery.js");
    await completed;
    expect(resolveShards).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  }, 60_000);
});
