import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { postgresPendingReplyReconcileStore } from "./pending-reply-reconcile-store.js";

function fakeSql(results: unknown[][]) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("set local")) return Promise.resolve([]);
    if (query.includes("for update")) return Promise.resolve([{ id: "locked" }]);
    queries.push(query);
    params.push(values);
    return Promise.resolve(results.shift() ?? []);
  }) as unknown as Sql;
  Object.assign(sql, { begin: (run: (tx: Sql) => unknown) => run(sql), json: (value: unknown) => value,
    unsafe: (fragment: string) => fragment });
  return { sql, queries, params };
}

describe("Postgres pending reply reconciliation store", () => {
  it("selects only tenant-owned, unsent, pending reply approvals", async () => {
    const { sql, queries, params } = fakeSql([[
      {
        approval_id: "a1",
        approval_created_at: "2026-09-20T18:00:00.000Z",
        draft_id: "d1",
        lead_id: "l1",
        external_id: "target-1",
        org_id: "org-1",
        agent_instance_id: "instance-1",
        platform: "linkedin",
        draft_payload: { kind: "reply" },
        lead_payload: { original_post_url: "https://linkedin.test/post" },
      },
    ]]);

    const rows = await postgresPendingReplyReconcileStore(sql).list("org-1");

    expect(rows[0]).toMatchObject({
      approvalId: "a1",
      draftId: "d1",
      leadId: "l1",
      orgId: "org-1",
      agentInstanceId: "instance-1",
    });
    expect(queries[0]).toContain("a.org_id = ?");
    expect(queries[0]).toContain("d.org_id = a.org_id");
    expect(queries[0]).toContain("l.org_id = a.org_id");
    expect(queries[0]).toContain("a.status = 'pending'");
    expect(queries[0]).toContain("coalesce(d.payload->>'kind', 'reply') = 'reply'");
    expect(queries[0]).toContain("d.sent_at is null");
    expect(params[0]).toContain("org-1");
  });

  it("atomically skips the same tenant's still-pending reply and stamps the decision", async () => {
    const { sql, queries, params } = fakeSql([[{ id: "a1" }]]);
    const store = postgresPendingReplyReconcileStore(sql);
    const saved = await store.skip({
      approvalId: "a1",
      approvalCreatedAt: "2026-09-20T18:00:00.000Z",
      draftId: "d1",
      leadId: "l1",
      leadExternalId: "target-1",
      orgId: "org-1",
      agentInstanceId: "instance-1",
      platform: "x",
      draftPayload: { kind: "reply" },
      leadPayload: {},
    }, "automatic-review-failed", "2026-09-20T20:00:00.000Z");

    expect(saved).toBe(true);
    expect(queries[0]).toContain("set status = 'skipped'");
    expect(queries[0]).toContain("decided_by = 'automatic-review'");
    expect(queries[0]).toContain("a.status = 'pending'");
    expect(queries[0]).toContain("a.org_id = ?");
    expect(queries[0]).toContain("a.agent_instance_id = ?");
    expect(queries[0]).toContain("coalesce(d.payload->>'kind', 'reply') = 'reply'");
    expect(params[0]).toEqual(expect.arrayContaining([
      "2026-09-20T20:00:00.000Z",
      "automatic-review-failed",
      "a1",
      "org-1",
      "instance-1",
    ]));
  });
});
