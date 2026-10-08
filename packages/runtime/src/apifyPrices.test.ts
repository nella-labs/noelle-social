import { describe, expect, it } from "vitest";
import { estimateApifyCents, apifySpendRow, DEFAULT_APIFY_CENTS_PER_1K } from "./apifyPrices.js";

describe("estimateApifyCents", () => {
  it("prices comments at $2/1k (0.2c each), rounded up", () => {
    expect(estimateApifyCents("linkedin-post-comments", 1000)).toBe(200);
    expect(estimateApifyCents("linkedin-post-comments", 40)).toBe(8); // ceil(40*200/1000)=8
    expect(estimateApifyCents("linkedin-post-comments", 1)).toBe(1); // min 1c for a non-empty run
  });

  it("prices posts at $2/1k (console tier)", () => {
    expect(estimateApifyCents("linkedin-profile-posts", 1000)).toBe(200);
    expect(estimateApifyCents("linkedin-post-search", 1000)).toBe(200);
  });

  it("is free for an empty / invalid run", () => {
    expect(estimateApifyCents("linkedin-post-comments", 0)).toBe(0);
    expect(estimateApifyCents("linkedin-post-comments", -5)).toBe(0);
    expect(estimateApifyCents("linkedin-post-comments", NaN)).toBe(0);
  });

  it("falls back to the default rate for an unlisted actor", () => {
    expect(estimateApifyCents("some-new-actor", 1000)).toBe(DEFAULT_APIFY_CENTS_PER_1K);
  });
});

describe("apifySpendRow", () => {
  it("builds an engine=apify llm_calls row with tokens=0 and a worker bucket", () => {
    const startedAt = new Date("2026-06-10T00:00:00.000Z");
    const row = apifySpendRow({
      orgId: "o",
      instanceId: "i",
      agentRole: "linkedin_intern",
      worker: "drafter",
      actor: "linkedin-post-comments",
      resultCount: 40,
      startedAt,
    });
    expect(row.engine).toBe("apify");
    expect(row.model).toBe("apify/linkedin-post-comments");
    expect(row.bucket).toBe("apify-drafter");
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
    expect(row.cents).toBe(8);
    expect(row.status).toBe("ok");
    expect(row.startedAt).toBe(startedAt);
    expect(row.credentialId).toBeNull(); // null when no token id passed
    expect(row.costBasis).toBe("unknown");
  });

  it("stamps credentialId for per-token spend attribution", () => {
    const row = apifySpendRow({
      orgId: "o",
      instanceId: "i",
      agentRole: "linkedin_intern",
      worker: "discovery",
      actor: "linkedin-profile-posts",
      resultCount: 5,
      startedAt: new Date("2026-06-10T00:00:00.000Z"),
      credentialId: "cred-123",
    });
    expect(row.credentialId).toBe("cred-123");
    expect(row.cents).toBe(1); // 5 posts * 0.2c → ceil = 1c
  });

  it("uses Apify's REAL per-run usd (actualUsd) over the estimate when present", () => {
    const base = {
      orgId: "o",
      instanceId: "i",
      agentRole: "linkedin_intern" as const,
      worker: "discovery",
      actor: "linkedin-profile-posts",
      resultCount: 5, // estimate would be 1c
      startedAt: new Date("2026-06-10T00:00:00.000Z"),
    };
    // Apify says this run really cost $0.37 → 37c, ignoring the 5-item estimate.
    expect(apifySpendRow({ ...base, actualUsd: 0.37 }).cents).toBe(37);
    expect(apifySpendRow({ ...base, actualUsd: 0.37 }).costBasis).toBe("provider_reported");
    // Rounds to nearest cent.
    expect(apifySpendRow({ ...base, actualUsd: 0.014 }).cents).toBe(1);
    expect(apifySpendRow({ ...base, actualUsd: 0.004 }).cents).toBe(0);
    // A genuinely-free real run records 0c (unlike the estimate's min-1c floor).
    expect(apifySpendRow({ ...base, actualUsd: 0 }).cents).toBe(0);
    expect(apifySpendRow({ ...base, actualUsd: 0 }).costBasis).toBe("provider_reported");
  });

  it("falls back to the estimate when actualUsd is missing or not a finite number", () => {
    const base = {
      orgId: "o",
      instanceId: "i",
      agentRole: "linkedin_intern" as const,
      worker: "discovery",
      actor: "linkedin-profile-posts",
      resultCount: 1000, // estimate = 200c
      startedAt: new Date("2026-06-10T00:00:00.000Z"),
    };
    expect(apifySpendRow({ ...base, actualUsd: null }).cents).toBe(200);
    expect(apifySpendRow({ ...base, actualUsd: undefined }).cents).toBe(200);
    expect(apifySpendRow({ ...base, actualUsd: NaN }).cents).toBe(200);
    expect(apifySpendRow({ ...base, actualUsd: NaN }).costBasis).toBe("unknown");
    expect(apifySpendRow({ ...base, actualUsd: -1 }).cents).toBe(200); // negative is nonsense → estimate
    expect(apifySpendRow(base).cents).toBe(200);
  });
});
