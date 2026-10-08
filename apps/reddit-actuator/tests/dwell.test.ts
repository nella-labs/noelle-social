import { describe, it, expect } from "vitest";
import { makeRng } from "../src/lib/rng.js";
import { readingDwellMs, decideStop, glanceMs } from "../src/lib/dwell.js";

const SESSION_WPM = 238;

describe("readingDwellMs", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect(readingDwellMs(a, 100, {}, SESSION_WPM)).toBe(
      readingDwellMs(b, 100, {}, SESSION_WPM)
    );
  });

  it("returns a positive integer", () => {
    const rng = makeRng(1);
    for (let i = 0; i < 100; i++) {
      const v = readingDwellMs(rng, 50, {}, SESSION_WPM);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("floor >= 600 ms across many seeds and word counts", () => {
    for (let seed = 0; seed < 300; seed++) {
      const rng = makeRng(seed);
      const v = readingDwellMs(rng, 5, {}, SESSION_WPM);
      expect(v).toBeGreaterThanOrEqual(600);
    }
  });

  it("cap <= 75000 ms (no-media) across many seeds", () => {
    for (let seed = 0; seed < 300; seed++) {
      const rng = makeRng(seed);
      const v = readingDwellMs(rng, 400, { hasMedia: false }, SESSION_WPM);
      // no media bonus: global ceiling raised 45s → 75s (distracted / deep reads)
      expect(v).toBeLessThanOrEqual(75_000);
    }
  });

  it("mean over many seeds for wordCount=400 > mean for wordCount=20 (monotonic-ish)", () => {
    const N = 2000;
    let sumLong = 0;
    let sumShort = 0;
    for (let seed = 0; seed < N; seed++) {
      sumLong += readingDwellMs(makeRng(seed), 400, {}, SESSION_WPM);
      sumShort += readingDwellMs(makeRng(seed), 20, {}, SESSION_WPM);
    }
    expect(sumLong / N).toBeGreaterThan((sumShort / N) * 1.5);
  });

  it("hasMedia increases mean dwell compared to no-media", () => {
    const N = 2000;
    let sumMedia = 0;
    let sumNoMedia = 0;
    for (let seed = 0; seed < N; seed++) {
      sumMedia += readingDwellMs(makeRng(seed), 100, { hasMedia: true }, SESSION_WPM);
      sumNoMedia += readingDwellMs(makeRng(seed), 100, { hasMedia: false }, SESSION_WPM);
    }
    expect(sumMedia / N).toBeGreaterThan(sumNoMedia / N);
  });

  it("respects wpm clamp: works with extreme sessionWpm values", () => {
    const rng = makeRng(7);
    const vLow = readingDwellMs(rng, 100, {}, 1);    // clamped to 130
    const rng2 = makeRng(7);
    const vHigh = readingDwellMs(rng2, 100, {}, 9999); // clamped to 400
    // low wpm (slow reader) → more time; high wpm → less time
    expect(vLow).toBeGreaterThanOrEqual(600);
    expect(vHigh).toBeGreaterThanOrEqual(600);
  });
});

describe("decideStop", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(99);
    const b = makeRng(99);
    expect(decideStop(a, 100, {})).toBe(decideStop(b, 100, {}));
  });

  it("returns a boolean", () => {
    const rng = makeRng(3);
    const result = decideStop(rng, 50, {});
    expect(typeof result).toBe("boolean");
  });

  it("P(stop) rises with wordCount: stop-rate for wordCount=200 > stop-rate for wordCount=20", () => {
    const N = 5000;
    let stopsLong = 0;
    let stopsShort = 0;
    for (let seed = 0; seed < N; seed++) {
      if (decideStop(makeRng(seed), 200, {})) stopsLong++;
      if (decideStop(makeRng(seed), 20, {})) stopsShort++;
    }
    const rateLong = stopsLong / N;
    const rateShort = stopsShort / N;
    expect(rateLong).toBeGreaterThan(rateShort);
    // both in (0, 1)
    expect(rateShort).toBeGreaterThan(0);
    expect(rateLong).toBeLessThan(1);
  });

  it("hasMedia pushes P(stop) higher than baseline for same wordCount", () => {
    const N = 5000;
    let stopsMedia = 0;
    let stopsNoMedia = 0;
    for (let seed = 0; seed < N; seed++) {
      if (decideStop(makeRng(seed), 50, { hasMedia: true })) stopsMedia++;
      if (decideStop(makeRng(seed), 50, { hasMedia: false })) stopsNoMedia++;
    }
    expect(stopsMedia / N).toBeGreaterThan(stopsNoMedia / N);
  });

  it("isWatchlist pushes P(stop) higher than baseline for same wordCount", () => {
    const N = 5000;
    let stopsWl = 0;
    let stopsNoWl = 0;
    for (let seed = 0; seed < N; seed++) {
      if (decideStop(makeRng(seed), 50, { isWatchlist: true })) stopsWl++;
      if (decideStop(makeRng(seed), 50, { isWatchlist: false })) stopsNoWl++;
    }
    expect(stopsWl / N).toBeGreaterThan(stopsNoWl / N);
  });
});

describe("glanceMs", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(55);
    const b = makeRng(55);
    expect(glanceMs(a)).toBe(glanceMs(b));
  });

  it("always returns an integer within [150, 2500]", () => {
    for (let seed = 0; seed < 500; seed++) {
      const v = glanceMs(makeRng(seed));
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(150);
      expect(v).toBeLessThanOrEqual(2500);
    }
  });
});
