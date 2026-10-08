import { describe, it, expect, vi } from "vitest";
import { runIdeationTick } from "./ideation-tick.js";
import type { IdeationGather } from "../lib/ideation.js";
import type { IdeationRequest } from "../lib/ideation-requests-db.js";
import type { ActiveInstance } from "../lib/activation.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const instance = { id: "i1", org_id: "o1", model_overrides: null, objective: null } as unknown as ActiveInstance;

const fullGather: IdeationGather = {
  repliedPosts: [],
  topAuthors: [
    {
      authorHandle: "alice",
      authorId: "u",
      authorName: "Alice",
      authorHeadline: "Founder",
      postCount: 3,
      avgEngagement: 100,
      totalEngagement: 300,
      samplePosts: [{ externalId: "p1", text: "hot take", url: "https://li/p1", reactions: 100, comments: 5 }],
    },
  ],
  keywordPosts: [],
  playbooks: [],
  voiceAnchors: ["blunt lowercase voice"],
  pillars: ["hiring"],
};

const req = (over: Partial<IdeationRequest> = {}): IdeationRequest => ({
  id: "r1",
  orgId: "o1",
  agentInstanceId: "i1",
  mode: "single",
  count: 3,
  topics: [],
  weekStart: null,
  batchId: null,
  ideaId: null,
  targetPlatforms: null,
  ...over,
});

const ideasJson = JSON.stringify({
  ideas: [
    { hook: "Stop hiring seniors", thesis: "juniors compound", angle: "contrarian", pillar: "hiring", inspiration_tags: ["W1"] },
  ],
});
const repairedIdeasJson = JSON.stringify({ ideas: [{ ...JSON.parse(ideasJson).ideas[0], repair_id: 0 }] });

describe("runIdeationTick", () => {
  it("preserves the original source and metadata when a rewrite changes them", async () => {
    const original = { ...JSON.parse(ideasJson).ideas[0], hook: "Let that sink in." };
    const runner = { draft: vi.fn()
      .mockResolvedValueOnce({ text: JSON.stringify({ ideas: [original] }), engine: "first", model: "first" })
      .mockResolvedValueOnce({ text: JSON.stringify({ ideas: [{
        repair_id: 0, hook: "Stop hiring seniors", thesis: "juniors compound",
        angle: "story", pillar: "fundraising",
      }] }), engine: "repair", model: "repair" }) };
    const sink = vi.fn().mockResolvedValue({ idea_ids: ["x1"] });
    expect(await runIdeationTick({
      log, instance, request: req(), gather: async () => fullGather,
      runner, sink, idFactory: () => "x1", defaultCount: 5,
    })).toBe(1);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]![0][0]).toMatchObject({
      hook: "Stop hiring seniors", thesis: "juniors compound", angle: "contrarian", pillar: "hiring",
      inspirationRefs: [{ kind: "watchlist_post", url: "https://li/p1" }],
    });
  });

  it.each(["hook", "thesis"] as const)("rewrites a banned %s once before saving", async (field) => {
    const bad = { ...JSON.parse(ideasJson).ideas[0], [field]: "Let that sink in." };
    const runner = {
      draft: vi.fn()
        .mockResolvedValueOnce({ text: JSON.stringify({ ideas: [bad] }), engine: "first", model: "first" })
        .mockResolvedValueOnce({ text: repairedIdeasJson, engine: "repair", model: "repair" }),
    };
    const sink = vi.fn().mockResolvedValue({ idea_ids: ["x1"] });
    const n = await runIdeationTick({
      log, instance, request: req(), gather: async () => fullGather,
      runner, sink, idFactory: () => "x1", defaultCount: 5,
    });
    expect(n).toBe(1);
    expect(runner.draft).toHaveBeenCalledTimes(2);
    const repair = runner.draft.mock.calls[1]![0].prompt as string;
    expect(repair).toContain("Let that sink in.");
    expect(repair).toContain(field);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]![0][0]).toMatchObject({
      hook: "Stop hiring seniors", thesis: "juniors compound", sourceEngine: "repair", model: "repair",
    });
  });

  it.each(["bad", "invalid"])("rejects a %s rewrite without saving ideas", async (retry) => {
    const bad = JSON.stringify({ ideas: [{ hook: "Let that sink in." }] });
    const badRepair = JSON.stringify({ ideas: [{ hook: "Let that sink in.", repair_id: 0 }] });
    const runner = {
      draft: vi.fn()
        .mockResolvedValueOnce({ text: bad, engine: "first", model: "first" })
        .mockResolvedValueOnce({ text: retry === "bad" ? badRepair : "not json", engine: "repair", model: "repair" }),
    };
    const sink = vi.fn().mockResolvedValue({ idea_ids: ["x1"] });
    await expect(runIdeationTick({
      log, instance, request: req(), gather: async () => fullGather,
      runner, sink, idFactory: () => "x1", defaultCount: 5,
    })).rejects.toThrow();
    expect(runner.draft).toHaveBeenCalledTimes(2);
    expect(sink).not.toHaveBeenCalled();
  });

  it("gathers, synthesizes, and sinks ideas", async () => {
    let counter = 0;
    const runner = { draft: vi.fn().mockResolvedValue({ text: ideasJson, engine: "bedrock", model: "m" }) };
    const sink = vi.fn().mockResolvedValue({ idea_ids: ["x1"] });

    const n = await runIdeationTick({
      log,
      instance,
      request: req(),
      gather: async () => fullGather,
      runner,
      sink,
      idFactory: () => `id-${++counter}`,
      defaultCount: 5,
    });

    expect(n).toBe(1);
    expect(runner.draft).toHaveBeenCalledOnce();
    // the single idea cites W1 → one inspiration ref resolved
    const sunk = sink.mock.calls[0]![0];
    expect(sunk[0].inspirationRefs).toHaveLength(1);
    expect(sunk[0].inspirationRefs[0].url).toBe("https://li/p1");
  });

  it("skips with 0 when nothing was gathered", async () => {
    const runner = { draft: vi.fn() };
    const sink = vi.fn();
    const n = await runIdeationTick({
      log,
      instance,
      request: req(),
      gather: async () => ({
        repliedPosts: [],
        topAuthors: [],
        keywordPosts: [],
        playbooks: [],
        voiceAnchors: [],
        pillars: [],
      }),
      runner,
      sink,
      idFactory: () => "x",
      defaultCount: 5,
    });
    expect(n).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("returns 0 on a model parse failure (no sink)", async () => {
    const runner = { draft: vi.fn().mockResolvedValue({ text: "not json", engine: "bedrock", model: "m" }) };
    const sink = vi.fn();
    const n = await runIdeationTick({
      log,
      instance,
      request: req(),
      gather: async () => fullGather,
      runner,
      sink,
      idFactory: () => "x",
      defaultCount: 5,
    });
    expect(n).toBe(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it("batch mode asks for 7 ideas", async () => {
    const runner = { draft: vi.fn().mockResolvedValue({ text: ideasJson, engine: "bedrock", model: "m" }) };
    await runIdeationTick({
      log,
      instance,
      request: req({ mode: "batch", weekStart: "2026-06-22" }),
      gather: async () => fullGather,
      runner,
      sink: vi.fn().mockResolvedValue({ idea_ids: ["x"] }),
      idFactory: () => "x",
      defaultCount: 5,
    });
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("exactly 7 ideas");
  });

  it("generates ideas from only saved replied-post context", async () => {
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          ideas: [
            {
              hook: "Every sales dashboard hides one floor problem.",
