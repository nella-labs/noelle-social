import { describe, expect, it } from "vitest";
import { resolveLinkedinDiscovery, windowSinceISO, laterISO } from "./discovery-config.js";

const DEFAULT_PPS = 7; // stand-in for env.LINKEDIN_DISCOVERY_LIMIT

describe("resolveLinkedinDiscovery", () => {
  it("falls back to the env fetch size + no filters when nothing is configured", () => {
    const r = resolveLinkedinDiscovery({}, { defaultPostsPerSource: DEFAULT_PPS });
    expect(r).toEqual({
      postsPerSource: DEFAULT_PPS,
      timeWindowHours: null,
      minReactions: null,
      minComments: null,
    });
  });

  it("reads the saved default (discovery_config)", () => {
    const r = resolveLinkedinDiscovery(
      { discovery_config: { postsPerSource: 30, timeWindowHours: 24, minReactions: 5 } },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r.postsPerSource).toBe(30);
    expect(r.timeWindowHours).toBe(24);
    expect(r.minReactions).toBe(5);
    expect(r.minComments).toBeNull();
  });

  it("run_config wins field-by-field over the saved default", () => {
    const r = resolveLinkedinDiscovery(
      {
        discovery_config: { postsPerSource: 30, timeWindowHours: 24, minReactions: 5 },
        run_config: { timeWindowHours: 6, minComments: 2 },
      },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r.postsPerSource).toBe(30); // not overridden by run → keeps default
    expect(r.timeWindowHours).toBe(6); // run wins
    expect(r.minReactions).toBe(5); // only in default
    expect(r.minComments).toBe(2); // only in run
  });

  it("an explicit null in run_config turns OFF a filter the default set", () => {
    const r = resolveLinkedinDiscovery(
      { discovery_config: { timeWindowHours: 24 }, run_config: { timeWindowHours: null } },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r.timeWindowHours).toBeNull();
  });

  it("ignores X-only search-operator fields (minFaves/lang/...)", () => {
    const r = resolveLinkedinDiscovery(
      { discovery_config: { minFaves: 50, lang: "en", excludeRetweets: true, minReactions: 3 } },
      { defaultPostsPerSource: DEFAULT_PPS },
    );
    expect(r).toEqual({
      postsPerSource: DEFAULT_PPS,
      timeWindowHours: null,
      minReactions: 3,
      minComments: null,
    });
  });

  it("degrades a junk config blob to defaults rather than throwing", () => {
    const r = resolveLinkedinDiscovery(
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
    // No window → keep added_at.
    expect(laterISO("2026-06-01T00:00:00.000Z", null)).toBe("2026-06-01T00:00:00.000Z");
    // Window older than added_at → never backfill past added_at.
    expect(laterISO("2026-06-09T00:00:00.000Z", "2026-06-01T00:00:00.000Z")).toBe(
      "2026-06-09T00:00:00.000Z",
    );
  });
});
