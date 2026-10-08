import { describe, expect, it } from "vitest";
import { draftVipIntroDm, VIP_DM_ROUTING } from "./vip-dm.js";
import type { CodexRunner } from "./codex-runner.js";

function stubRunner(replies: string[]): {
  runner: Pick<CodexRunner, "draft">;
  calls: Array<{ agentRole: string }>;
} {
  const calls: Array<{ agentRole: string }> = [];
  let i = 0;
  return {
    calls,
    runner: {
      async draft(args) {
        calls.push({ agentRole: args.agentRole });
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
  authorName: "Kara",
  authorHeadline: "Founder @ Brilliant (YC S26)",
  postText: "the impossible becomes obvious once you start",
  why: "YC S26 founder in diamonds",
};

describe("draftVipIntroDm (linkedin)", () => {
  it("does not return a still-banned second VIP draft", async () => {
    const { runner, calls } = stubRunner(["Curious how you chose the first test group?"]);
    expect(await draftVipIntroDm({ runner, ...baseArgs })).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("routes through Opus as the linkedin_intern role", async () => {
    const { runner, calls } = stubRunner(["hey, what myth about diamonds did you unlearn first?"]);
    await draftVipIntroDm({ runner, ...baseArgs });
    expect(VIP_DM_ROUTING.primary).toEqual({ engine: "bedrock", model: "claude-opus-4-6" });
    expect(calls[0]?.agentRole).toBe("linkedin_intern");
  });

  it("strips em-dashes from the model output", async () => {
    const { runner } = stubRunner(["love this — the impossible becoming obvious — how'd you get there?"]);
    const dm = await draftVipIntroDm({ runner, ...baseArgs });
    expect(dm).not.toContain("—");
  });

  it("regenerates once when the first draft trips an AI tell", async () => {
    const { runner, calls } = stubRunner([
      "Curious: what's the biggest myth your team unlearned?",
      "hey, what was the biggest myth about diamonds your team had to unlearn?",
    ]);
    const dm = await draftVipIntroDm({ runner, ...baseArgs });
    expect(calls).toHaveLength(2);
    expect(dm).toBe("hey, what was the biggest myth about diamonds your team had to unlearn?");
  });

  it("fails open (null) when the runner throws", async () => {
    const runner: Pick<CodexRunner, "draft"> = {
      async draft() {
        throw new Error("engine down");
      },
    };
    expect(await draftVipIntroDm({ runner, ...baseArgs })).toBeNull();
  });
});
