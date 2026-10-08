import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { runTeardownTick } from "./teardown-tick.js";
import type { TeardownTickDeps } from "./teardown-tick.js";
import { BudgetExceededError, ModelNotDispatchedError } from "@noelle/runtime";
import type { TeardownAnalyzeInput } from "../lib/teardown-analyze.js";

const db = vi.hoisted(() => ({ claimClipsForTeardown: vi.fn(), completeTeardownClaim: vi.fn(),
  markTeardownDispatched: vi.fn(), markTeardownClaimOutcome: vi.fn(), listVideoGenerationHolds: vi.fn() }));
const fs = vi.hoisted(() => ({ mkdtemp: vi.fn(), rm: vi.fn() }));
const extract = vi.hoisted(() => vi.fn());
vi.mock("../lib/teardown-db.js", () => db);
vi.mock("node:fs/promises", () => fs);
vi.mock("@noelle/video-extract", () => ({ extractVideo: extract }));
const claim = (id: string) => ({ id, claim_id: `claim-${id}`, org_id: "org", agent_instance_id: "instance",
  platform: "instagram", external_id: id, author_handle: "example", caption: "Saved caption", url: "https://example.test/reel/saved",
  video_url: null, thumb_url: null, views: null, likes: 0, comments: null, shares: null, duration_s: null, deep_tier: false, source_snapshot: {} });
