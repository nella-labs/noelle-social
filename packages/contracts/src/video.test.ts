import { describe, it, expect } from "vitest";
import {
  VideoFeederConfigSchema,
  VideoWatchlistSourceSchema,
  VideoWatchlistNicheSchema,
  VideoTeardownSchema,
  VideoUltraProfileSchema,
  VideoPlatformSchema,
  HarvestRunSummarySchema,
} from "./video.js";

describe("VideoPlatformSchema", () => {
  it("accepts instagram + tiktok only", () => {
    expect(VideoPlatformSchema.parse("tiktok")).toBe("tiktok");
    expect(VideoPlatformSchema.parse("instagram")).toBe("instagram");
    expect(() => VideoPlatformSchema.parse("youtube")).toThrow();
  });
});

describe("VideoFeederConfigSchema", () => {
  it("fills sensible defaults from an empty object", () => {
    const cfg = VideoFeederConfigSchema.parse({});
    expect(cfg.topByViews).toBe(10);
    expect(cfg.outperformers).toEqual({ ratio: 2, n: 10 });
    expect(cfg.nicheTrending.recencyWindowHours).toBe(168);
    expect(cfg.deepTierPercentile).toBe(90);
    expect(cfg.maxVideoExemplars).toBe(4);
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => VideoFeederConfigSchema.parse({ nope: 1 })).toThrow();
  });

  it("honours overrides without dropping other defaults", () => {
    const cfg = VideoFeederConfigSchema.parse({ topByViews: 25, outperformers: { ratio: 3, n: 5 } });
    expect(cfg.topByViews).toBe(25);
    expect(cfg.outperformers).toEqual({ ratio: 3, n: 5 });
    expect(cfg.maxPerSource).toBe(30);
  });
});

describe("VideoWatchlistSourceSchema", () => {
  it("normalizes handle (trim + lowercase) and defaults platform/enabled", () => {
    const s = VideoWatchlistSourceSchema.parse({ handle: "  ChrisDoesViral " });
    expect(s.handle).toBe("chrisdoesviral");
    expect(s.platform).toBe("instagram");
    expect(s.enabled).toBe(true);
  });
});

describe("VideoWatchlistNicheSchema", () => {
  it("requires a query and defaults platform", () => {
    const n = VideoWatchlistNicheSchema.parse({ query: "ai founders" });
    expect(n.query).toBe("ai founders");
    expect(n.platform).toBe("instagram");
    expect(() => VideoWatchlistNicheSchema.parse({ query: "" })).toThrow();
  });
});

describe("VideoTeardownSchema", () => {
  it("parses a minimal teardown and defaults the arrays", () => {
    const t = VideoTeardownSchema.parse({
      hook: { text: "stop scrolling", type: "pattern_interrupt" },
      pacing: { cutsPerSec: 1.2, avgBeatSec: 2.5, wordsPerSec: 3.1 },
      cta: { present: true, text: "follow for more", placement: "end" },
      sound: { trending: true },
      whyItWorked: "fast hook + tight payoff",
    });
    expect(t.beats).toEqual([]);
    expect(t.transitions).toEqual([]);
    expect(t.onscreen).toEqual([]);
    expect(t.cta.placement).toBe("end");
  });
});

describe("VideoUltraProfileSchema", () => {
  it("defaults the distillation arrays", () => {
    const p = VideoUltraProfileSchema.parse({ whatPerforms: "punchy hooks + 3-beat payoff" });
    expect(p.hookLibrary).toEqual([]);
    expect(p.transitionVocabulary).toEqual([]);
    expect(p.structureTemplates).toEqual([]);
  });
});

describe("HarvestRunSummarySchema", () => {
  it("defaults to an empty starting run (an empty {} is a valid live summary)", () => {
    const s = HarvestRunSummarySchema.parse({});
    expect(s.phase).toBe("starting");
    expect(s.lanes).toEqual([]);
    expect(s.totals).toEqual({ pulled: 0, kept: 0 });
  });

  it("fills lane + drop-reason defaults so a partial lane still validates", () => {
    const s = HarvestRunSummarySchema.parse({
      phase: "niches",
      lanes: [{ kind: "niche", label: "AI", pulled: 30 }],
      config: { nicheMinViews: 300000, nicheRecencyHours: 168, creatorRecencyDays: 90 },
    });
    const lane = s.lanes[0]!;
    expect(lane.kept).toBe(0);
    expect(lane.dropped).toEqual({ belowMinViews: 0, notSelected: 0, offObjective: 0 });
    expect(lane.graded).toBe(false);
  });

  it("rejects an unknown phase", () => {
    expect(() => HarvestRunSummarySchema.parse({ phase: "bogus" })).toThrow();
  });
});
