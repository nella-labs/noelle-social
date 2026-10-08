import { describe, expect, it, vi } from "vitest";
import { claimRelationshipDmCandidates, markRelationshipDmResult } from "./relationshipDmDb.js";

describe("relationship DM result bookkeeping", () => {
  it("updates reservation and request counters in one transaction", async () => {
    const tx = vi.fn(async () => [{ request_id: "req-1" }]);
    const sql = Object.assign(vi.fn(async () => {
      throw new Error("markRelationshipDmResult must write through tx");
    }), {
      begin: vi.fn(async (fn) => fn(tx)),
    });

    await markRelationshipDmResult(sql as never, {
      orgId: "org-1",
      reservationId: "res-1",
      status: "queued",
      judgeVerdict: { pass: true, reason: "Specific saved detail" },
    });

    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(tx).toHaveBeenCalledTimes(2);
  });
});

describe("relationship DM candidate selection", () => {
  it("filters targeted saved leads before applying the recent-lead seed limit", async () => {
    const queries: string[] = [];
    const tx = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(Array.from(strings).join("?"));
      if (queries.length === 2)
        return [
          {
            id: "req-1",
            person_id: null,
            recipient_key: "old-target",
            author_id: null,
            remaining: 1,
          },
        ];
      if (queries.length === 3) return [{ remaining: 1 }];
      return [];
    });
    const sql = Object.assign(vi.fn(async () => []), {
      begin: vi.fn(async (fn) => fn(tx)),
    });

    await claimRelationshipDmCandidates(sql as never, {
      orgId: "org-1",
      instanceId: "inst-1",
      platform: "x",
      limit: 1,
      includeRecurring: false,
    });

    const candidateQuery = queries.find((q) => q.includes("recent_leads as materialized"));
    expect(candidateQuery).toBeTruthy();
    const recentLeadsSql = candidateQuery!.slice(
      candidateQuery!.indexOf("recent_leads as materialized"),
      candidateQuery!.indexOf("), raw as materialized"),
    );
    const targetFilter = "lower(regexp_replace(trim(coalesce(l.author_handle, '')), '^@+', '')) = lower(regexp_replace(trim(?), '^@+', ''))";
    expect(recentLeadsSql.indexOf(targetFilter)).toBeGreaterThan(-1);
    expect(recentLeadsSql.indexOf(targetFilter)).toBeLessThan(recentLeadsSql.indexOf("limit"));
    expect(recentLeadsSql).toContain("select 1 from accounts recent_account");
  });
});
