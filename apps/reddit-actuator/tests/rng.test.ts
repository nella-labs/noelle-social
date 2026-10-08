import { describe, it, expect } from "vitest";
import { makeRng } from "../src/lib/rng.js";

describe("makeRng", () => {
  it("is deterministic for a given seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
  });

  it("next() stays in [0,1)", () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int(min,max) stays within bounds inclusive", () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it("jitter(base, 0.5) returns base±50%", () => {
    const r = makeRng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.jitter(100, 0.5);
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(150);
    }
  });

  // --- new distribution tests ---

  describe("normal(mean, sd)", () => {
    it("is deterministic for a given seed", () => {
      const a = makeRng(99);
      const b = makeRng(99);
      const as = Array.from({ length: 10 }, () => a.normal(10, 2));
      const bs = Array.from({ length: 10 }, () => b.normal(10, 2));
      expect(as).toEqual(bs);
    });

    it("mean ≈ 10 and stddev ≈ 2 over 20000 draws", () => {
      const N = 20000;
      const r = makeRng(12345);
      const samples = Array.from({ length: N }, () => r.normal(10, 2));
      const mean = samples.reduce((a, b) => a + b, 0) / N;
      const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / N;
      const sd = Math.sqrt(variance);
      expect(mean).toBeGreaterThan(10 - 0.2);
      expect(mean).toBeLessThan(10 + 0.2);
      expect(sd).toBeGreaterThan(2 - 0.2);
      expect(sd).toBeLessThan(2 + 0.2);
    });
  });

  describe("logNormal(muLog, sigmaLog)", () => {
    it("is deterministic for a given seed", () => {
      const a = makeRng(77);
      const b = makeRng(77);
      const as = Array.from({ length: 10 }, () => a.logNormal(0, 0.5));
      const bs = Array.from({ length: 10 }, () => b.logNormal(0, 0.5));
      expect(as).toEqual(bs);
    });

    it("all values > 0 and median ≈ 1 over 20000 draws", () => {
      const N = 20000;
      const r = makeRng(54321);
      const samples = Array.from({ length: N }, () => r.logNormal(0, 0.5));
      expect(samples.every((v) => v > 0)).toBe(true);
      const sorted = [...samples].sort((a, b) => a - b);
      const median = sorted[Math.floor(N / 2)];
      expect(median).toBeGreaterThan(1 - 0.15);
      expect(median).toBeLessThan(1 + 0.15);
    });
  });

  describe("gamma(k, theta)", () => {
    it("is deterministic for a given seed", () => {
      const a = makeRng(55);
      const b = makeRng(55);
      const as = Array.from({ length: 10 }, () => a.gamma(3, 2));
      const bs = Array.from({ length: 10 }, () => b.gamma(3, 2));
      expect(as).toEqual(bs);
    });

    it("all values > 0 and mean ≈ k*theta=6 over 20000 draws", () => {
      const N = 20000;
      const r = makeRng(11111);
      const samples = Array.from({ length: N }, () => r.gamma(3, 2));
      expect(samples.every((v) => v > 0)).toBe(true);
      const mean = samples.reduce((a, b) => a + b, 0) / N;
      expect(mean).toBeGreaterThan(6 - 0.5);
      expect(mean).toBeLessThan(6 + 0.5);
    });

    it("works with fractional k (Marsaglia-Tsang path)", () => {
      const N = 20000;
      const r = makeRng(22222);
      // Gamma(2.5, 1) → mean = 2.5
      const samples = Array.from({ length: N }, () => r.gamma(2.5, 1));
      expect(samples.every((v) => v > 0)).toBe(true);
      const mean = samples.reduce((a, b) => a + b, 0) / N;
      expect(mean).toBeGreaterThan(2.5 - 0.3);
      expect(mean).toBeLessThan(2.5 + 0.3);
    });
  });

  describe("pickWeighted(weights)", () => {
    it("is deterministic for a given seed", () => {
      const a = makeRng(33);
      const b = makeRng(33);
      const as = Array.from({ length: 10 }, () => a.pickWeighted([1, 2, 3]));
      const bs = Array.from({ length: 10 }, () => b.pickWeighted([1, 2, 3]));
      expect(as).toEqual(bs);
    });

    it("always returns 1 for weights [0,1,0]", () => {
      const r = makeRng(42);
      for (let i = 0; i < 100; i++) {
        expect(r.pickWeighted([0, 1, 0])).toBe(1);
      }
    });

    it("returns index in [0, weights.length)", () => {
      const r = makeRng(9);
      for (let i = 0; i < 500; i++) {
        const idx = r.pickWeighted([1, 2, 3, 4]);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(4);
      }
    });

    it("pickWeighted([1,1]) is ~50/50 over 20000 draws (±5%)", () => {
      const N = 20000;
      const r = makeRng(66666);
      let count0 = 0;
      for (let i = 0; i < N; i++) {
        if (r.pickWeighted([1, 1]) === 0) count0++;
      }
      const ratio = count0 / N;
      expect(ratio).toBeGreaterThan(0.45);
      expect(ratio).toBeLessThan(0.55);
    });
  });
});
