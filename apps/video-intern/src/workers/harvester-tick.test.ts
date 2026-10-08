import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, PgOperationError } from "@noelle/runtime";
import type { HarvestRunSummary } from "@noelle/contracts";
import type { ApifyRunReceipt } from "@noelle/runtime/apify-run-receipts";
import type { HarvesterTickDeps } from "./harvester-tick.js";
import { runHarvesterTick } from "./harvester-tick.js";

const db = vi.hoisted(() => ({ sources: vi.fn(), niches: vi.fn(), markSource: vi.fn(), markNiche: vi.fn(),
  upsert: vi.fn(), deep: vi.fn(), manualComplete: vi.fn() }));
vi.mock("../lib/watchlist-db.js", () => ({ listEnabledSources: db.sources, listEnabledNiches: db.niches,
  markSourcePulled: db.markSource, markNichePulled: db.markNiche }));
vi.mock("../lib/video-clips-db.js", () => ({ upsertVideoClips: db.upsert, flagDeepTier: db.deep }));
vi.mock("@noelle/runtime", async original => ({ ...await original<Record<string, unknown>>(),
  evaluateJevBoolean: async () => ({ kind: "unavailable", provider: "jev" }) }));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const instance = { id: "instance", org_id: "org", status: "active" as const, objective: "Building lessons",
  video_feeder_config: {}, budget_cap_cents: 0 };
