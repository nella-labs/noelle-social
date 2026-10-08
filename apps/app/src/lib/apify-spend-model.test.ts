import { describe, expect, it } from "vitest";
import { summarizeApifyProviderSpend, apifyTokenSpend, type UsageSnapshot } from "./apify-spend-model";

const snapshot: UsageSnapshot = {
  credentialId: "retired", label: "retired token", active: false, accountId: "account",
  cycleStartAt: "2026-08-30T00:00:00.000Z", cycleEndAt: "2026-09-29T23:59:59.999Z",
  usageUsd: 2.51, fetchedAt: "2026-09-17T12:00:00.000Z",
  dailyUsage: [{ date: "2026-08-31T00:00:00.000Z", usageUsd: 0.50 }, { date: "2026-09-01T00:00:00.000Z", usageUsd: 2.01 }],
};
const ledger = [
  { credentialId: "retired", label: "retired token", active: false, day: "2026-09-01", cents: 1000 },
  { credentialId: null, label: "Removed token", active: false, day: "2026-09-02", cents: 23 },
];

describe("Apify provider expenses", () => {
  it("uses fetched usage instead of mismatched run costs and retains retired balances", () => {
    expect(apifyTokenSpend([snapshot], ledger)).toEqual(expect.arrayContaining([
      expect.objectContaining({ credentialId: "retired", cents: expect.closeTo(251, 8), source: "provider", active: false }),
      expect.objectContaining({ credentialId: null, cents: 23, source: "unverified" }),
    ]));
  });
  it("uses daily provider usage for calendar ranges, keeping unknown history separate", () => {
    expect(summarizeApifyProviderSpend([snapshot], ledger, "2026-09-01T00:00:00Z")).toMatchObject({
      cents: expect.closeTo(201, 8), unverifiedCents: 23, byDay: [{ day: "2026-09-01", cents: expect.closeTo(201, 8) }],
    });
  });
  it("counts an account once even with multiple tokens, using the latest correction", () => {
    const corrected = { ...snapshot, credentialId: "new-token", usageUsd: 1.75,
      fetchedAt: "2026-09-17T13:00:00Z", dailyUsage: [{ date: "2026-09-01", usageUsd: 1.75 }] };
    expect(summarizeApifyProviderSpend([snapshot, corrected], ledger, null)).toMatchObject({ cents: 175, unverifiedCents: 23 });
    expect(apifyTokenSpend([snapshot, corrected], ledger).filter(r => r.source === "provider").every(r => r.cents === 175)).toBe(true);
  });
  it("preserves earlier cycles and adds fractional-cent daily amounts before rounding", () => {
    const previous = { ...snapshot, cycleStartAt: "2026-07-30T00:00:00Z", cycleEndAt: "2026-08-29T23:59:59Z",
      usageUsd: 0.006, dailyUsage: [{ date: "2026-08-01", usageUsd: 0.003 }, { date: "2026-08-02", usageUsd: 0.003 }] };
    expect(summarizeApifyProviderSpend([previous, snapshot], [], null).cents).toBeCloseTo(251.6);
    expect(apifyTokenSpend([previous, snapshot], [])[0]?.cents).toBeCloseTo(251, 8);
  });
  it("retains zero provider usage and does not substitute higher estimates", () => {
    const zero = { ...snapshot, usageUsd: 0, dailyUsage: [] };
    expect(apifyTokenSpend([zero], ledger)[0]).toMatchObject({ cents: 0, source: "provider" });
    expect(summarizeApifyProviderSpend([zero], ledger, null)).toMatchObject({ cents: 0, unverifiedCents: 23 });
  });
});

describe("provider snapshot observed coverage", () => {
  const early = { ...snapshot, fetchedAt: "2026-09-02T12:00:00.000Z" };
  const charge = (day: string, credentialId: string | null = "retired") => ({
    credentialId, label: "retired token", active: false, day, cents: 250,
  });

  it("keeps later charges unverified within the same billing cycle", () => {
    expect(summarizeApifyProviderSpend([early], [charge("2026-09-17")], null))
      .toMatchObject({ cents: expect.closeTo(251, 8), unverifiedCents: 250 });
    expect(apifyTokenSpend([early], [charge("2026-09-17")]))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "provider", cents: expect.closeTo(251, 8) }),
        expect.objectContaining({ source: "unverified", cents: 250 }),
      ]));
  });

  it("does not assume a day aggregate was observed before a midday fetch", () => {
    expect(summarizeApifyProviderSpend([early], [charge("2026-09-02")], null))
      .toMatchObject({ cents: expect.closeTo(251, 8), unverifiedCents: 250 });
  });

  it("compares complete days in UTC, including offset timestamps", () => {
    const offset = { ...early, fetchedAt: "2026-09-02T01:00:00+02:00" };
    expect(summarizeApifyProviderSpend([offset], [charge("2026-09-01")], null))
      .toMatchObject({ cents: expect.closeTo(251, 8), unverifiedCents: 250 });
  });

  it("preserves a measured zero for earlier completed days", () => {
    const zero = { ...early, usageUsd: 0, dailyUsage: [] };
    expect(summarizeApifyProviderSpend([zero], [charge("2026-09-01")], null))
      .toMatchObject({ cents: 0, unverifiedCents: 0 });
  });

  it("retains removed credentials as unverified and honors the selected range", () => {
    expect(summarizeApifyProviderSpend([early], [charge("2026-09-17", null)], "2026-09-10"))
      .toMatchObject({ cents: 0, unverifiedCents: 250 });
  });

  it("uses a later real reading to cover the earlier completed charge day", () => {
    const current = { ...early, fetchedAt: "2026-09-18T12:00:00.000Z", usageUsd: 2.5,
      dailyUsage: [{ date: "2026-09-17", usageUsd: 2.5 }] };
    expect(summarizeApifyProviderSpend([early, current], [charge("2026-09-17")], null))
      .toMatchObject({ cents: 250, unverifiedCents: 0 });
  });
});
