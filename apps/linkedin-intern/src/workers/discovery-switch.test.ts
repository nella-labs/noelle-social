import { describe, expect, it, vi } from "vitest";

describe("Apify reply-lead discovery switch", () => {
  it("stops the discovery worker before it reads lead targets when disabled", async () => {
    vi.resetModules();
    const getWatchlistPeople = vi.fn(async () => []);
    const recordRun = vi.fn(async () => ({ finish: vi.fn() }));
    let tickDone!: () => void;
    const completed = new Promise<void>((resolve) => { tickDone = resolve; });

    vi.doMock("../env.js", () => ({ loadEnv: () => ({
      WORKER_ID: "test", GCP_PROJECT: "test", LINKEDIN_APIFY_REPLY_LEADS: false,
      LINKEDIN_APIFY_HEALTH_SWEEP_ENABLED: false,
      LINKEDIN_ACTIVE_HOURS_START: 0, LINKEDIN_ACTIVE_HOURS_END: 0,
      LINKEDIN_TZ_OFFSET_MIN: 0, LINKEDIN_DAILY_EXTRACT_CAP: 0,
      LINKEDIN_WATCHLIST_DAILY_RESERVE: 0,
    }) }));
    vi.doMock("../lib/logger.js", () => ({ createLogger: () => ({
      info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
    }) }));
    vi.doMock("../lib/db.js", () => ({ noelleDb: () => vi.fn(async () => []) }));
    vi.doMock("../lib/secrets.js", () => ({
      APIFY_TOKEN_SECRET_ID: "apify-token",
      createSecretsClient: () => ({}),
    }));
    vi.doMock("../lib/activation.js", () => ({
      listActiveOrPausedLinkedinInternInstances: vi.fn(),
      isWorkerEnabled: (_inst: unknown, kind: string) => kind === "watchlist",
    }));
    vi.doMock("../lib/boot.js", () => ({ EX_TEMPFAIL: 75, runBootChecks: vi.fn(async () => ({ ok: true })) }));
    vi.doMock("../lib/worker-runs.js", () => ({ recordRun }));
    vi.doMock("../lib/bus.js", () => ({ busForInstance: () => ({}) }));
    vi.doMock("../lib/watchlist-db.js", () => ({ getWatchlistPeople, getLinkedinKeywords: vi.fn(async () => []) }));
    vi.doMock("../lib/apify-resolver.js", () => ({ createApifyPoolResolver: () => vi.fn(async () => []) }));
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
    expect(getWatchlistPeople).not.toHaveBeenCalled();
    expect(recordRun).not.toHaveBeenCalled();
  }, 60_000);
});
