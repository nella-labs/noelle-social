import { describe, it, expect, vi } from "vitest";
import { runAnalystTick } from "./analyst-tick.js";
import type { AuthorEngagement } from "../lib/engagement-analyst.js";
import { computePercentiles } from "../lib/engagement-analyst.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { PlaybookUpsert } from "../lib/playbooks-db.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const instance = {
  id: "inst-1",
  org_id: "org-1",
  model_overrides: null,
  objective: null,
} as unknown as ActiveInstance;

function author(handle: string, avg: number): AuthorEngagement {
  return {
    authorHandle: handle,
    authorId: `urn-${handle}`,
    authorName: handle,
    authorHeadline: "Founder",
    postCount: 5,
    avgEngagement: avg,
    totalEngagement: avg * 5,
    samplePosts: [
      { externalId: `${handle}-1`, text: "hook one", url: null, reactions: avg, comments: 2 },
    ],
  };
}

const goodPlaybook = JSON.stringify({
  hook_patterns: ["contrarian one-liner", "number + claim"],
  structure_notes: "short, 3 line breaks",
  cadence_notes: "posts about hiring",
  top_topics: ["hiring", "founders"],
});

describe("computePercentiles", () => {
  it("ranks top→1, bottom→0", () => {
    const p = computePercentiles([author("a", 100), author("b", 50), author("c", 10)]);
    expect(p.get("a")).toBe(1);
    expect(p.get("c")).toBe(0);
    expect(p.get("b")).toBeCloseTo(0.5, 4);
  });
  it("single author is the top", () => {
    expect(computePercentiles([author("solo", 10)]).get("solo")).toBe(1);
  });
});

describe("runAnalystTick", () => {
  it("writes a playbook per stale author with the correct percentile", async () => {
    const ranked = [author("a", 100), author("b", 50), author("c", 10)];
    const upserts: PlaybookUpsert[] = [];
    const runner = {
      draft: vi.fn().mockResolvedValue({ text: goodPlaybook, engine: "bedrock", model: "m" }),
    };

    const n = await runAnalystTick({
      log,
      instance,
      ranked,
      freshHandles: new Set(),
      batch: 10,
      runner,
      upsertPlaybook: async (p) => {
        upserts.push(p);
      },
    });

    expect(n).toBe(3);
    expect(runner.draft).toHaveBeenCalledTimes(3);
    expect(upserts.find((u) => u.authorHandle === "a")?.engagementPercentile).toBe(1);
    expect(upserts.find((u) => u.authorHandle === "c")?.engagementPercentile).toBe(0);
    expect(upserts[0]).toMatchObject({
      orgId: "org-1",
      agentInstanceId: "inst-1",
      platform: "linkedin",
      samplePostIds: ["a-1"],
    });
  });

  it("skips fresh authors and honors the batch cap", async () => {
    const ranked = [author("a", 100), author("b", 50), author("c", 10)];
    const runner = {
      draft: vi.fn().mockResolvedValue({ text: goodPlaybook, engine: "bedrock", model: "m" }),
    };
    const seen: string[] = [];

    const n = await runAnalystTick({
      log,
      instance,
      ranked,
      freshHandles: new Set(["a"]), // a is fresh → skipped
      batch: 1, // only one of {b,c}
      runner,
      upsertPlaybook: async (p) => {
        seen.push(p.authorHandle);
      },
    });

    expect(n).toBe(1);
    expect(seen).toEqual(["b"]); // ranked order, a skipped, cap 1
  });

  it("does not throw when a draft fails or returns garbage", async () => {
    const ranked = [author("a", 100), author("b", 50)];
    const runner = {
      draft: vi
        .fn()
        .mockResolvedValueOnce({ text: "not json", engine: "bedrock", model: "m" })
        .mockRejectedValueOnce(new Error("boom")),
    };
    const n = await runAnalystTick({
      log,
      instance,
      ranked,
      freshHandles: new Set(),
      batch: 10,
      runner,
      upsertPlaybook: async () => {},
    });
    expect(n).toBe(0); // one garbage, one threw → none written, no throw
  });

  it("returns 0 when nothing is stale", async () => {
    const ranked = [author("a", 100)];
    const runner = { draft: vi.fn() };
    const n = await runAnalystTick({
      log,
      instance,
      ranked,
      freshHandles: new Set(["a"]),
      batch: 5,
      runner,
      upsertPlaybook: async () => {},
    });
    expect(n).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
  });
  it("does not acknowledge a rejected persistence boundary as a written playbook", async () => {
    const runner = {
      draft: vi.fn().mockResolvedValue({ text: goodPlaybook, engine: "bedrock", model: "m" }),
    };
    const upsertPlaybook = vi.fn(async () => {
      throw new Error("Playbook owner or source provenance unavailable");
    });
    expect(
      await runAnalystTick({
        log,
        instance,
        ranked: [author("a", 100)],
        freshHandles: new Set(),
        batch: 1,
        runner,
        upsertPlaybook,
      }),
    ).toBe(0);
    expect(runner.draft).toHaveBeenCalledOnce();
    expect(upsertPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        agentInstanceId: "inst-1",
        platform: "linkedin",
        samplePostIds: ["a-1"],
      }),
    );
  });
});
