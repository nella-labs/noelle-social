import { describe, expect, it } from "vitest";
import {
  resolveDiscoveryConfig,
  laterISO,
  buildSearchQuery,
  sinceFromWindow,
  type ResolvedDiscoveryConfig,
} from "./discovery-config.js";

const NOW = new Date("2026-06-10T12:00:00.000Z");

describe("resolveDiscoveryConfig", () => {
  it("falls back to worker defaults when no config is set", () => {
    const c = resolveDiscoveryConfig({ id: "i", org_id: "o" });
    expect(c.postsPerSource).toBe(20);
    expect(c.timeWindowHours).toBeNull();
    // Engagement floor + top-level-only are ON by default: the agent should
    // engage performing original posts, not low-signal replies.
    expect(c.minFaves).toBe(50);
    expect(c.excludeReplies).toBe(true);
    expect(c.excludeRetweets).toBe(false);
  });

  it("lets the run override null out the engagement floor", () => {
    const c = resolveDiscoveryConfig({
      id: "i",
      org_id: "o",
      run_config: { minFaves: null },
    });
    expect(c.minFaves).toBeNull();
  });

  it("applies the saved default", () => {
    const c = resolveDiscoveryConfig({
      id: "i",
      org_id: "o",
      discovery_config: { timeWindowHours: 24, minFaves: 50 },
    });
    expect(c.timeWindowHours).toBe(24);
    expect(c.minFaves).toBe(50);
    expect(c.postsPerSource).toBe(20); // unset → default
  });

  it("lets the run override win field-by-field over the default", () => {
    const c = resolveDiscoveryConfig({
      id: "i",
      org_id: "o",
      discovery_config: { timeWindowHours: 24, minFaves: 50, postsPerSource: 40 },
      run_config: { timeWindowHours: 6 },
    });
    expect(c.timeWindowHours).toBe(6); // overridden
    expect(c.minFaves).toBe(50); // inherited from default
    expect(c.postsPerSource).toBe(40); // inherited from default
  });

  it("treats an explicit null in the run override as 'turn the filter off'", () => {
    const c = resolveDiscoveryConfig({
      id: "i",
      org_id: "o",
      discovery_config: { timeWindowHours: 24 },
      run_config: { timeWindowHours: null },
    });
    expect(c.timeWindowHours).toBeNull();
  });

  it("degrades a malformed config blob to defaults instead of throwing", () => {
    const c = resolveDiscoveryConfig({
      id: "i",
      org_id: "o",
      discovery_config: { postsPerSource: 9999, bogus: true } as never,
    });
    // out-of-range / unknown keys fail strict validation → whole layer dropped
    expect(c.postsPerSource).toBe(20);
  });
});

describe("sinceFromWindow", () => {
  it("returns undefined when no window is set", () => {
    expect(sinceFromWindow(NOW, null)).toBeUndefined();
  });
  it("subtracts N hours from now", () => {
    expect(sinceFromWindow(NOW, 6)).toBe("2026-06-10T06:00:00.000Z");
  });
});

describe("buildSearchQuery", () => {
  const base: ResolvedDiscoveryConfig = {
    timeWindowHours: null,
    postsPerSource: 20,
    minFaves: null,
    minReplies: null,
    excludeRetweets: false,
    excludeReplies: false,
    lang: null,
    minReactions: null,
    minComments: null,
  };

  it("returns the bare keyword when no operators apply", () => {
    expect(buildSearchQuery("ai agents", base, NOW)).toBe("ai agents");
  });

  it("appends engagement, post-type, lang and since_time operators", () => {
    const q = buildSearchQuery(
      "ai agents",
      {
        ...base,
        minFaves: 50,
        minReplies: 3,
        excludeRetweets: true,
        excludeReplies: true,
        lang: "en",
        timeWindowHours: 6,
      },
      NOW,
    );
    expect(q).toContain("ai agents");
    expect(q).toContain("min_faves:50");
    expect(q).toContain("min_replies:3");
    expect(q).toContain("-filter:nativeretweets");
    expect(q).toContain("-filter:replies");
    expect(q).toContain("lang:en");
    // 2026-06-10T06:00:00Z in unix seconds
    expect(q).toContain(`since_time:${Math.floor(new Date("2026-06-10T06:00:00.000Z").getTime() / 1000)}`);
  });

  it("omits a zero engagement floor", () => {
    expect(buildSearchQuery("x", { ...base, minFaves: 0 }, NOW)).toBe("x");
  });
});

describe("laterISO", () => {
  const a = "2026-05-25T00:00:00.000Z";
  const later = "2026-05-29T00:00:00.000Z";

  it("returns the later of two ISO strings", () => {
    expect(laterISO(a, later)).toBe(later);
    expect(laterISO(later, a)).toBe(later);
  });

  it("returns the base when b is null/undefined", () => {
    expect(laterISO(a, null)).toBe(a);
    expect(laterISO(a, undefined)).toBe(a);
  });

  it("coerces a Date — postgres.js hands timestamptz back as one", () => {
    // `new Date(...) > "iso"` is an abstract relational comparison: not both
    // strings, so both coerce via Number() and Number(iso) is NaN, making every
    // comparison false. That made the added_at narrowing a silent no-op.
    expect(laterISO(a, new Date(later))).toBe(later);
    expect(laterISO(later, new Date(a))).toBe(later);
  });

  it("never widens: the result is always >= the base", () => {
    for (const b of [null, undefined, a, later, new Date(a), new Date(later)]) {
      expect(laterISO(a, b as never) >= a).toBe(true);
    }
  });
});
