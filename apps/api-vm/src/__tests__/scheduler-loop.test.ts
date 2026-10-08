import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: vi.fn(), pollMs: 60_000 }));
vi.mock("../lib/db.js", () => ({ noelleDb: mocks.db }));
vi.mock("../env.js", () => ({ loadEnv: () => ({
  NOELLE_RUN_SCHEDULER: true, NOELLE_RUN_SCHEDULER_POLL_MS: mocks.pollMs,
}) }));
import { startSchedulerLoop, stopSchedulerLoop } from "../lib/scheduler.js";

describe("scheduler loop lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.db.mockReset();
    mocks.pollMs = 60_000;
    mocks.db.mockReturnValue(() => Promise.resolve([]));
  });
  afterEach(() => { stopSchedulerLoop(); vi.useRealTimers(); });

  it("cancels the initial tick when stopped before startup", async () => {
    startSchedulerLoop();
    stopSchedulerLoop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mocks.db).not.toHaveBeenCalled();
  });

  it("keeps one in-flight tick across initial and interval timers", async () => {
    mocks.pollMs = 1_000;
    let finish!: (rows: []) => void;
    const pending = new Promise<[]>((resolve) => { finish = resolve; });
    const sql = (first: unknown) => Array.isArray(first) && !("raw" in first) ? first : pending;
    mocks.db.mockReturnValue(sql);
    startSchedulerLoop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.db).toHaveBeenCalledTimes(1);
    stopSchedulerLoop();
    finish([]);
    await Promise.resolve();
  });
});
