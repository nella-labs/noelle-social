import { describe, expect, it } from "vitest";
import { ANTI_AI_RULES, WRITING_STRUCTURE_GUIDANCE } from "@noelle/runtime";
import { draftVipIntroDm, VIP_DM_ROUTING } from "./vip-dm.js";
import type { CodexRunner, DraftCallArgs } from "./codex-runner.js";

// A stub runner that returns canned text per draft() call, recording the args it
// saw so we can assert the routing/role the VIP DM rides.
function stubRunner(replies: string[]): {
  runner: Pick<CodexRunner, "draft">;
  calls: DraftCallArgs[];
} {
  const calls: DraftCallArgs[] = [];
  let i = 0;
  return {
    calls,
    runner: {
      async draft(args) {
        calls.push(args);
        const text = replies[Math.min(i, replies.length - 1)] ?? "";
        i++;
        return { text, engine: "bedrock", model: "claude-opus-4-6" };
      },
    },
  };
}

const baseArgs = {
  orgId: "org",
  instanceId: "inst",
  authorHandle: "kara",
  postText: "the impossible becomes obvious once you start",
  why: "YC S26 founder in diamonds",
  followers: 1200,
};

describe("draftVipIntroDm (x)", () => {
  it("supplies the configured Opus route to the shared runtime as x_intern", async () => {
    const { runner, calls } = stubRunner(["hey, what myth about diamonds did you unlearn first?"]);
    await draftVipIntroDm({ runner, ...baseArgs });
    expect(VIP_DM_ROUTING.primary).toEqual({ engine: "bedrock", model: "claude-opus-4-6" });
    expect(VIP_DM_ROUTING.fallback).toEqual({ engine: "bedrock", model: "claude-opus-4-6" });
    expect(calls[0]?.agentRole).toBe("x_intern");
  });

  it("strips em-dashes from the model output", async () => {
    const { runner } = stubRunner(["love this — the impossible becoming obvious — how'd you get there?"]);
    const dm = await draftVipIntroDm({ runner, ...baseArgs });
    expect(dm).not.toContain("—");
  });

  it("preserves shared writing guidance, DM constraints and source facts on regeneration", async () => {
    const { runner, calls } = stubRunner([
      "Curious: what's the biggest myth your team unlearned?", // tell → reject
      "hey, what was the biggest myth about diamonds your team had to unlearn?", // clean
    ]);
    const dm = await draftVipIntroDm({ runner, ...baseArgs });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.system).toContain(WRITING_STRUCTURE_GUIDANCE);
      expect(call.system).toContain(ANTI_AI_RULES);
      expect(call.system).toContain("one short paragraph, under ~320 characters");
      expect(call.system).toContain("No pitch, no product, no link, no selling.");
      expect(call.system).toContain("Output ONLY the DM text");
      expect(call.prompt).toContain("Their handle: @kara");
      expect(call.prompt).toContain("Followers: 1200");
      expect(call.prompt).toContain("YC S26 founder in diamonds");
      expect(call.prompt).toContain("the impossible becomes obvious once you start");
    }
    expect(dm).toBe("hey, what was the biggest myth about diamonds your team had to unlearn?");
  });

  it("unwraps surrounding quotes and a 'Here's a DM:' preamble", async () => {
    const { runner } = stubRunner([`Here's a DM: "hey, how'd you land on diamonds of all things?"`]);
    const dm = await draftVipIntroDm({ runner, ...baseArgs });
    expect(dm).toBe("hey, how'd you land on diamonds of all things?");
  });

  it("fails open (null) when the runner throws", async () => {
    const runner: Pick<CodexRunner, "draft"> = {
      async draft() {
        throw new Error("budget exceeded");
      },
    };
    expect(await draftVipIntroDm({ runner, ...baseArgs })).toBeNull();
  });

  it.each([
    "The part I keep thinking about is measurement. Curious how you handle it?",
    "Curious: how did you choose diamonds? Would love to hear.",
  ])("rejects persistent stock outreach framing: %s", async (text) => {
    const { runner, calls } = stubRunner([text]);
    expect(await draftVipIntroDm({ runner, ...baseArgs })).toBeNull();
    expect(calls).toHaveLength(2);
  });
});
