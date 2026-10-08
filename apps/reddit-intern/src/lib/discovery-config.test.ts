import { describe, expect, it } from "vitest";
import { resolveRedditDiscovery, windowSinceISO, laterISO } from "./discovery-config.js";

const DEFAULT_PPS = 7; // stand-in for env.REDDIT_DISCOVERY_LIMIT

describe("resolveRedditDiscovery", () => {
  it("falls back to the env fetch size + no window when nothing is configured", () => {
    const r = resolveRedditDiscovery({}, { defaultPostsPerSource: DEFAULT_PPS });
    expect(r).toEqual({ postsPerSource: DEFAULT_PPS, timeWindowHours: null });
  });

  it("reads the saved default (discovery_config)", () => {
    const r = resolveRedditDiscovery(
      { discovery_config: { postsPerSource: 30, timeWindowHours: 24 } },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r.postsPerSource).toBe(30);
    expect(r.timeWindowHours).toBe(24);
  });

  it("run_config wins field-by-field over the saved default", () => {
    const r = resolveRedditDiscovery(
      {
        discovery_config: { postsPerSource: 30, timeWindowHours: 24 },
        run_config: { timeWindowHours: 6 },
      },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r.postsPerSource).toBe(30); // not overridden by run → keeps default
    expect(r.timeWindowHours).toBe(6); // run wins
  });

  it("an explicit null in run_config turns OFF a window the default set", () => {
    const r = resolveRedditDiscovery(
      { discovery_config: { timeWindowHours: 24 }, run_config: { timeWindowHours: null } },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r.timeWindowHours).toBeNull();
  });

  it("ignores fields that don't apply to Reddit discovery", () => {
    const r = resolveRedditDiscovery(
      { discovery_config: { minFaves: 50, lang: "en", postsPerSource: 12 } },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r).toEqual({ postsPerSource: 12, timeWindowHours: null });
  });

  it("degrades a junk config blob to defaults rather than throwing", () => {
    const r = resolveRedditDiscovery(
      { discovery_config: "not an object", run_config: 42 },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r.postsPerSource).toBe(DEFAULT_PPS);
  });
});

describe("windowSinceISO / laterISO", () => {
  it("windowSinceISO subtracts N hours, or returns null with no window", () => {
    const now = new Date("2026-06-10T00:00:00.000Z");
    expect(windowSinceISO(now, null)).toBeNull();
    expect(windowSinceISO(now, 12)).toBe("2026-06-09T12:00:00.000Z");
  });

  it("laterISO returns the more-recent bound (window narrows past added_at)", () => {
    expect(laterISO("2026-06-01T00:00:00.000Z", "2026-06-09T12:00:00.000Z")).toBe(
      "2026-06-09T12:00:00.000Z",
    );
    expect(laterISO("2026-06-01T00:00:00.000Z", null)).toBe("2026-06-01T00:00:00.000Z");
    expect(laterISO("2026-06-09T00:00:00.000Z", "2026-06-01T00:00:00.000Z")).toBe(
      "2026-06-09T00:00:00.000Z",
    );
  });
});
