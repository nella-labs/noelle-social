import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { RecordingBriefOutput } from "@noelle/contracts";
import { BudgetExceededError, ModelNotDispatchedError } from "@noelle/runtime";
import type { VideoBriefer } from "../lib/brief-generate.js";
import type { ClaimedDraftForBrief } from "../lib/recording-briefs-db.js";
import { runBrieferTick } from "./briefer-tick.js";

const grounding = vi.hoisted(() => vi.fn());
vi.mock("../lib/vault-grounding.js", () => ({ loadBrandContext: grounding }));
const db = vi.hoisted(() => ({ claim: vi.fn(), insert: vi.fn(), release: vi.fn(), outcome: vi.fn(), held: vi.fn(), dispatch: vi.fn() }));
vi.mock("../lib/recording-briefs-db.js", () => ({ claimReadyDraftsForBrief: db.claim,
  insertRecordingBrief: db.insert, revertBriefClaim: db.release, markBriefClaimOutcome: db.outcome, listHeldBriefClaims: db.held, markBriefDispatched: db.dispatch }));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const instance = { id: "instance", org_id: "org", status: "active" as const, objective: null, video_feeder_config: null, budget_cap_cents: null };
const draft: ClaimedDraftForBrief = { claim_id: "attempt", source_snapshot: {}, brief_id: "claim", draft_id: "draft", org_id: "org", agent_instance_id: "instance",
  idea_id: "idea", platform: "instagram", script: "Saved edited script", generated_script: "Saved generated script",
  final_script: "Saved edited script", draft_updated_at: "2026-06-01 00:00:00+00", idea_updated_at: "2026-06-01 00:00:00+00",
  structure: [{ tEnd: 30 }], hook: "Saved hook", concept: null };
const out: RecordingBriefOutput = { title: "Saved brief", runtimeTarget: 30, hookCheck: "Opening is clear",
  shotList: [], bRoll: [], camAngles: [], props: { inFrame: [], mustNotBeInFrame: [] }, onTheDayNotes: [] };
const tick = (brief: VideoBriefer["brief"] = vi.fn(async () => out), acknowledge = true) => runBrieferTick({
  sql: {} as Sql, log, instance, briefer: { brief: async input => {
    if (acknowledge && await input.operation!.beforeDispatch(performance.now() + 1000) !== "dispatch") throw new ModelNotDispatchedError();
    return brief(input);
  } }, batchLimit: 4, model: "saved-model", sourceEngine: "claude", kb: null });
