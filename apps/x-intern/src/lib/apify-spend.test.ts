import { describe, expect, it, vi } from "vitest";
import type { SpendRow } from "@noelle/runtime";
import { meterApifyRun } from "./apify-spend.js";

async function meter(extra: Record<string, unknown>) {
  const rows: SpendRow[] = [];
  const warnings: string[] = [];
  await meterApifyRun({
    orgId: "org",
    instanceId: "instance",
    agentRole: "x_intern",
    worker: "profiler",
    actor: "twitter-x-data-tweet-scraper",
    resultCount: 0,
    startedAt: new Date("2026-10-05T10:00:00Z"),
    recorder: {
      async record(row) {
        rows.push(row);
      },
    },
    log: {
      warn: (_fields: unknown, message: string) => {
        warnings.push(message);
      },
    } as never,
    ...extra,
  });
  return { rows, warnings };
}

describe("Apify spend coverage", () => {
  it("warns with bounded attribution when the recorder rejects", async () => {
    const warn = vi.fn();
    await meter({
      actualUsd: 0.37,
      recorder: {
        record: () => Promise.reject(new Error("private provider body and credentials")),
      },
      log: { warn },
    });
    expect(warn).toHaveBeenCalledWith(
      { worker: "profiler", actor: "twitter-x-data-tweet-scraper" },
      "Apify spend could not be recorded",
    );
  });
  it("records a known charge independently of fetched count and total coverage", async () => {
    expect((await meter({ actualUsd: 0.37, resultCountComplete: false })).rows[0]?.cents).toBe(37);
    expect((await meter({ actualUsd: 0, resultCountComplete: false })).rows[0]?.cents).toBe(0);
  });

  it.each([null, undefined, Number.NaN, Infinity, -1])(
    "does not estimate incomplete coverage with usage %s",
    async (actualUsd) => {
      const result = await meter({
        actualUsd,
        resultCount: 100,
        resultCountComplete: false,
        fetchedResultCount: 100,
      });
      expect(result.rows).toEqual([]);
      expect(result.warnings).toEqual([
        "Apify spend unknown: run usage and complete result total are unavailable",
      ]);
    },
  );

  it("estimates an exact reported total rather than the downloaded page length", async () => {
    const result = await meter({
      actualUsd: null,
      resultCount: 1000,
      fetchedResultCount: 2,
      resultCountComplete: true,
    });
    expect(result.rows[0]?.cents).toBe(25);
    expect(result.warnings).toEqual([]);
  });

  it("keeps legacy complete-count clients compatible", async () => {
    expect((await meter({ resultCount: 100 })).rows[0]?.cents).toBe(3);
    expect((await meter({ resultCount: 0 })).rows).toEqual([]);
  });
});
