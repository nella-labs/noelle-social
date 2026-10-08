import { describe, it, expect } from "vitest";
import { deriveVegaWorkerStatus, type VegaWorkerRow } from "./queries";

const NOW = new Date("2026-05-27T15:00:00Z").getTime();

function row(over: Partial<VegaWorkerRow> & { worker: VegaWorkerRow["worker"] }): VegaWorkerRow {
  return {
    last_started_at: null,
    last_finished_at: null,
    last_rows_processed: null,
    last_error: null,
    running_started_at: null,
    ...over,
  };
}

describe("deriveVegaWorkerStatus", () => {
  it("returns idle entries for every worker when there is no history", () => {
    const out = deriveVegaWorkerStatus([], NOW);
    expect(out.map((s) => s.kind)).toEqual([
      "discovery",
      "classifier",
      "drafter",
      "send",
      "profiler",
    ]);
    expect(out.every((s) => s.state === "idle")).toBe(true);
    expect(out.every((s) => s.idleForSeconds === null)).toBe(true);
  });

  it("flags a fresh in-flight row as running", () => {
    const out = deriveVegaWorkerStatus(
      [
        row({
          worker: "drafter",
          running_started_at: new Date(NOW - 30 * 1000).toISOString(),
        }),
      ],
      NOW,
    );
    const drafter = out.find((s) => s.kind === "drafter")!;
    expect(drafter.state).toBe("running");
    expect(drafter.runningSince).not.toBeNull();
  });

  it("flags an in-flight row older than 15 minutes as stalled", () => {
    const out = deriveVegaWorkerStatus(
      [
        row({
          worker: "discovery",
          running_started_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
        }),
      ],
      NOW,
    );
    const discovery = out.find((s) => s.kind === "discovery")!;
    expect(discovery.state).toBe("stalled");
    // Stalled rows never expose runningSince — the UI treats it as a stuck
    // ghost, not an active in-flight cycle.
    expect(discovery.runningSince).toBeNull();
  });

  it("flags a finished row with a non-null error as errored", () => {
    const out = deriveVegaWorkerStatus(
      [
        row({
          worker: "send",
          last_started_at: new Date(NOW - 5 * 60 * 1000).toISOString(),
          last_finished_at: new Date(NOW - 4 * 60 * 1000).toISOString(),
          last_error: "X API 429",
        }),
      ],
      NOW,
    );
    const send = out.find((s) => s.kind === "send")!;
    expect(send.state).toBe("errored");
    expect(send.lastError).toBe("X API 429");
    expect(send.idleForSeconds).toBeGreaterThanOrEqual(60);
  });

  it("treats a successful finished row with no in-flight as idle", () => {
    const out = deriveVegaWorkerStatus(
      [
        row({
          worker: "classifier",
          last_started_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
          last_finished_at: new Date(NOW - 9 * 60 * 1000).toISOString(),
          last_rows_processed: 12,
        }),
      ],
      NOW,
    );
    const classifier = out.find((s) => s.kind === "classifier")!;
    expect(classifier.state).toBe("idle");
    expect(classifier.lastRowsProcessed).toBe(12);
  });

  it("prefers running over errored when both are present", () => {
    // The latest finished cycle errored, but a brand-new run kicked off.
    // The user cares more about "drafter is working right now" than the
    // earlier failure.
    const out = deriveVegaWorkerStatus(
      [
        row({
          worker: "drafter",
          last_started_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
          last_finished_at: new Date(NOW - 9 * 60 * 1000).toISOString(),
          last_error: "codex oauth expired",
          running_started_at: new Date(NOW - 20 * 1000).toISOString(),
        }),
      ],
      NOW,
    );
    const drafter = out.find((s) => s.kind === "drafter")!;
    expect(drafter.state).toBe("running");
  });

  it("marks a worker 'disabled' when its enable flag is false (not idle/errored)", () => {
    const out = deriveVegaWorkerStatus(
      [
        // drafter last ran 14h ago and last errored — but it's turned OFF, so
        // it must read 'disabled', not 'errored'/'idle'.
        row({
          worker: "drafter",
          last_finished_at: new Date(NOW - 14 * 60 * 60 * 1000).toISOString(),
          last_error: "codex oauth expired",
        }),
      ],
      NOW,
      { drafter: false, discovery: true },
    );
    expect(out.find((s) => s.kind === "drafter")!.state).toBe("disabled");
    // an enabled worker with no history stays idle (flag true ≠ disabled)
    expect(out.find((s) => s.kind === "discovery")!.state).toBe("idle");
  });

  it("a live in-flight run still shows running even if the flag is false", () => {
    const out = deriveVegaWorkerStatus(
      [row({ worker: "send", running_started_at: new Date(NOW - 5 * 1000).toISOString() })],
      NOW,
      { send: false },
    );
    expect(out.find((s) => s.kind === "send")!.state).toBe("running");
  });
});