const denied = () => new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 });
const clip = { id: "clip", platform: "instagram", authorHandle: "example", caption: "A building lesson", views: 1_000_000 };
function fixture(gradeJson = vi.fn().mockResolvedValue({ keep: ["clip"] })) {
  const summaries: HarvestRunSummary[] = []; const receipts: ApifyRunReceipt[] = [];
  const pull = vi.fn(async () => {
    receipts.push({ runId: String(pull.mock.calls.length), actor: "fixture", status: "SUCCEEDED", terminal: true,
      actualUsd: 0.37, resultCount: 1, credentialId: "actual-token" });
    return [clip];
  });
  const client = { nicheCreatorReels: pull, accountSnapshot: vi.fn(async () => null), creatorReels: pull,
    drainLastRunUsd: () => null, drainRunReceipts: () => receipts.splice(0) };
  const recorder = { record: vi.fn().mockResolvedValue(undefined) };
  const cancel = vi.fn(async () => false);
  const deps: HarvesterTickDeps = { sql: {} as never, log: log as never, instance, gradeJson, recorder,
    resolveApify: vi.fn(async () => ({ credentialId: "stale-token", client: client as never })),
    run: { isCancelRequested: cancel, updateSummary: async summary => { summaries.push(structuredClone(summary)); } } };
  return { deps, pull, recorder, cancel, summaries };
}
beforeEach(() => {
  vi.clearAllMocks(); db.sources.mockResolvedValue([]);
  db.niches.mockResolvedValue(["first", "second", "third"].map(id => ({ id, platform: "instagram", query: id })));
  db.upsert.mockResolvedValue(1); db.deep.mockResolvedValue(undefined); db.manualComplete.mockResolvedValue(undefined);
});
describe("harvester paid batch admission", () => {
  it.each([denied, () => new PgOperationError("queue_full")])("stops later pulls after canonical grader refusal %#", async refusal => {
    const error = refusal(); const grade = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ keep: ["clip"] });
    const f = fixture(grade);
    await expect(runHarvesterTick(f.deps)).rejects.toMatchObject({ cause: error, rowsProcessed: 0 });
    expect(grade).toHaveBeenCalledOnce(); expect(f.pull).toHaveBeenCalledOnce(); expect(db.upsert).not.toHaveBeenCalled();
    expect(db.deep).not.toHaveBeenCalled(); expect(f.summaries.at(-1)).toMatchObject({ phase: "error", error: error.message });
  });
  it("keeps ordinary grader fail-open and later pulls", async () => {
    const grade = vi.fn().mockRejectedValueOnce(new Error("ordinary failure")).mockResolvedValue({ keep: ["clip"] });
    const f = fixture(grade); expect(await runHarvesterTick(f.deps)).toBe(3);
    expect(grade).toHaveBeenCalledTimes(3); expect(f.pull).toHaveBeenCalledTimes(3); expect(db.deep).toHaveBeenCalledOnce();
    expect(f.summaries.at(-1)?.phase).toBe("done");
  });
  it("continues ordinary niche and creator pull failures", async () => {
    db.sources.mockResolvedValue([{ id: "creator", platform: "instagram", handle: "example" }]);
    const f = fixture(); f.pull.mockRejectedValueOnce(new Error("creator failure")).mockRejectedValueOnce(new Error("niche failure"));
    expect(await runHarvesterTick(f.deps)).toBe(2); expect(f.pull).toHaveBeenCalledTimes(4);
    expect(f.summaries.at(-1)?.phase).toBe("done");
  });
  it("awaits canonical receipt writes before surfacing denial and retains their attribution", async () => {
    const error = denied(); const f = fixture(vi.fn().mockRejectedValue(error)); let release!: () => void;
    f.recorder.record.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    let finished = false; const result = runHarvesterTick(f.deps).then(() => { finished = true; }, err => { finished = true; return err; });
    await vi.waitFor(() => expect(f.recorder.record).toHaveBeenCalledOnce()); expect(finished).toBe(false);
    release(); expect(await result).toMatchObject({ cause: error, rowsProcessed: 0 });
    expect(f.recorder.record).toHaveBeenCalledWith(expect.objectContaining({ cents: 37, credentialId: "actual-token", costBasis: "provider_reported" }));
    expect(f.pull).toHaveBeenCalledOnce();
  });
  it("retains earlier writes without dispatching a third paid lane", async () => {
    const error = denied(); const grade = vi.fn().mockResolvedValueOnce({ keep: ["clip"] }).mockRejectedValueOnce(error);
    const f = fixture(grade); await expect(runHarvesterTick(f.deps)).rejects.toMatchObject({ cause: error, rowsProcessed: 1 });
    expect(f.pull).toHaveBeenCalledTimes(2); expect(f.recorder.record).toHaveBeenCalledTimes(2);
    expect(db.upsert).toHaveBeenCalledOnce(); expect(f.summaries.at(-1)?.totals.kept).toBe(1);
  });
  it("respects Stop without another pull", async () => {
    const f = fixture(); f.cancel.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await runHarvesterTick(f.deps)).toBe(1); expect(f.pull).toHaveBeenCalledOnce();
    expect(f.summaries.at(-1)?.phase).toBe("cancelled");
  });
  it("reports no token without model or actor dispatch", async () => {
    const f = fixture(); vi.mocked(f.deps.resolveApify).mockResolvedValue(null);
    expect(await runHarvesterTick(f.deps)).toBe(0); expect(f.pull).not.toHaveBeenCalled();
    expect(f.deps.gradeJson).not.toHaveBeenCalled(); expect(f.summaries.at(-1)?.phase).toBe("error");
  });
  it("finishes actual worker error/count and completes its manual request once", async () => {
    const error = denied(); const f = fixture(vi.fn().mockResolvedValueOnce({ keep: ["clip"] }).mockRejectedValueOnce(error));
    const finish = vi.fn(async () => {});
    vi.doMock("../env.js", () => ({ loadEnv: () => ({ WORKER_ID: "fixture", NOELLE_NOVA_OBJECTIVE_GRADE: true }) }));
    vi.doMock("../lib/logger.js", () => ({ createLogger: () => log }));
    vi.doMock("../lib/db.js", () => ({ noelleDb: () => f.deps.sql }));
    vi.doMock("../lib/secrets.js", () => ({ createSecretsClient: () => ({}), APIFY_TOKEN_SECRET_ID: "fixture" }));
    vi.doMock("@noelle/runtime/pg-spend-recorder", () => ({ createPgSpendRecorder: () => f.recorder }));
    vi.doMock("../lib/apify-resolver.js", () => ({ createApifyResolver: () => f.deps.resolveApify }));
    vi.doMock("../lib/boot.js", () => ({ runBootChecks: async () => ({ ok: true }), EX_TEMPFAIL: 75 }));
    vi.doMock("../lib/worker-runs.js", () => ({ recordRun: async () => ({ ...f.deps.run, finish }) }));
    vi.doMock("../lib/text-backend.js", () => ({ createTextJsonFn: () => ({ forInstance: () => f.deps.gradeJson }) }));
    vi.doMock("../lib/activation.js", () => ({ listInstancesWithPendingHarvest: vi.fn(), markHarvestRunComplete: db.manualComplete }));
    vi.doMock("./_runtime.js", () => ({ installShutdown: () => () => true,
      runWorkerLoop: async (args: { onTick: (inst: typeof instance) => Promise<void> }) => args.onTick(instance) }));
    try {
      await import("./harvester.js");
      await vi.waitFor(() => expect(finish).toHaveBeenCalledWith({ status: "error", rowsProcessed: 1, errorMessage: error.message }));
      expect(finish).toHaveBeenCalledOnce(); expect(db.manualComplete).toHaveBeenCalledWith(f.deps.sql, instance.id);
      expect(db.manualComplete).toHaveBeenCalledOnce(); expect(f.pull).toHaveBeenCalledTimes(2);
    } finally {
      for (const path of ["../env.js", "../lib/logger.js", "../lib/db.js", "../lib/secrets.js", "@noelle/runtime/pg-spend-recorder",
        "../lib/apify-resolver.js", "../lib/boot.js", "../lib/worker-runs.js", "../lib/text-backend.js", "../lib/activation.js", "./_runtime.js"]) vi.doUnmock(path);
    }
  });
});
