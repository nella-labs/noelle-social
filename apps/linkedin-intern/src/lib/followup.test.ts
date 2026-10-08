import { describe, expect, it } from "vitest";
import { WRITING_STRUCTURE_GUIDANCE } from "@noelle/runtime";
import {
  buildConnectionBrief,
  scrubFollowupDm,
  FOLLOWUP_ROUTING,
  type FollowupPerson,
  type FollowupPost,
} from "./followup.js";
import type { CodexRunner, DraftCallArgs } from "./codex-runner.js";

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

const person: FollowupPerson = {
  name: "Kaia Tham",
  headline: "Founder @ Loom Robotics · ex-Boston Dynamics",
  publicId: "kaia-tham",
};

const posts: FollowupPost[] = [
  { text: "We shipped closed-loop force control on our arm this week. Six months of pain.", reactions: 120 },
  { text: "Hot take: most robotics demos are puppeteered. Ours isn't and it shows.", reactions: 88 },
];

function brief(parts: {
  common?: string[];
  talking?: string[];
  questions?: string[];
  dm: string;
}): string {
  return JSON.stringify({
    common_ground: parts.common ?? ["Both building hard hardware from scratch"],
    talking_points: parts.talking ?? ["Closed-loop force control shipped this week"],
    questions: parts.questions ?? [
      "What broke most often while you were tuning the force loop?",
      "How do you tell a puppeteered demo from a real one at a glance?",
    ],
    followup_dm: parts.dm,
  });
}

const baseArgs = {
  orgId: "org",
  instanceId: "inst",
  person,
  posts,
};

