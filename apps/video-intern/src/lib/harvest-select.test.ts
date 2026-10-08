import { describe, it, expect } from "vitest";
import {
  selectCreatorClips,
  selectNicheClips,
  selectCreatorWithReasons,
  selectNicheWithReasons,
  outperformerRatio,
} from "./harvest-select.js";
import type { VideoClip } from "@noelle/video-apify";
import { VideoFeederConfigSchema } from "@noelle/contracts";

function clip(id: string, views: number, opts: Partial<VideoClip> = {}): VideoClip {
  return {
    id, platform: "instagram", url: `u/${id}`, authorHandle: "creator", caption: "",
    views, likes: opts.likes ?? 0, comments: opts.comments ?? 0, shares: opts.shares ?? 0,
    saves: opts.saves ?? 0, durationSec: null, musicId: null, musicName: null,
    videoUrl: null, thumbUrl: null,
    authorFollowerCount: opts.authorFollowerCount ?? 100_000, postedAt: "", raw: {},
  };
}

const cfg = VideoFeederConfigSchema.parse({ topByViews: 2, topByEngagement: 0, outperformers: { ratio: 2, n: 2 } });

describe("selectCreatorClips", () => {
  it("takes top-N by views", () => {
    const out = selectCreatorClips([clip("a", 10), clip("b", 30), clip("c", 20)], cfg);
    expect(out.map((c) => c.id).sort()).toEqual(["b", "c"]); // top 2 by views
  });

  it("adds outperformers (views ÷ followers ≥ ratio) deduped against the top-N", () => {
    // d has huge views/followers but isn't in the top-2-by-views; e already is.
    const clips = [
      clip("a", 500_000, { authorFollowerCount: 1_000_000 }), // top views, ratio 0.5
      clip("b", 400_000, { authorFollowerCount: 1_000_000 }), // top views, ratio 0.4
      clip("d", 90_000, { authorFollowerCount: 10_000 }),     // ratio 9 → outperformer, NOT in top-2
    ];
    const out = selectCreatorClips(clips, cfg);
    expect(out.map((c) => c.id).sort()).toEqual(["a", "b", "d"]);
    expect(outperformerRatio(clips[2]!)).toBe(9);
  });

  it("does not double-count a clip that is both top-views and an outperformer", () => {
    const clips = [clip("x", 300_000, { authorFollowerCount: 10_000 }), clip("y", 5_000, { authorFollowerCount: 1_000_000 })];
    const out = selectCreatorClips(clips, cfg);
    expect(out.filter((c) => c.id === "x")).toHaveLength(1);
  });
});

describe("selectNicheClips", () => {
  it("applies the min-views floor then top-N", () => {
    const c = VideoFeederConfigSchema.parse({ nicheTrending: { minViews: 50, n: 2, recencyWindowHours: 168 } });
    const out = selectNicheClips([clip("a", 100), clip("b", 10), clip("c", 200), clip("d", 60)], c);
    expect(out.map((x) => x.id)).toEqual(["c", "a"]); // b dropped (<50), top 2 of the rest
  });
});

describe("selectNicheWithReasons", () => {
  it("attributes drops to the min-views floor vs. the top-N cap", () => {
    const c = VideoFeederConfigSchema.parse({ nicheTrending: { minViews: 50, n: 2, recencyWindowHours: 168 } });
    // b (<50) drops to the floor; a,c,d clear it but n=2 keeps only c,a → d is notSelected.
    const { selected, dropped } = selectNicheWithReasons(
      [clip("a", 100), clip("b", 10), clip("c", 200), clip("d", 60)],
      c,
    );
    expect(selected.map((x) => x.id)).toEqual(["c", "a"]);
    expect(dropped.belowMinViews).toBe(1); // b
    expect(dropped.notSelected).toBe(1); // d cleared the floor but lost the top-N cut
  });

  it("reproduces the 300k-floor 'kept:0' failure — every clip below the floor", () => {
    const c = VideoFeederConfigSchema.parse({ nicheTrending: { minViews: 300_000, n: 30, recencyWindowHours: 168 } });
    const { selected, dropped } = selectNicheWithReasons([clip("a", 5_000), clip("b", 120_000), clip("c", 90_000)], c);
    expect(selected).toHaveLength(0);
    expect(dropped.belowMinViews).toBe(3);
    expect(dropped.notSelected).toBe(0);
  });
});

describe("selectCreatorWithReasons", () => {
  it("keeps the selected set and counts the rest as notSelected", () => {
    const { selected, dropped } = selectCreatorWithReasons([clip("a", 10), clip("b", 30), clip("c", 20)], cfg);
    expect(selected.map((x) => x.id).sort()).toEqual(["b", "c"]);
    expect(dropped.notSelected).toBe(1); // a
    expect(dropped.belowMinViews).toBe(0); // no floor on the creator lane
  });
});

describe("unknown source metrics", () => {
  it("never calls a missing view measurement below the niche floor", () => {
    const c = VideoFeederConfigSchema.parse({ nicheTrending: { minViews: 50, n: 2 } });
    const unknown = { ...clip("unknown", 0), views: null } as unknown as VideoClip;
    const { selected, dropped } = selectNicheWithReasons([unknown, clip("below", 0), clip("known", 100)], c);
    expect(selected.map(item => item.id)).toEqual(["known"]);
    expect(dropped).toEqual({ belowMinViews: 1, notSelected: 1 });
  });
  it("keeps real zero at a zero niche floor but excludes unknown", () => {
    const c = VideoFeederConfigSchema.parse({ nicheTrending: { minViews: 0, n: 2 } });
    const unknown = { ...clip("unknown", 0), views: null } as unknown as VideoClip;
    expect(selectNicheClips([unknown, clip("zero", 0)], c).map(item => item.id)).toEqual(["zero"]);
  });
  it("requires measured inputs for each creator performance lane", () => {
    const unknown = { ...clip("unknown", 0), views: null } as unknown as VideoClip;
    const incomplete = { ...clip("incomplete", 10), saves: null, authorFollowerCount: null } as unknown as VideoClip;
    const c = VideoFeederConfigSchema.parse({ topByViews: 0, topByEngagement: 1, outperformers: { ratio: 1, n: 3 } });
    expect(selectCreatorClips([unknown, incomplete], c)).toEqual([]);
    expect(outperformerRatio(unknown)).toBeNull();
    expect(selectCreatorClips([unknown], { ...c, topByViews: 3 })).toEqual([]);
  });
});
