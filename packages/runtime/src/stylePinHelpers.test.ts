import { describe, it, expect } from "vitest";
import { readPinnedHandle, pinnedSelectConfig, PIN_MIN_EXEMPLARS } from "./stylePin.js";

describe("readPinnedHandle", () => {
  it("returns the pinned handle from a config object", () => {
    expect(readPinnedHandle({ pinnedStyleHandle: "kaia-tham-7bb065343" })).toBe("kaia-tham-7bb065343");
  });
  it("returns null when unset / null / not an object / empty", () => {
    expect(readPinnedHandle(null)).toBeNull();
    expect(readPinnedHandle({})).toBeNull();
    expect(readPinnedHandle({ pinnedStyleHandle: "   " })).toBeNull();
    expect(readPinnedHandle("nope")).toBeNull();
  });
});

describe("pinnedSelectConfig", () => {
  it("floors maxStyleExemplars and zeroes variety for an empty base", () => {
    const cfg = pinnedSelectConfig(null);
    expect(cfg.maxStyleExemplars).toBe(PIN_MIN_EXEMPLARS);
    expect(cfg.varietyTemperature).toBe(0);
  });
  it("keeps a higher operator-set exemplar count", () => {
    const cfg = pinnedSelectConfig({ maxStyleExemplars: 8 });
    expect(cfg.maxStyleExemplars).toBe(8);
  });
  it("bumps a lower operator-set exemplar count up to the floor", () => {
    const cfg = pinnedSelectConfig({ maxStyleExemplars: 1 });
    expect(cfg.maxStyleExemplars).toBe(PIN_MIN_EXEMPLARS);
  });
  it("preserves the pin handle so the round-trip config still validates", () => {
    const cfg = pinnedSelectConfig({ pinnedStyleHandle: "kaia-tham-7bb065343", minPerformancePercentile: 20 });
    expect(cfg.pinnedStyleHandle).toBe("kaia-tham-7bb065343");
    expect(cfg.minPerformancePercentile).toBe(20);
  });
});
