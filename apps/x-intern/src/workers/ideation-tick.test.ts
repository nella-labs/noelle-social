import { describe, expect, it, vi } from "vitest";
import type { PostIdeaIn } from "@noelle/contracts";
import { runIdeationTick, type RunIdeationTickArgs } from "./ideation-tick.js";

const cleanIdea = {
  hook: "A delayed train can erase the savings on a cheaper ticket.",
  thesis: "Compare the fare with the extra travel time before booking.",
  angle: "observation",
  pillar: "travel",
  inspiration_tags: ["K1"],
};
const badContrast = "being outside the scene is a filter, not a handicap";
const response = (ideas: unknown[], model = "first-model") => ({
  text: JSON.stringify({ ideas }), engine: "codex", model,
});

function setup(responses: Array<ReturnType<typeof response>>) {
  const saved: PostIdeaIn[] = [];
  const draft = vi.fn<RunIdeationTickArgs["runner"]["draft"]>();
  for (const result of responses) draft.mockResolvedValueOnce(result);
  const args: RunIdeationTickArgs = {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    instance: { id: "instance", org_id: "org" },
    request: {
      id: "request", orgId: "org", agentInstanceId: "instance", mode: "single",
      count: 1, topics: ["travel"], weekStart: null, batchId: null,
      ideaId: null, targetPlatforms: null,
    },
    gather: async () => ({
      topAuthors: [], voiceAnchors: ["Write plainly about everyday travel."], pillars: ["travel"],
      keywordPosts: [{ id: "k", text: "Train fares vary by departure time.",
        url: "https://x.com/traveler/status/1", author: "traveler", likes: 90, reposts: 5, replies: 2 }],
    }),
    runner: { draft },
    sink: async (ideas) => {
      saved.push(...ideas);
      return { idea_ids: ideas.map((idea) => idea.id) };
    },
    idFactory: () => `idea-${saved.length}`,
    defaultCount: 3,
  };
  return { args, draft, saved };
}

describe("runIdeationTick anti-AI gate", () => {
  it.each(["hook", "thesis"] as const)("rewrites a flagged %s before saving any ideas", async (field) => {
    const { args, draft, saved } = setup([
      response([{ ...cleanIdea, [field]: badContrast }]),
      response([{ ...cleanIdea, repair_id: 0 }], "rewrite-model"),
    ]);

    expect(await runIdeationTick(args)).toBe(1);
    expect(draft).toHaveBeenCalledTimes(2);
    expect(draft.mock.calls[1]![0].prompt).toContain(draft.mock.calls[0]![0].prompt);
    expect(draft.mock.calls[1]![0].prompt).toContain("contrastive-reframe");
    expect(draft.mock.calls[1]![0].prompt).toContain(badContrast);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ hook: cleanIdea.hook, thesis: cleanIdea.thesis, model: "rewrite-model" });
  });

  it("fails after one rejected rewrite without saving bad ideas", async () => {
    const bad = response([{ ...cleanIdea, thesis: badContrast }]);
    const { args, draft, saved } = setup([bad, response([{ ...cleanIdea, thesis: badContrast, repair_id: 0 }])]);

    await expect(runIdeationTick(args)).rejects.toThrow(/quality|anti.AI/i);
    expect(draft).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([]);
  });

  it("fails closed when the rewrite is malformed", async () => {
    const { args, draft, saved } = setup([
      response([{ ...cleanIdea, hook: badContrast }]),
      { text: "not JSON", engine: "codex", model: "rewrite-model" },
    ]);

    await expect(runIdeationTick(args)).rejects.toThrow();
    expect(draft).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([]);
  });

  it("rejects a same-count rewrite that changes candidate order without saving ideas", async () => {
    const otherIdea = { ...cleanIdea, hook: "An early train leaves more time for missed connections." };
    const { args, draft, saved } = setup([
      response([{ ...cleanIdea, thesis: badContrast }, otherIdea]),
      response([{ ...otherIdea, repair_id: 1 }, { ...cleanIdea, repair_id: 0 }]),
    ]);
    args.request.count = 2;

    await expect(runIdeationTick(args)).rejects.toThrow();
    expect(draft).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([]);
  });

  it("keeps original idea metadata when a matched rewrite drops source tags and changes angle", async () => {
    const { args, saved } = setup([
      response([{ ...cleanIdea, thesis: badContrast }]),
      response([{ repair_id: 0, hook: cleanIdea.hook, thesis: cleanIdea.thesis,
        angle: "made-up-angle", pillar: "unrelated" }], "rewrite-model"),
    ]);

    expect(await runIdeationTick(args)).toBe(1);
    expect(saved[0]).toMatchObject({
      hook: cleanIdea.hook, thesis: cleanIdea.thesis, angle: "observation", pillar: "travel",
      model: "rewrite-model", sourceEngine: "codex",
      inspirationRefs: [{ kind: "keyword_post", url: "https://x.com/traveler/status/1", author: "traveler" }],
    });
  });

  it("saves clean weekly ideas once with source refs, platform scope, and assigned days", async () => {
    const { args, draft, saved } = setup([response(Array.from({ length: 7 }, () => cleanIdea))]);
    args.request = { ...args.request, mode: "batch", weekStart: "2026-09-14",
      batchId: "batch", targetPlatforms: ["x", "linkedin"] };

    expect(await runIdeationTick(args)).toBe(7);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(saved[0]).toMatchObject({ platform: "x", targetPlatforms: ["x", "linkedin"],
      suggestedDay: "2026-09-14", batchId: "batch", sourceEngine: "codex", model: "first-model",
      inspirationRefs: [{ kind: "keyword_post", url: "https://x.com/traveler/status/1", author: "traveler" }] });
    expect(saved[6]!.suggestedDay).toBe("2026-09-20");
  });

  it("synthesizes from already replied posts when no Apify keyword posts are gathered", async () => {
    const idea = {
      ...cleanIdea,
      inspiration_tags: ["R1"],
      hook: "A reply can tell you what your next post should be.",
      thesis: "Turn the real exchange into a standalone opinion instead of hunting fresh viral posts.",
    };
    const { args, draft, saved } = setup([response([idea])]);
    args.gather = async () => ({
      topAuthors: [],
      keywordPosts: [],
      voiceAnchors: [],
      pillars: ["operator instincts"],
      repliedPosts: [
        {
          leadId: "lead-1",
          url: "https://x.com/founder/status/1",
          author: "founder",
          post: "The best content ideas are hiding in the replies you already cared enough to write.",
          reply: "your reply is already the POV, just remove the other person's scaffolding",
          repliedAt: "2026-09-13T12:00:00Z",
        },
      ],
    });

    expect(await runIdeationTick(args)).toBe(1);
    expect(draft).toHaveBeenCalledTimes(1);
    const prompt = draft.mock.calls[0]![0].prompt;
    expect(prompt).toContain("[R1]");
    expect(prompt).toContain("The best content ideas are hiding");
    expect(prompt).toContain("operator replied: your reply is already the POV");
    expect(saved[0]).toMatchObject({
      inspirationRefs: [{
        kind: "replied_post",
        leadId: "lead-1",
        url: "https://x.com/founder/status/1",
        author: "founder",
      }],
    });
  });

  it("keeps initial schema failures at zero without saving or retrying", async () => {
    const { args, draft, saved } = setup([{ text: "not JSON", engine: "codex", model: "first-model" }]);

    expect(await runIdeationTick(args)).toBe(0);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([]);
  });
});
