import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { claimApprovedIdeas, getInspirationPostTexts } from "./post-ideas-db.js";

function makeSql() {
  const calls: string[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    calls.push(strings.join(" "));
    return [];
  }) as unknown as Sql & { mock: { calls: unknown[][] } };
  return { sql, calls };
}

describe("claimApprovedIdeas", () => {
  it("adds the active generation-request filter in request-only mode", async () => {
    const { sql, calls } = makeSql();

    await claimApprovedIdeas(sql, { agentInstanceId: "inst-1", batch: 5, requestOnly: true });

    expect(calls[0]).toContain("noelle.post_generation_requests");
    expect(calls[0]).toContain("generation_request_id");
    expect(calls[0]).toContain("status in ('queued', 'drafting', 'review_pending')");
  });
});

describe("getInspirationPostTexts", () => {
  it("keeps the original author and operator reply distinct in the drafter's evidence", async () => {
    const sql = vi.fn().mockResolvedValue([
      { text: "Author's post", reply: "Operator's actual reply" },
      { text: "Legacy watchlist post", reply: null },
      { text: null, reply: "No original post" },
    ]) as unknown as Sql;
    expect(await getInspirationPostTexts(sql, {
      agentInstanceId: "agent-a", externalIds: ["lead-a", "external-b"],
    })).toEqual([
      "Original source post:\nAuthor's post\n\nOperator's sent reply:\nOperator's actual reply",
      "Legacy watchlist post",
    ]);
  });
});
