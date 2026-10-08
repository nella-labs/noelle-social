import { describe, expect, it } from "vitest";
import {
  toCachedSystemBlocks,
  shouldCacheSystem,
  effectiveInputTokens,
  CACHEABLE_SYSTEM_BUCKETS,
  isCacheControlError,
  type CacheableTextBlock,
} from "./promptCache.js";

describe("cache rejection classification", () => {
  it.each([400, 422, undefined])("keeps validation rejection status%s eligible", status => {
    expect(isCacheControlError(Object.assign(new Error("cache_control unsupported"), { status }))).toBe(true);
  });
  it.each([401, 403, 429, 500, 529, null, "400"])("rejects ambiguous failure status%s", status => {
    expect(isCacheControlError(Object.assign(new Error("cache failure"), { status }))).toBe(false);
  });
});

describe("toCachedSystemBlocks", () => {
  it("splits at a mid-string prefixLen into a cached prefix + uncached suffix", () => {
    expect(toCachedSystemBlocks("ABCDEF", 3)).toEqual([
      { type: "text", text: "ABC", cache_control: { type: "ephemeral" } },
      { type: "text", text: "DEF" },
    ]);
  });

  it("emits a single cached block when prefixLen === system.length (no suffix block)", () => {
    const blocks = toCachedSystemBlocks("ABC", 3) as CacheableTextBlock[];
    expect(blocks).toEqual([
      { type: "text", text: "ABC", cache_control: { type: "ephemeral" } },
    ]);
    expect(blocks.length).toBe(1);
  });

  it("fails open to the plain string (===) on every out-of-range / missing prefixLen", () => {
    const s = "hello world";
    expect(toCachedSystemBlocks(s, undefined)).toBe(s);
    expect(toCachedSystemBlocks(s, 0)).toBe(s);
    expect(toCachedSystemBlocks(s, -3)).toBe(s);
    expect(toCachedSystemBlocks(s, s.length + 1)).toBe(s);
    expect(toCachedSystemBlocks("", 5)).toBe("");
  });

  it("is deterministic — two calls with identical args deep-equal", () => {
    expect(toCachedSystemBlocks("ABCDEF", 3)).toEqual(toCachedSystemBlocks("ABCDEF", 3));
  });

  it("round-trips: the blocks concatenate back to the exact original system (no data loss)", () => {
    const s = "hello world";
    for (let n = 1; n <= s.length; n++) {
      const out = toCachedSystemBlocks(s, n) as CacheableTextBlock[];
      expect(out.map((b) => b.text).join("")).toBe(s);
    }
  });
});

describe("shouldCacheSystem", () => {
  it("is OFF when the flag is unset (fail-closed)", () => {
    expect(shouldCacheSystem("drafter", undefined)).toBe(false);
  });

  it("is OFF for any flag value other than the exact string '1'", () => {
    for (const v of ["", "0", "true", "yes", "2", " 1", "1 "]) {
      expect(shouldCacheSystem("drafter", v)).toBe(false);
    }
  });

  it("is ON only for the cacheable drafter buckets when the flag is '1'", () => {
    expect(shouldCacheSystem("drafter", "1")).toBe(true);
    expect(shouldCacheSystem("drafter-codex", "1")).toBe(true);
    expect(shouldCacheSystem("drafter-verify", "1")).toBe(true);
  });

  it("is OFF for non-cacheable buckets even when the flag is '1'", () => {
    for (const b of ["classifier", "profiler-codex", "send", "feeder", "ideation"]) {
      expect(shouldCacheSystem(b, "1")).toBe(false);
    }
  });

  it("caches exactly the three drafter buckets", () => {
    expect([...CACHEABLE_SYSTEM_BUCKETS].sort()).toEqual([
      "drafter",
      "drafter-codex",
      "drafter-verify",
    ]);
  });
});

describe("effectiveInputTokens", () => {
  it("sums plain + read + creation so cached tokens are never under-counted", () => {
    expect(
      effectiveInputTokens({
        input_tokens: 100,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(1000);
  });

  it("handles missing fields (returns exactly input_tokens when no caching)", () => {
    expect(effectiveInputTokens({ input_tokens: 42 })).toBe(42);
    expect(effectiveInputTokens({})).toBe(0);
  });

  it("treats null cache fields as 0 (SDK Usage declares them number | null)", () => {
    expect(
      effectiveInputTokens({
        input_tokens: 42,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toBe(42);
  });
});
