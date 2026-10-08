import { describe, expect, it, vi } from "vitest";
import { runIntroDmTick, INTRO_DM_POST_TEXT } from "./drafter-tick.js";
import { SYSTEM_LINKEDIN_INTRO, renderIntroDmPrompt } from "../lib/prompts.js";

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

const person = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  fsdProfileId: "ABC123",
  publicId: "maya-builds",
  name: "Maya Lopez",
  headline: "Founder @ Loop",
  objective: "learn what she's building",
  summary: "Ships dev tools fast, posts about agent reliability.",
  topics: ["agents", "dx"],
  tone: "earnest",
  engagementNotes: "be concrete",
  ...over,
});

const introBody = "Hey Maya\n\nbeen seeing your agent reliability posts, the eval stuff is sharp\n\nwhat are you building these days?\n\nwould love to hear about it";
const introOut = JSON.stringify({ body: introBody, char_count: introBody.length });

function deps(over: Record<string, unknown> = {}) {
  const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
  const runner = {
    draft: vi.fn().mockResolvedValue({ text: introOut, engine: "bedrock", model: "claude-sonnet-4-6" }),
  };
  return { postOutbound, runner, ...over };
}

describe("runIntroDmTick", () => {
  it("blocks a stock intro after one failed rewrite", async () => {
    const { postOutbound, runner } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ body: "the part I keep thinking about is your eval work" }), engine: "bedrock", model: "m" });
    const n = await runIntroDmTick({ log, instance: { id: "i", org_id: "o" } as never, claimedPeople: [person()], runner: runner as never, postOutbound });
    expect(n).toBe(0);
    expect(runner.draft).toHaveBeenCalledTimes(2);
    expect(postOutbound).not.toHaveBeenCalled();
  });

  it("drafts ONE kind='dm' draft and posts a synthetic post-less lead", async () => {
    const { postOutbound, runner } = deps();
    const n = await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedPeople: [person()],
      runner: runner as never,
      postOutbound,
    });

    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    const body = postOutbound.mock.calls[0]![0];

    // Exactly one draft, kind="dm", no angle.
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].kind).toBe("dm");
    expect(body.drafts[0].angle).toBeNull();
    expect(body.drafts[0].body).toContain("what are you building these days?");
    expect(body.drafts[0].dmVoiceCheck).toEqual({ pass: true, attempts: 0, reasons: [] });

    // Synthetic POST-LESS lead fields.
    expect(body.platform).toBe("linkedin");
    expect(body.leadId).toBe("ABC123:intro");
    expect(body.originalPostId).toBe("ABC123:intro");
    expect(body.originalPostText).toBe(INTRO_DM_POST_TEXT);
    expect(body.postedAt).toBeNull();
    expect(body.originalPostUrl).toBe("https://www.linkedin.com/in/maya-builds/");
    expect(body.authorHandle).toBe("maya-builds");
    expect(body.authorId).toBe("ABC123");
    expect(body.tier).toBeNull();
    expect(body.postKind).toBe("intro_dm");
  });

  it("falls back to the fsd_profile_id in the URL + handle when publicId is null", async () => {
    const { postOutbound, runner } = deps();
    await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedPeople: [person({ publicId: null, name: null })],
      runner: runner as never,
      postOutbound,
    });
    const body = postOutbound.mock.calls[0]![0];
    expect(body.originalPostUrl).toBe("https://www.linkedin.com/in/ABC123/");
    expect(body.authorHandle).toBe("ABC123");
    expect(body.authorId).toBe("ABC123");
  });

  it("NEVER includes an autoSend field (draft-only invariant)", async () => {
    const { postOutbound, runner } = deps();
    await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o", auto_send_enabled: true } as never,
      claimedPeople: [person()],
      runner: runner as never,
      postOutbound,
    });
    const body = postOutbound.mock.calls[0]![0];
    expect(body.autoSend).toBeUndefined();
    expect("autoSend" in body).toBe(false);
  });

  it("strips em dashes + disallowed emoji and recomputes char_count off the cleaned body", async () => {
    const { postOutbound } = deps();
    const dirty = "Hey Maya\n\nlove the agent work — really sharp 🚀\n\nwhat are you building?";
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ body: dirty, char_count: dirty.length }),
        engine: "bedrock",
        model: "m",
      }),
    };
    await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedPeople: [person()],
      runner: runner as never,
      postOutbound,
    });
    const draft = postOutbound.mock.calls[0]![0].drafts[0];
    expect(draft.body).not.toMatch(/—/); // em dash gone
    expect(draft.body).not.toContain("🚀"); // disallowed emoji gone
    // char_count is recomputed off the cleaned body, not the model's number.
    expect(draft.charCount).toBe([...draft.body].length);
    expect(draft.charCount).not.toBe(dirty.length);
  });

  it("uses the intro SYSTEM prompt + a renderIntroDmPrompt user prompt", async () => {
    const { postOutbound, runner } = deps();
    await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedPeople: [person()],
      runner: runner as never,
      postOutbound,
    });
    const call = runner.draft.mock.calls[0]![0];
    expect(call.system).toBe(SYSTEM_LINKEDIN_INTRO);
    expect(call.agentRole).toBe("linkedin_intern");
    expect(call.worker).toBe("drafter");
    // The user prompt is grounded in the person's profile + asks about their work.
    expect(call.prompt).toContain("Maya");
    expect(call.prompt).toContain("agent reliability");
  });

  it("is FAIL-OPEN per person: one model error logs + continues, does not abort the tick", async () => {
    const { postOutbound } = deps();
    const runner = {
      draft: vi
        .fn()
        .mockRejectedValueOnce(new Error("bedrock 500"))
        .mockResolvedValue({ text: introOut, engine: "bedrock", model: "m" }),
    };
    const markStatus = vi.fn().mockResolvedValue(undefined);
    const n = await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedPeople: [person({ fsdProfileId: "BOOM" }), person({ fsdProfileId: "OK", publicId: "ok-person" })],
      runner: runner as never,
      postOutbound,
      markStatus,
    });
    // First person failed, second still drafted → tick did not abort.
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    expect(postOutbound.mock.calls[0]![0].authorId).toBe("OK");
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ fsdProfileId: "BOOM", status: "errored" }),
    );
  });

  it("skips a person (no post, no abort) when the model output fails the schema", async () => {
    const { postOutbound } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: "not json", engine: "bedrock", model: "m" }) };
    const n = await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedPeople: [person()],
      runner: runner as never,
      postOutbound,
    });
    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
  });

  it("no-ops on an empty claim set", async () => {
    const { postOutbound, runner } = deps();
    const n = await runIntroDmTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedPeople: [],
      runner: runner as never,
      postOutbound,
    });
    expect(n).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
  });