beforeEach(() => {
  vi.clearAllMocks(); grounding.mockResolvedValue([]); db.claim.mockResolvedValue([draft]); db.insert.mockResolvedValue("claim");
  db.dispatch.mockResolvedValue(true); db.release.mockResolvedValue(true); db.outcome.mockResolvedValue(true); db.held.mockResolvedValue([]);
});
describe("runBrieferTick", () => {
  it("persists one owned claim with retained script and engine/model provenance", async () => {
    const brief = vi.fn(async () => out);
    expect(await tick(brief)).toBe(1);
    expect(brief).toHaveBeenCalledWith(expect.objectContaining({ script: draft.script, runtimeHintSec: 30 }));
    expect(db.insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ claim: draft, sourceEngine: "claude", model: "saved-model" }));
    expect(db.release).not.toHaveBeenCalled();
  });
  it("does no generation for a completed sequential tick", async () => {
    db.claim.mockResolvedValueOnce([draft]).mockResolvedValueOnce([]);
    const brief = vi.fn(async () => out);
    expect(await tick(brief)).toBe(1); expect(await tick(brief)).toBe(0); expect(brief).toHaveBeenCalledTimes(1);
  });
  it("retains and reports an opaque null outcome instead of a healthy zero", async () => {
    await expect(tick(vi.fn(async () => null))).rejects.toMatchObject({ rowsProcessed: 0, reason: "generation_unknown" });
    expect(db.outcome).toHaveBeenCalledWith(expect.anything(), draft, "generation_unknown");
    expect(db.release).not.toHaveBeenCalled();
  });
  it("retains a thrown generator outcome without broad deletion", async () => {
    await expect(tick(vi.fn(async () => { throw new Error("inert failure"); }))).rejects.toMatchObject({ reason: "generation_failed", rowsProcessed: 0 });
    expect(db.outcome).toHaveBeenCalledWith(expect.anything(), draft, "generation_failed");
    expect(db.release).not.toHaveBeenCalled();
  });
  it("reports a stored hold without another generator dispatch", async () => {
    db.claim.mockResolvedValue([]); db.held.mockResolvedValue([{ id: "claim", status: "unknown", reason: "generation_unknown" }]);
    const brief = vi.fn(async () => out);
    await expect(tick(brief)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 0 });
    expect(brief).not.toHaveBeenCalled();
  });
  it("counts only acknowledged writes and preserves prior success when a later member is unknown", async () => {
    db.claim.mockResolvedValue([draft, { ...draft, brief_id: "second", draft_id: "second-draft" }]);
    const brief = vi.fn(async (): Promise<RecordingBriefOutput | null> => out).mockResolvedValueOnce(out).mockResolvedValueOnce(null);
    await expect(tick(brief)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 1 });
    expect(db.insert).toHaveBeenCalledTimes(1); expect(db.release).not.toHaveBeenCalled();
  });
  it("a zero-row finalize reports source change rather than a successful brief", async () => {
    db.insert.mockResolvedValue(null);
    await expect(tick()).rejects.toMatchObject({ reason: "source_changed", rowsProcessed: 0 });
    expect(db.outcome).toHaveBeenCalledWith(expect.anything(), draft, "source_changed");
  });
  it("returns zero without generation when no ready or held work exists", async () => {
    db.claim.mockResolvedValue([]); const brief = vi.fn(async () => out);
    expect(await tick(brief)).toBe(0); expect(brief).not.toHaveBeenCalled();
  });
  it("keeps the acknowledged count when the final status read fails", async () => {
    db.held.mockRejectedValue(new Error("inert read failure"));
    await expect(tick()).rejects.toMatchObject({ reason: "completion_failed", rowsProcessed: 1 });
    expect(db.release).not.toHaveBeenCalled(); expect(db.outcome).not.toHaveBeenCalled();
  });
  it("continues with a later member after an earlier unknown outcome", async () => {
    db.claim.mockResolvedValue([draft, { ...draft, brief_id: "second", draft_id: "second-draft" }]);
    const brief = vi.fn(async (): Promise<RecordingBriefOutput | null> => out).mockResolvedValueOnce(null).mockResolvedValueOnce(out);
    await expect(tick(brief)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 1 });
    expect(brief).toHaveBeenCalledTimes(2); expect(db.insert).toHaveBeenCalledTimes(1);
  });
  it("keeps a saved receipt after its acknowledgement log throws", async () => {
    (log as { info: ReturnType<typeof vi.fn> }).info.mockImplementationOnce(() => { throw new Error("inert log failure"); });
    await expect(tick()).rejects.toMatchObject({ reason: "completion_failed", rowsProcessed: 1 });
    expect(db.release).not.toHaveBeenCalled(); expect(db.outcome).not.toHaveBeenCalled();
  });

  it("releases only the owned claim when preparation fails before dispatch", async () => {
    grounding.mockRejectedValueOnce(new Error("inert grounding failure"));
    const brief = vi.fn(async () => out);
    await expect(tick(brief)).rejects.toMatchObject({ reason: "preparation_failed", rowsProcessed: 0 });
    expect(brief).not.toHaveBeenCalled(); expect(db.release).toHaveBeenCalledWith(expect.anything(), draft);
    expect(db.outcome).not.toHaveBeenCalled();
  });

  it("rejects changed source at the dispatch marker before calling the generator", async () => {
    db.dispatch.mockResolvedValue(false); const brief = vi.fn(async () => out);
    await expect(tick(brief)).rejects.toMatchObject({ reason: "source_changed", rowsProcessed: 0 });
    expect(brief).not.toHaveBeenCalled(); expect(db.release).not.toHaveBeenCalled();
    expect(db.outcome).toHaveBeenCalledWith(expect.anything(), draft, "source_changed");
  });
  it("holds an unacknowledged dispatch marker without generation or release", async () => {
    db.dispatch.mockRejectedValue(new Error("inert lost acknowledgement")); const brief = vi.fn(async () => out);
    await expect(tick(brief)).rejects.toMatchObject({ reason: "dispatch_uncertain", rowsProcessed: 0 });
    expect(brief).not.toHaveBeenCalled(); expect(db.release).not.toHaveBeenCalled();
    expect(db.outcome).toHaveBeenCalledWith(expect.anything(), draft, "dispatch_uncertain");
  });
  it("does not release a callback-thrown nominal refusal", async () => {
    db.dispatch.mockRejectedValueOnce(new ModelNotDispatchedError()); const brief = vi.fn(async () => out);
    await expect(tick(brief)).rejects.toMatchObject({ reason: "dispatch_uncertain", rowsProcessed: 0 });
    expect(brief).not.toHaveBeenCalled(); expect(db.release).not.toHaveBeenCalled();
    expect(db.outcome).toHaveBeenCalledWith(expect.anything(), draft, "dispatch_uncertain");
  });
  it("does not finalize output from a generator that bypasses the operation", async () => {
    await expect(tick(vi.fn(async () => out), false)).rejects.toMatchObject({ reason: "generation_unknown" });
    expect(db.dispatch).not.toHaveBeenCalled(); expect(db.insert).not.toHaveBeenCalled(); expect(db.release).not.toHaveBeenCalled();
  });
  it("keeps earlier output and releases every unstarted claim after admission stops", async () => {
    const second = { ...draft, claim_id: "second", draft_id: "second-draft" };
    const third = { ...draft, claim_id: "third", draft_id: "third-draft" };
    db.claim.mockResolvedValue([draft, second, third]); let calls = 0;
    await expect(tick(async input => {
      if (++calls === 2) throw new BudgetExceededError({ layer: "instance", spent_cents: 0, cap_cents: 0, estimated_cents: 1 });
      await input.operation!.beforeDispatch(performance.now() + 1000); return out;
    }, false)).rejects.toMatchObject({ reason: "preparation_failed", rowsProcessed: 1 });
    expect(calls).toBe(2); expect(db.insert).toHaveBeenCalledOnce(); expect(db.dispatch).toHaveBeenCalledOnce();
    expect(db.release).toHaveBeenCalledWith(expect.anything(), second); expect(db.release).toHaveBeenCalledWith(expect.anything(), third);
    expect(db.outcome).not.toHaveBeenCalled();
  });
  it("admits known configured provenance and marks dispatch only after context preparation", async () => {
    const order: string[] = [];
    grounding.mockImplementation(async () => { order.push("context"); return []; });
    db.dispatch.mockImplementation(async () => { order.push("marker"); return true; });
    expect(await tick(vi.fn(async () => { order.push("generator"); return out; }))).toBe(1);
    expect(order).toEqual(["context", "marker", "generator"]);
    expect(db.claim).toHaveBeenCalledWith(expect.anything(), instance.id, 4, instance.org_id,
      { sourceEngine: "claude", model: "saved-model" });
  });

});
