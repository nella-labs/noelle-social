import { describe, expect, it, vi } from "vitest";
import { OutboundInSchema } from "@noelle/contracts";
import { runRelationshipDmTick, type RelationshipDmTickArgs } from "./relationshipDm.js";
import { RELATIONSHIP_DM_JUDGE } from "./relationshipDmPolicy.js";
import type { RelationshipDmCandidate } from "./relationshipDmTypes.js";

const person = (id = "maya"): RelationshipDmCandidate => ({
  reservationId: id, authorId: id, authorHandle: id, name: id, profileUrl: `https://x.com/${id}`,
  context: [{
    id: "p1",
    kind: "post",
    text: "The deployment checklist was longer than my entire code change.",
    url: `https://x.com/${id}/status/123`,
    occurredAt: new Date().toISOString(),
  }],
});
const body = "hiii, that deployment checklist being longer than the code change is too real";
const output = (message = body) => JSON.stringify({ body: message, evidenceIds: ["p1"], detail: "deployment checklist was longer" });
const result = (text: string) => ({ text, model: "test", engine: "test" });

function setup(people = [person()]) {
  const draft = vi.fn().mockImplementation(async (call) => result(
    call.system === RELATIONSHIP_DM_JUDGE ? '{"pass":true,"reason":"Specific saved detail, no pressure"}' : output(),
  ));
  const args: RelationshipDmTickArgs = {
    sql: {} as never, orgId: "00000000-0000-4000-8000-000000000001", instanceId: "00000000-0000-4000-8000-000000000002",
    platform: "x", runner: { draft }, routing: { primary: { engine: "codex-cli", model: "test" } } as never,
    postOutbound: vi.fn().mockResolvedValue({ id: "approval" }), log: { info: vi.fn(), error: vi.fn() },
  };
  const storage = { claim: vi.fn().mockResolvedValue(people), finish: vi.fn().mockResolvedValue(undefined) };
  return { args, storage, draft };
}