describe("buildConnectionBrief", () => {
  it("supplies the configured Opus route to the shared runtime as linkedin_intern, worker=followup", async () => {
    const { runner, calls } = stubRunner([
      brief({ dm: "congrats on the force control ship. what was the nastiest failure mode you hit?" }),
    ]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(FOLLOWUP_ROUTING.primary).toEqual({ engine: "bedrock", model: "claude-opus-4-6" });
    expect(calls[0]?.agentRole).toBe("linkedin_intern");
    expect(calls[0]?.worker).toBe("followup");
    expect(out?.questions.length).toBeGreaterThanOrEqual(2);
    expect(out?.followupDm).toContain("force control");
  });

  it("returns the parsed brief (common ground, talking points, questions)", async () => {
    const { runner } = stubRunner([
      brief({
        common: ["Both shipping robotics the hard way"],
        talking: ["Force control shipped after six months", "Anti-puppeteer stance on demos"],
        questions: ["What broke most often?", "How do you spot a faked demo?", "What's next on the arm?"],
        dm: "six months for closed-loop force control is wild. what fought back the hardest?",
      }),
    ]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(out?.commonGround).toHaveLength(1);
    expect(out?.talkingPoints).toHaveLength(2);
    expect(out?.questions).toHaveLength(3);
    expect(out?.model).toBe("claude-opus-4-6");
  });

  it("strips em-dashes from the follow-up DM", async () => {
    const { runner } = stubRunner([
      brief({ dm: "six months of pain — that closed loop — what fought back hardest?" }),
    ]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(out?.followupDm).not.toContain("—");
  });

  it("preserves shared writing guidance, brief constraints and source facts on regeneration", async () => {
    const { runner, calls } = stubRunner([
      brief({ dm: "Curious: what was the biggest hurdle in the force loop?" }),
      brief({ dm: "what fought back hardest while you were tuning the force loop?" }),
    ]);
    const out = await buildConnectionBrief({
      runner,
      ...baseArgs,
      authoredComments: ["Sim-to-real transfer is where the controller fails."],
      existingSummary: "Robotics founder writing about hardware failure modes.",
      objective: "Learn about force control",
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.system).toContain(WRITING_STRUCTURE_GUIDANCE);
      expect(call.system).toContain("Under ~600 characters.");
      expect(call.system).toContain("No pitch, no product, no link, no CTA.");
      expect(call.system).toContain('Output ONLY strict JSON: {"common_ground":[...],"talking_points":[...],"questions":[...],"followup_dm":"..."}');
      expect(call.prompt).toContain("Kaia Tham (linkedin.com/in/kaia-tham)");
      expect(call.prompt).toContain("Founder @ Loom Robotics · ex-Boston Dynamics");
      expect(call.prompt).toContain("We shipped closed-loop force control on our arm this week. Six months of pain.");
      expect(call.prompt).toContain("Sim-to-real transfer is where the controller fails.");
      expect(call.prompt).toContain("Robotics founder writing about hardware failure modes.");
      expect(call.prompt).toContain("Operator's angle with this person: Learn about force control");
    }
    expect(out?.followupDm).toBe("what fought back hardest while you were tuning the force loop?");
  });

  it("grounds on authored comments even when the person has no posts", async () => {
    const { runner, calls } = stubRunner([
      brief({ dm: "your take on sim-to-real transfer stuck with me. how are you closing that gap?" }),
    ]);
    const out = await buildConnectionBrief({
      runner,
      orgId: "org",
      instanceId: "inst",
      person: { name: "Kaia Tham", headline: null, publicId: "kaia-tham" },
      posts: [],
      authoredComments: ["Sim-to-real is where most robotics startups quietly die."],
    });
    expect(out).not.toBeNull();
    expect(calls[0]?.prompt).toContain("Comments they wrote");
  });

  it("returns null when there is nothing to ground on (no posts, comments, or summary)", async () => {
    const { runner, calls } = stubRunner([brief({ dm: "hi" })]);
    const out = await buildConnectionBrief({
      runner,
      orgId: "org",
      instanceId: "inst",
      person: { name: "Ghost", headline: null, publicId: "ghost" },
      posts: [],
    });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0); // never spends an LLM call with no grounding
  });

  it("includes a prior profile summary in the prompt when provided", async () => {
    const { runner, calls } = stubRunner([brief({ dm: "great to connect. what's the arm's next milestone?" })]);
    await buildConnectionBrief({
      runner,
      ...baseArgs,
      existingSummary: "Robotics founder, writes candidly about hardware failure modes.",
      objective: "Potential design partner for the actuator work",
    });
    expect(calls[0]?.prompt).toContain("Prior profile summary");
    expect(calls[0]?.prompt).toContain("Operator's angle");
  });

  it("fails closed (null) when the runner throws", async () => {
    const runner: Pick<CodexRunner, "draft"> = {
      async draft() {
        throw new Error("engine down");
      },
    };
    expect(await buildConnectionBrief({ runner, ...baseArgs })).toBeNull();
  });

  it("returns null when the model output fails the schema twice", async () => {
    const { runner, calls } = stubRunner(["not json", "still not json"]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(out).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("does not return a rejected DM when its rewrite fails", async () => {
    const { runner, calls } = stubRunner([
      brief({ dm: "Curious: what broke first while tuning the force loop?" }),
      "not json at all", // attempt 1 can't be parsed
    ]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(calls).toHaveLength(2);
    expect(out).toBeNull();
  });

  it.each(["Curious how you chose the controller?", "the line that stuck with me was the force loop"])("blocks a repeatedly rejected follow-up: %s", async (dm) => {
    const { runner, calls } = stubRunner([brief({ dm })]);
    expect(await buildConnectionBrief({ runner, ...baseArgs })).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("prunes a stray empty bullet instead of rejecting the whole brief", async () => {
    const { runner } = stubRunner([
      JSON.stringify({
        common_ground: ["Both build hard hardware"],
        talking_points: ["Force control shipped", "", "   "],
        questions: ["What broke first?", ""],
        followup_dm: "six months for force control is wild. what fought back hardest?",
      }),
    ]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(out).not.toBeNull();
    expect(out?.talkingPoints).toEqual(["Force control shipped"]);
    expect(out?.questions).toEqual(["What broke first?"]);
  });

  it("strips em-dashes from questions + talking points, not only the DM", async () => {
    const { runner } = stubRunner([
      JSON.stringify({
        common_ground: [],
        talking_points: ["Shipped force control — after six months"],
        questions: ["What surprised you — the actuator or the controller?"],
        followup_dm: "what fought back hardest while tuning the force loop?",
      }),
    ]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(out?.questions[0]).not.toContain("—");
    expect(out?.talkingPoints[0]).not.toContain("—");
  });

  it("regenerates when the DM ends with a banned 'Let me know' closer", async () => {
    const { runner, calls } = stubRunner([
      brief({ dm: "your force-control ship stuck with me. what fought back hardest? Let me know what you land on." }),
      brief({ dm: "your force-control ship stuck with me. what fought back hardest?" }),
    ]);
    const out = await buildConnectionBrief({ runner, ...baseArgs });
    expect(calls).toHaveLength(2);
    expect(out?.followupDm).toBe("your force-control ship stuck with me. what fought back hardest?");
  });
});

describe("scrubFollowupDm", () => {
  it("unwraps a real 'Here's a DM:' instruction wrapper + quotes and strips em-dashes", () => {
    expect(scrubFollowupDm(`Here's a DM: "nice work — really sharp"`)).toBe("nice work, really sharp");
  });

  it("preserves a legitimate warm 'Here's what ...:' opener (not a wrapper)", () => {
    const dm = "Here's what stuck with me: your closed-loop force control ship. what fought back hardest?";
    expect(scrubFollowupDm(dm)).toBe(dm);
  });

  it("does not strip a lone closing quote when the DM isn't a wrapped pair", () => {
    const dm = 'that idea you called your "moat" is the part I keep thinking about.';
    expect(scrubFollowupDm(dm)).toBe(dm);
  });

  it("keeps a single paragraph break but collapses blank-line runs", () => {
    expect(scrubFollowupDm("line one\n\n\n\nline two")).toBe("line one\n\nline two");
  });
});
