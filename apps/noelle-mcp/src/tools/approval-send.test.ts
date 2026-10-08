import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { queueApprovedReply } from "./approval-send.js";

function context(rows: unknown[][]) {
  const queries: Array<{ query: string; values: unknown[] }> = [];
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ query: parts.join("?"), values });
    return rows.shift() ?? [];
  }), { json: (value: unknown) => value, begin: (fn: (tx: unknown) => unknown) => fn(sql) });
  return { ctx: { sql, operatorId: () => "operator" } as unknown as NoelleContext, queries };
}

describe("explicit approval for the local actuator", () => {
  it("releases the selected reply without routing it to the stopped send worker", async () => {
    const { ctx, queries } = context([[{ id: "approval" }], [], []]);
    await queueApprovedReply(ctx, { orgId: "org", approvalId: "approval", draftId: "draft", leadId: "lead", body: "Exact edit" });
    expect(queries[0]!.query).toContain("auto_send_target_at = null");
    expect(queries[1]!.values).toContainEqual({ human_send_approved: true, edited_body: "Exact edit", edited: true });
    expect(queries.every((q) => !q.query.includes("agent_instances"))).toBe(true);
  });

  it("refuses to release an approval actioned since it was read", async () => {
    const { ctx, queries } = context([[]]);
    await expect(queueApprovedReply(ctx, { orgId: "org", approvalId: "approval", draftId: "draft", leadId: "lead" })).rejects.toThrow("no longer pending");
    expect(queries).toHaveLength(1);
  });
});