describe("stored-context friendly DM flow", () => {
  it.each(["linkedin", "x"] as const)("queues one validated, owned, review-only %s DM with its source", async (platform) => {
    const { args, storage, draft } = setup();
    args.platform = platform;
    expect(await runRelationshipDmTick(args, storage)).toBe(1);
    const outbound = vi.mocked(args.postOutbound).mock.calls[0]![0];
    expect(OutboundInSchema.safeParse(outbound).success).toBe(true);
    expect(outbound.owner).toEqual({ orgId: args.orgId, agentInstanceId: args.instanceId });
    expect(outbound.platform).toBe(platform);
    expect(outbound.drafts).toEqual([{ id: expect.any(String), kind: "dm", angle: null, body, charCount: [...body].length, dmVoiceCheck: { pass: true, attempts: 0, reasons: [] } }]);
    expect(outbound).not.toHaveProperty("autoSend");
    expect(outbound.drafts[0]).not.toHaveProperty("dm_send_approved");
    expect(outbound.originalPostText).toContain(person().context[0]!.text);
    expect(outbound.originalPostText).toContain("https://x.com/maya/status/123");
    expect(draft).toHaveBeenCalledTimes(2);
    expect(storage.finish).toHaveBeenCalledWith(args.sql, expect.objectContaining({ reservationId: "maya", status: "queued" }));
  });

  it("does not call a model when no candidates or only generated profiles exist", async () => {
    const empty = setup([]);
    empty.args.includeRecurring = false;
    expect(await runRelationshipDmTick(empty.args, empty.storage)).toBe(0);
    expect(empty.storage.claim).toHaveBeenCalledWith(
      empty.args.sql,
      expect.objectContaining({ includeRecurring: false }),
    );
    expect(empty.draft).not.toHaveBeenCalled();
    const thin = setup([{ ...person(), context: [{ id: "summary", kind: "profile", text: "Maya is a founder writing about deployments." }] }]);
    expect(await runRelationshipDmTick(thin.args, thin.storage)).toBe(0);
    expect(thin.draft).not.toHaveBeenCalled();
    expect(thin.storage.finish).toHaveBeenCalledWith(
      thin.args.sql,
      expect.not.objectContaining({ judgeVerdict: expect.anything() }),
    );
  });

  it.each([
    ["stale", new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()],
    ["undated", null],
  ])("does not draft from a %s saved post", async (_label, occurredAt) => {
    const stale = setup([{ ...person(), context: [{ ...person().context[0]!, occurredAt }] }]);

    expect(await runRelationshipDmTick(stale.args, stale.storage)).toBe(0);
    expect(stale.draft).not.toHaveBeenCalled();
    expect(stale.args.postOutbound).not.toHaveBeenCalled();
    expect(stale.storage.finish).toHaveBeenCalledWith(
      stale.args.sql,
      expect.objectContaining({ status: "skipped", reason: "No saved post from the last 7 days" }),
    );
  });

  it("skips without retrying when the writer finds no honest reason to message", async () => {
    const { args, storage, draft } = setup();
    draft.mockResolvedValue(result('{"skip":"Only a job title is known"}'));
    expect(await runRelationshipDmTick(args, storage)).toBe(0);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(args.postOutbound).not.toHaveBeenCalled();
  });

  it("does not queue a fluent invented relationship rejected by the evidence verifier", async () => {
    const { args, storage, draft } = setup();
    draft.mockImplementation(async (call) => result(call.system === RELATIONSHIP_DM_JUDGE
      ? '{"pass":false,"reason":"No record of meeting or laughing together"}'
      : output("remember when we laughed about that checklist at the meetup last summer")));
    expect(await runRelationshipDmTick(args, storage)).toBe(0);
    expect(draft).toHaveBeenCalledTimes(4);
    expect(args.postOutbound).not.toHaveBeenCalled();
    expect(draft.mock.calls[2]![0].prompt).toContain("No record of meeting");
    expect(storage.finish).toHaveBeenCalledWith(
      args.sql,
      expect.objectContaining({
        status: "skipped",
        judgeVerdict: { pass: false, reason: "No record of meeting or laughing together", judgeProvider: "legacy", judgeOk: true },
      }),
    );
  });

  it("uses a clear Jev decision for a friendly DM without calling the old judge", async () => {
    const { args, storage, draft } = setup();
    args.jevRun = async ({ questions }) => ({ answers: Object.fromEntries(
      Object.keys(questions).map((name) => [name, { type: "boolean", probability: 0.95 }]),
    ) });
    expect(await runRelationshipDmTick(args, storage)).toBe(1);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(storage.finish).toHaveBeenCalledWith(args.sql, expect.objectContaining({
      status: "queued", judgeVerdict: expect.objectContaining({ judgeProvider: "jev", judgeOk: true }),
    }));
  });

  it("falls back to the old friendly DM judge when Jev is uncertain", async () => {
    const { args, storage, draft } = setup();
    args.jevRun = async ({ questions }) => ({ answers: Object.fromEntries(
      Object.keys(questions).map((name) => [name, { type: "boolean", probability: 0.6 }]),
    ) });
    expect(await runRelationshipDmTick(args, storage)).toBe(1);
    expect(draft).toHaveBeenCalledTimes(2);
    expect(storage.finish).toHaveBeenCalledWith(args.sql, expect.objectContaining({
      status: "queued", judgeVerdict: expect.objectContaining({ judgeProvider: "legacy", judgeOk: true }),
    }));
  });

  it("rejects pitches before spending on semantic verification, with bounded retries", async () => {
    const { args, storage, draft } = setup();
    draft.mockResolvedValue(result(output("try my free trial at https://example.com")));
    expect(await runRelationshipDmTick(args, storage)).toBe(0);
    expect(draft).toHaveBeenCalledTimes(2);
    expect(args.postOutbound).not.toHaveBeenCalled();
  });

  it("requires a no-question majority before permitting an optional question", async () => {
    const { args, storage, draft } = setup(["a", "b", "c", "d", "e"].map(person));
    expect(await runRelationshipDmTick(args, storage)).toBe(5);
    const prompts = draft.mock.calls.filter(([call]) => call.system !== RELATIONSHIP_DM_JUDGE).map(([call]) => JSON.parse(call.prompt));
    expect(prompts.slice(0, 4).every((p) => p.mode.includes("NO question"))).toBe(true);
    expect(prompts[4].mode).toContain("question is optional");
  });

  it("does not substitute question-heavy drafts when earlier no-ask drafts fail", async () => {
    const { args, storage, draft } = setup(["a", "b", "c", "d", "e"].map(person));
    draft.mockResolvedValue(result('{"skip":"No good opening"}'));
    await runRelationshipDmTick(args, storage);
    expect(draft.mock.calls.every(([call]) => JSON.parse(call.prompt).mode.includes("NO question"))).toBe(true);
  });

  it("contains one model or outbound failure and continues with other people", async () => {
    const { args, storage, draft } = setup([person("fail"), person("ok")]);
    draft.mockRejectedValueOnce(new Error("model down"));
    expect(await runRelationshipDmTick(args, storage)).toBe(1);
    expect(storage.finish).toHaveBeenCalledWith(args.sql, expect.objectContaining({ reservationId: "fail", status: "failed" }));
    expect(args.log.error).toHaveBeenCalled();
    const outboundFailure = setup();
    vi.mocked(outboundFailure.args.postOutbound).mockRejectedValue(new Error("network timeout"));
    expect(await runRelationshipDmTick(outboundFailure.args, outboundFailure.storage)).toBe(0);
    expect(outboundFailure.storage.finish).toHaveBeenCalledWith(outboundFailure.args.sql, expect.objectContaining({ status: "failed" }));
  });
});
