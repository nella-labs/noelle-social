import { describe, it, expect } from "vitest";
import {
  parseOwnAccountSnapshot,
  renderOwnAccountBlock,
  snapshotAgeDays,
  OWN_ACCOUNT_MAX_AGE_DAYS,
  type OwnAccountSnapshot,
} from "./own-account.js";

const NOW = new Date("2026-07-26T18:00:00.000Z");

function snap(over: Partial<OwnAccountSnapshot> = {}): OwnAccountSnapshot {
  return {
    handle: "example_operator",
    followers: 103,
    following: 210,
    posts: 412,
    capturedAt: "2026-07-26T12:00:00.000Z",
    source: "x_api",
    ...over,
  };
}

describe("parseOwnAccountSnapshot", () => {
  it("parses a well-formed bus value and strips a leading @", () => {
    const out = parseOwnAccountSnapshot({ ...snap(), handle: "@example_operator" });
    expect(out?.handle).toBe("example_operator");
    expect(out?.followers).toBe(103);
    expect(out?.source).toBe("x_api");
  });

  it("returns null for anything without a usable handle + timestamp", () => {
    expect(parseOwnAccountSnapshot(null)).toBeNull();
    expect(parseOwnAccountSnapshot("nope")).toBeNull();
    expect(parseOwnAccountSnapshot({ followers: 103 })).toBeNull();
    expect(parseOwnAccountSnapshot({ handle: "x", capturedAt: "not-a-date" })).toBeNull();
  });

  it("keeps a missing count as null rather than coercing it to 0", () => {
    // A 0 would be spoken out loud as "0 followers". Unknown must stay unknown.
    const out = parseOwnAccountSnapshot({ ...snap(), followers: undefined, posts: "412" });
    expect(out?.followers).toBeNull();
    expect(out?.posts).toBeNull();
    expect(out?.following).toBe(210);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "103", true])(
    "keeps malformed saved count %s unknown",
    (count) => {
      const out = parseOwnAccountSnapshot({ ...snap(), followers: count, following: count, posts: count });
      expect(out?.followers).toBeNull();
      expect(out?.following).toBeNull();
      expect(out?.posts).toBeNull();
    },
  );

  it("preserves measured zero counts", () => {
    const out = parseOwnAccountSnapshot(snap({ followers: 0, following: 0, posts: 0 }));
    expect(out).toMatchObject({ followers: 0, following: 0, posts: 0 });
  });

  it.each(["2026-02-30T12:00:00.000Z", "2026-02-29T12:00:00.000Z"])(
    "rejects impossible saved timestamp %s",
    (capturedAt) => expect(parseOwnAccountSnapshot(snap({ capturedAt }))).toBeNull(),
  );

  it.each([
    ["2024-02-29T12:00:00Z", "2024-02-29T12:00:00.000Z"],
    ["Sun Jul 26 12:00:00 +0000 2026", "2026-07-26T12:00:00.000Z"],
  ])("normalizes valid source timestamp %s", (capturedAt, expected) => {
    expect(parseOwnAccountSnapshot(snap({ capturedAt }))?.capturedAt).toBe(expected);
  });
});

