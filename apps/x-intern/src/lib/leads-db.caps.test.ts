import { describe, expect, it, vi } from "vitest";
import {
  countLeadBacklogForInstance,
  countPendingApprovalsForInstance,
} from "./leads-db.js";

/**
 * The cap helpers are thin postgres-js wrappers — the value of testing
 * them comes from pinning the shape of the query they execute (so a
 * future refactor that drops the status filter or forgets to scope by
 * agent_instance_id fails loudly) and confirming the row → number
 * conversion handles the postgres-js `numeric` -> string quirk.
 *
 * We don't have a DB-backed test harness for `noelle.*` in this repo
 * (workers integration-test via mocks), so a tagged-template fake is
 * the right level: it exercises the SQL string the helper builds and
 * the unpack path.
 */
function makeFakeSql(returns: Array<Record<string, unknown>>) {
  const calls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
  const fn = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(returns);
  });
  return { sql: fn as unknown as never, calls };
}

describe("countPendingApprovalsForInstance", () => {
  it("scopes the count to (agent_instance_id, status='pending')", async () => {
    const { sql, calls } = makeFakeSql([{ count: "42" }]);
    const n = await countPendingApprovalsForInstance(sql, "inst_1");
    expect(n).toBe(42);
    const joined = calls[0]!.strings.join("?");
    expect(joined).toContain("noelle.approvals");
    expect(joined).toContain("agent_instance_id");
    // The status is a SQL literal in the template, not an interpolated
    // value — pin both the column and the literal text so a refactor
    // that turns it into a parameter doesn't silently change semantics.
    expect(joined).toContain("status = 'pending'");
    expect(calls[0]!.values).toContain("inst_1");
  });

  it("returns 0 when the query yields no rows (no-instance edge)", async () => {
    const { sql } = makeFakeSql([]);
    const n = await countPendingApprovalsForInstance(sql, "missing");
    expect(n).toBe(0);
  });
});

describe("countLeadBacklogForInstance", () => {
  it("scopes the count to (agent_instance_id, status in new/classifying/classified/drafting)", async () => {
    const { sql, calls } = makeFakeSql([{ count: "243" }]);
    const n = await countLeadBacklogForInstance(sql, "inst_2");
    expect(n).toBe(243);
    const joined = calls[0]!.strings.join("?");
    expect(joined).toContain("noelle.leads");
    expect(joined).toContain("agent_instance_id");
    // All four "in-flight" statuses must be in the SQL — leaving any out
    // would let discovery keep firing on a phantom-empty backlog.
    expect(joined).toContain("'new'");
    expect(joined).toContain("'classifying'");
    expect(joined).toContain("'classified'");
    expect(joined).toContain("'drafting'");
    expect(calls[0]!.values).toContain("inst_2");
  });
});