const output = { hook: { text: "Saved hook" } };
const analysis = (value: typeof output | null) => async (input: TeardownAnalyzeInput) => {
  if (await input.operation!.beforeDispatch(performance.now() + 1000) !== "dispatch") throw new ModelNotDispatchedError();
  return value;
};
function deps(): TeardownTickDeps {
  return { sql: {} as Sql, log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as TeardownTickDeps["log"],
    instance: { id: "instance", org_id: "org", status: "active", objective: null, video_feeder_config: null, budget_cap_cents: null },
    bulkAnalyzer: { analyze: vi.fn(analysis(output)) } as unknown as TeardownTickDeps["bulkAnalyzer"],
    deepAnalyzer: { analyze: vi.fn() }, batchLimit: 8, dailyCap: 200 };
}
beforeEach(() => {
  vi.clearAllMocks(); db.claimClipsForTeardown.mockResolvedValue([claim("one")]);
  db.completeTeardownClaim.mockResolvedValue(true); db.markTeardownDispatched.mockResolvedValue(true);
  db.markTeardownClaimOutcome.mockResolvedValue(true); db.listVideoGenerationHolds.mockResolvedValue({ holds: [] });
  fs.mkdtemp.mockResolvedValue("/fixture/work"); fs.rm.mockResolvedValue(undefined);
  extract.mockResolvedValue({ transcript: "", keyframePaths: [], cutTimestamps: [], durationS: 1 });
});
describe("Durable teardown tick outcomes", () => {
  it("acknowledges dispatch before analysis, preserves unknown source metrics and cleans work", async () => {
    const d = deps(); const order: string[] = [];
    db.markTeardownDispatched.mockImplementationOnce(async () => { order.push("marker"); return true; });
    vi.mocked(d.bulkAnalyzer.analyze).mockImplementationOnce(async input => {
      const value = await analysis(output)(input); order.push("generation"); return value as never;
    });
    expect(await runTeardownTick(d)).toBe(1); expect(order).toEqual(["marker", "generation"]);
    expect(d.bulkAnalyzer.analyze).toHaveBeenCalledWith(expect.objectContaining({ metrics: expect.objectContaining({ views: null, likes: 0 }) }));
    expect(fs.rm).toHaveBeenCalledOnce(); expect(db.claimClipsForTeardown).toHaveBeenCalledWith(d.sql,
      { instanceId: "instance", orgId: "org", limit: 8, dailyCap: 200 });
  });
  it("continues independent members and retains acknowledged count after an opaque response", async () => {
    db.claimClipsForTeardown.mockResolvedValue([claim("one"), claim("two"), claim("three")]);
    const d = deps(); vi.mocked(d.bulkAnalyzer.analyze).mockImplementationOnce(analysis(output) as never).mockImplementationOnce(analysis(null) as never).mockImplementationOnce(analysis(output) as never);
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 2 });
    expect(d.bulkAnalyzer.analyze).toHaveBeenCalledTimes(3); expect(db.completeTeardownClaim).toHaveBeenCalledTimes(2);
    expect(db.markTeardownClaimOutcome).toHaveBeenCalledWith(d.sql, claim("two"), "unknown", "generation_unknown");
    expect(fs.rm).toHaveBeenCalledTimes(3);
  });
  it("releases a proven extraction failure without dispatch or generation", async () => {
    const d = deps(); extract.mockRejectedValueOnce(new Error("download failed"));
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "extraction_failed", rowsProcessed: 0 });
    expect(db.markTeardownDispatched).not.toHaveBeenCalled(); expect(d.bulkAnalyzer.analyze).not.toHaveBeenCalled();
    expect(db.markTeardownClaimOutcome).toHaveBeenCalledWith(d.sql, claim("one"), "released", "extraction_failed");
  });
  it("holds an uncertain marker without completing the logical analysis", async () => {
    const d = deps(); db.markTeardownDispatched.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "dispatch_uncertain", rowsProcessed: 0 });
    expect(d.bulkAnalyzer.analyze).toHaveBeenCalledOnce(); expect(db.completeTeardownClaim).not.toHaveBeenCalled();
    expect(db.markTeardownClaimOutcome).toHaveBeenCalledWith(d.sql, claim("one"), "unknown", "dispatch_uncertain");
  });
  it("rejects a changed source marker before paid analysis", async () => {
    const d = deps(); db.markTeardownDispatched.mockResolvedValueOnce(false);
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "source_changed", rowsProcessed: 0 });
    expect(d.bulkAnalyzer.analyze).toHaveBeenCalledOnce(); expect(db.completeTeardownClaim).not.toHaveBeenCalled();
  });
  it("retains a marker-thrown nominal refusal instead of releasing the claim", async () => {
    const d = deps(); db.markTeardownDispatched.mockRejectedValueOnce(new ModelNotDispatchedError());
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "dispatch_uncertain" });
    expect(db.markTeardownClaimOutcome).toHaveBeenCalledWith(d.sql, claim("one"), "unknown", "dispatch_uncertain");
    expect(db.completeTeardownClaim).not.toHaveBeenCalled();
  });
  it("rejects output from an analyzer that bypasses canonical dispatch", async () => {
    const d = deps(); vi.mocked(d.bulkAnalyzer.analyze).mockResolvedValueOnce(output as never);
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "generation_unknown" });
    expect(db.markTeardownDispatched).not.toHaveBeenCalled(); expect(db.completeTeardownClaim).not.toHaveBeenCalled();
    expect(db.markTeardownClaimOutcome).toHaveBeenCalledWith(d.sql, claim("one"), "unknown", "generation_unknown");
  });
  it("preserves prior output and releases the unstarted tail after admission stops", async () => {
    const d = deps(); db.claimClipsForTeardown.mockResolvedValue([claim("one"), claim("two"), claim("three")]);
    vi.mocked(d.bulkAnalyzer.analyze).mockImplementationOnce(analysis(output) as never).mockRejectedValueOnce(
      new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 }));
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "preparation_failed", rowsProcessed: 1 });
    expect(d.bulkAnalyzer.analyze).toHaveBeenCalledTimes(2); expect(extract).toHaveBeenCalledTimes(2);
    expect(db.markTeardownDispatched).toHaveBeenCalledOnce(); expect(db.completeTeardownClaim).toHaveBeenCalledOnce();
    for (const id of ["two", "three"]) expect(db.markTeardownClaimOutcome)
      .toHaveBeenCalledWith(d.sql, claim(id), "released", "preparation_failed");
    expect(fs.rm).toHaveBeenCalledTimes(2);
  });
  it("retains completion uncertainty without replay and continues later members", async () => {
    db.claimClipsForTeardown.mockResolvedValue([claim("one"), claim("two")]);
    db.completeTeardownClaim.mockRejectedValueOnce(new Error("lost receipt")); const d = deps();
    await expect(runTeardownTick(d)).rejects.toMatchObject({ reason: "completion_failed", rowsProcessed: 1 });
    expect(d.bulkAnalyzer.analyze).toHaveBeenCalledTimes(2); expect(fs.rm).toHaveBeenCalledTimes(2);
  });
  it("reports existing unresolved holds instead of healthy zero work", async () => {
    db.claimClipsForTeardown.mockResolvedValue([]); db.listVideoGenerationHolds.mockResolvedValue({ holds: [{ reason: "generation_in_progress" }] });
    await expect(runTeardownTick(deps())).rejects.toMatchObject({ reason: "generation_in_progress", rowsProcessed: 0 });
    expect(extract).not.toHaveBeenCalled();
  });
  it("does not erase a prior acknowledged count after an outcome recorder rejection", async () => {
    db.claimClipsForTeardown.mockResolvedValue([claim("one"), claim("two")]); const d = deps();
    vi.mocked(d.bulkAnalyzer.analyze).mockImplementationOnce(analysis(output) as never).mockImplementationOnce(analysis(null) as never);
    db.markTeardownClaimOutcome.mockRejectedValueOnce(new Error("storage failure"));
    await expect(runTeardownTick(d)).rejects.toMatchObject({ rowsProcessed: 1 });
    expect(fs.rm).toHaveBeenCalledTimes(2); expect(d.log.warn).toHaveBeenCalled();
  });
  it("records the actual worker entry as error while retaining earlier acknowledged output", async () => {
    db.claimClipsForTeardown.mockResolvedValue([claim("one"), claim("two")]);
    const d = deps(); vi.mocked(d.bulkAnalyzer.analyze).mockImplementationOnce(analysis(output) as never).mockImplementationOnce(analysis(null) as never);
    const finish = vi.fn(async () => {});
    vi.doMock("../env.js", () => ({ loadEnv: () => ({ WORKER_ID: "fixture", TEARDOWN_BATCH: 8, TEARDOWN_DAILY_CAP: 200 }) }));
    vi.doMock("../lib/logger.js", () => ({ createLogger: () => d.log }));
    vi.doMock("../lib/db.js", () => ({ noelleDb: () => d.sql }));
    vi.doMock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }), EX_TEMPFAIL: 75 }));
    vi.doMock("../lib/worker-runs.js", () => ({ recordRun: async () => ({ finish }) }));
    vi.doMock("../lib/teardown-analyze.js", () => ({ createVertexVideoAnalyzer: () => d.bulkAnalyzer }));
    vi.doMock("./_runtime.js", () => ({ installShutdown: () => () => true,
      runWorkerLoop: async (args: { onTick: (instance: typeof d.instance) => Promise<void> }) => args.onTick(d.instance) }));
    try {
      await import("./teardown.js");
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith({ status: "error", rowsProcessed: 1,
        errorMessage: "Video teardown requires recovery: generation_unknown" }));
      expect(finish).toHaveBeenCalledOnce(); expect(fs.rm).toHaveBeenCalledTimes(2);
    } finally {
      for (const path of ["../env.js", "../lib/logger.js", "../lib/db.js", "../lib/boot.js", "../lib/worker-runs.js",
        "../lib/teardown-analyze.js", "./_runtime.js"]) vi.doUnmock(path);
    }
  });
});