describe("snapshotAgeDays", () => {
  it("measures age from capturedAt", () => {
    expect(snapshotAgeDays(snap(), NOW)).toBeCloseTo(0.25, 5);
  });

  it("is Infinity for an unparseable timestamp", () => {
    expect(snapshotAgeDays(snap({ capturedAt: "garbage" }), NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is Infinity for an impossible calendar date", () => {
    expect(snapshotAgeDays(snap({ capturedAt: "2026-02-30T12:00:00Z" }), NOW))
      .toBe(Number.POSITIVE_INFINITY);
  });
});

describe("renderOwnAccountBlock", () => {
  it("states the real counts when the snapshot is fresh", () => {
    const block = renderOwnAccountBlock(snap(), NOW);
    expect(block).toContain("@example_operator");
    expect(block).toContain("103 followers");
    expect(block).toContain("following 210");
    expect(block).toContain("412 posts");
    expect(block).toContain("6 hours ago");
  });

  it("omits a count that is unknown instead of printing zero", () => {
    const block = renderOwnAccountBlock(snap({ followers: null, following: null, posts: null }), NOW);
    // Assert on the FACTS line only; the trailing ban paragraph names these
    // words on purpose and would mask a leak here.
    const measured = block.split("\n").find((l) => l.startsWith("Measured ")) ?? "";
    expect(measured).toContain("@example_operator");
    // The handle survives; not one count is printed (a 0 here becomes "0
    // followers" in a reply). The age still carries a digit, hence the split.
    const facts = measured.slice(measured.indexOf("@"));
    expect(facts).not.toMatch(/\d/);
    expect(facts).not.toContain("followers");
    expect(facts).not.toContain("posts");
  });

  it("sanitizes saved counts even when passed directly to the renderer", () => {
    const block = renderOwnAccountBlock(snap({ followers: -103, following: 210.5, posts: 0 }), NOW);
    const measured = block.split("\n").find((line) => line.startsWith("Measured ")) ?? "";
    expect(measured).not.toContain("followers");
    expect(measured).not.toContain("following");
    expect(measured).toContain("0 posts");
  });

  it("treats a future capture as unknown rather than a fresh measurement", () => {
    const block = renderOwnAccountBlock(snap({ capturedAt: "2100-01-01T00:00:00Z" }), NOW);
    expect(block).not.toContain("Measured ");
    expect(block).not.toContain("103 followers");
    expect(block).not.toContain("just now");
    expect(block).toContain("Treat every count as unknown");
  });

  it("treats an impossible direct capture as unavailable", () => {
    const block = renderOwnAccountBlock(snap({ capturedAt: "2026-02-30T12:00:00Z" }),
      new Date("2026-03-02T18:00:00Z"));
    expect(block).not.toContain("Measured ");
    expect(block).not.toContain("103 followers");
    expect(block).toContain("No current measurement");
  });

  it("keeps a measurement at the configured age limit usable", () => {
    const capturedAt = new Date(NOW.getTime() - OWN_ACCOUNT_MAX_AGE_DAYS * 86_400_000).toISOString();
    expect(renderOwnAccountBlock(snap({ capturedAt }), NOW)).toContain("103 followers");
  });

  it("refuses to state a stale count, and says why", () => {
    const stale = snap({ capturedAt: "2026-07-11T16:02:53.773Z" });
    expect(snapshotAgeDays(stale, NOW)).toBeGreaterThan(OWN_ACCOUNT_MAX_AGE_DAYS);
    const block = renderOwnAccountBlock(stale, NOW);
    expect(block).not.toContain("103 followers");
    expect(block).not.toContain("68 followers");
    expect(block).toContain("no longer accurate");
    expect(block).toContain("unknown");
  });

  it("still renders a block with NO snapshot at all — the ban is the point", () => {
    const block = renderOwnAccountBlock(null, NOW);
    expect(block).toContain("No current measurement");
    expect(block).toContain("Treat every count as unknown");
  });

  it("always forbids inventing a self-number, in every branch", () => {
    for (const s of [snap(), snap({ capturedAt: "2026-06-01T00:00:00.000Z" }), null]) {
      const block = renderOwnAccountBlock(s, NOW);
      expect(block).toContain("Never estimate, guess, or invent one");
      expect(block).toContain("not followers, impressions, revenue");
    }
  });

  it("does not permit unsupported qualitative claims about the account", () => {
    const block = renderOwnAccountBlock(null, NOW);
    expect(block).not.toContain('"barely anyone follows me" is fine');
    expect(block).toContain("Do not replace an unknown number with an unsupported qualitative claim");
  });

  it("forbids an unsupported concrete self-count", () => {
    expect(renderOwnAccountBlock(null, NOW)).toContain('"24 followers" is not');
  });
});
