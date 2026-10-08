import { describe, it, expect, vi } from "vitest";
import {
  assertWithinCap,
  BudgetExceededError,
  type CapAdapters,
  type CapsSnapshot,
  type SpendSnapshot,
} from "./budgetBucket.js";

function makeAdapters(
  spend: SpendSnapshot,
  caps: CapsSnapshot,
): CapAdapters & { fetchSpend: ReturnType<typeof vi.fn>; fetchCaps: ReturnType<typeof vi.fn> } {
  return {
    fetchSpend: vi.fn().mockResolvedValue(spend),
    fetchCaps: vi.fn().mockResolvedValue(caps),
  };
}

const BASE_ARGS = {
  bucket: "drafter",
  orgId: "org-1",
  instanceId: "inst-1",
  estimatedCents: 100,
};

describe("assertWithinCap", () => {
  it("resolves without throwing when all layers are within cap", async () => {
    const adapters = makeAdapters(
      { bucket: 1000, org: 2000, instance: 500 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    await expect(assertWithinCap(BASE_ARGS, adapters)).resolves.toBeUndefined();
  });

  it("throws BudgetExceededError with layer='bucket' when bucket is exceeded", async () => {
    const adapters = makeAdapters(
      { bucket: 4950, org: 0, instance: 0 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    const err = await assertWithinCap(BASE_ARGS, adapters).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.layer).toBe("bucket");
    expect(err.spentCents).toBe(4950);
    expect(err.capCents).toBe(5000);
    expect(err.estimatedCents).toBe(100);
  });

  it("throws with layer='org' when bucket passes but org is exceeded", async () => {
    const adapters = makeAdapters(
      { bucket: 0, org: 9950, instance: 0 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    const err = await assertWithinCap(BASE_ARGS, adapters).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.layer).toBe("org");
    expect(err.spentCents).toBe(9950);
    expect(err.capCents).toBe(10000);
  });

  it("throws with layer='instance' when bucket and org pass but instance is exceeded", async () => {
    const adapters = makeAdapters(
      { bucket: 0, org: 0, instance: 1950 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    const err = await assertWithinCap(BASE_ARGS, adapters).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.layer).toBe("instance");
    expect(err.spentCents).toBe(1950);
    expect(err.capCents).toBe(2000);
  });

  it("returns layer='bucket' (first in check order) when multiple layers would fail", async () => {
    const adapters = makeAdapters(
      { bucket: 4950, org: 9950, instance: 1950 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    const err = await assertWithinCap(BASE_ARGS, adapters).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.layer).toBe("bucket");
  });

  it("allows spend + estimated === cap (exactly at cap is ok)", async () => {
    // spent=4900, estimated=100 → 5000 === 5000 → should NOT throw
    const adapters = makeAdapters(
      { bucket: 4900, org: 0, instance: 0 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    await expect(assertWithinCap(BASE_ARGS, adapters)).resolves.toBeUndefined();
  });

  it("throws when spend + estimated === cap + 1 (one cent over)", async () => {
    // spent=4900, estimated=101 → 5001 > 5000 → should throw
    const args = { ...BASE_ARGS, estimatedCents: 101 };
    const adapters = makeAdapters(
      { bucket: 4900, org: 0, instance: 0 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    const err = await assertWithinCap(args, adapters).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err.layer).toBe("bucket");
  });

  it("calls fetchSpend and fetchCaps exactly once each", async () => {
    const adapters = makeAdapters(
      { bucket: 0, org: 0, instance: 0 },
      { bucket: 5000, org: 10000, instance: 2000 },
    );
    await assertWithinCap(BASE_ARGS, adapters);
    expect(adapters.fetchSpend).toHaveBeenCalledTimes(1);
    expect(adapters.fetchCaps).toHaveBeenCalledTimes(1);
  });

  it("does NOT trip when LLM spend is at cap and Apify would otherwise push it over", async () => {
    // The cap is fed by fetchSpend, which the pg adapters compute with an
    // `engine <> 'apify'` filter — so the snapshot already excludes Apify. Model
    // that: the org has $11.00 LLM (1100c) under a $11.00 cap (1100c). Apify
    // spend exists in the ledger but is invisible to this snapshot. A 0-cent
    // estimate (next call already counted) must still pass — Apify can't push it
    // over because it was never summed in. (If Apify counted, org would be 1600c
    // > 1100c and this would throw.)
    const adapters = makeAdapters(
      { bucket: 1100, org: 1100, instance: 1100 },
      { bucket: 1100, org: 1100, instance: 1100 },
    );
    await expect(
      assertWithinCap({ ...BASE_ARGS, estimatedCents: 0 }, adapters),
    ).resolves.toBeUndefined();
  });
});
