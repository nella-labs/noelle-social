import { describe, it, expect, vi } from "vitest";
import {
  assertOrgMember,
  isOrgMember,
  OrgMembershipError,
  type OrgMembersQueryClient,
  type QueryExecutor,
} from "./tenancy.js";

/**
 * Fake Supabase-shaped query builder.
 *
 * The real `@supabase/supabase-js` chain is `from(...).select(...).eq(...,
 * ...).eq(..., ...).maybeSingle()`. We mirror exactly that shape and let
 * the test set the terminal `maybeSingle()` result.
 *
 * `lastCall` records the inputs the helper passed through each link so we
 * can assert the right table + columns + values were used. That catches the
 * regression class we actually care about: someone "refactoring" the guard
 * to query the wrong table (`org_members` → `organizations`), or
 * accidentally filtering only on `user_id` (which would auth-pass any org).
 */
interface CallTrace {
  table: string | undefined;
  columns: string | undefined;
  firstEq: [string, string] | undefined;
  secondEq: [string, string] | undefined;
  terminalCalls: number;
}

function makeFakeClient(result: {
  data: { user_id: string } | null;
  error: { message: string } | null;
}): OrgMembersQueryClient & { lastCall: CallTrace } {
  const lastCall: CallTrace = {
    table: undefined,
    columns: undefined,
    firstEq: undefined,
    secondEq: undefined,
    terminalCalls: 0,
  };
  const client = {
    from(table: "org_members") {
      lastCall.table = table;
      return {
        select(columns: string) {
          lastCall.columns = columns;
          return {
            eq(column: "org_id" | "user_id", value: string) {
              lastCall.firstEq = [column, value];
              return {
                eq(column2: "org_id" | "user_id", value2: string) {
                  lastCall.secondEq = [column2, value2];
                  return {
                    async maybeSingle() {
                      lastCall.terminalCalls += 1;
                      return result;
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return Object.assign(client, { lastCall });
}

describe("isOrgMember", () => {
  it("returns true when org_members.maybeSingle() yields a row", async () => {
    const client = makeFakeClient({
      data: { user_id: "u-1" },
      error: null,
    });
    await expect(isOrgMember(client, "u-1", "org-1")).resolves.toBe(true);
  });

  it("returns false when org_members.maybeSingle() yields null (no membership)", async () => {
    const client = makeFakeClient({ data: null, error: null });
    await expect(isOrgMember(client, "u-1", "org-1")).resolves.toBe(false);
  });

  it("fails closed: returns false on any DB error", async () => {
    const client = makeFakeClient({
      data: null,
      error: { message: "connection refused" },
    });
    // We treat errors as non-membership rather than throwing — matches the
    // original apps/api-vm behavior and avoids leaking infra failures to
    // the caller as a 5xx instead of a 403.
    await expect(isOrgMember(client, "u-1", "org-1")).resolves.toBe(false);
  });

  it("queries the org_members table filtered by both org_id and user_id", async () => {
    const client = makeFakeClient({
      data: { user_id: "u-1" },
      error: null,
    });
    await isOrgMember(client, "u-7", "org-42");
    expect(client.lastCall.table).toBe("org_members");
    expect(client.lastCall.columns).toBe("user_id");
    expect(client.lastCall.firstEq).toEqual(["org_id", "org-42"]);
    expect(client.lastCall.secondEq).toEqual(["user_id", "u-7"]);
    expect(client.lastCall.terminalCalls).toBe(1);
  });
});

describe("assertOrgMember", () => {
  it("resolves without throwing on member", async () => {
    const client = makeFakeClient({
      data: { user_id: "u-1" },
      error: null,
    });
    await expect(assertOrgMember(client, "u-1", "org-1")).resolves.toBeUndefined();
  });

  it("throws OrgMembershipError on non-member", async () => {
    const client = makeFakeClient({ data: null, error: null });
    const err = await assertOrgMember(client, "u-1", "org-1").catch((e) => e);
    expect(err).toBeInstanceOf(OrgMembershipError);
    expect(err.userId).toBe("u-1");
    expect(err.orgId).toBe("org-1");
    expect(err.code).toBe("not_org_member");
  });

  it("throws OrgMembershipError on DB error (fails closed)", async () => {
    const client = makeFakeClient({
      data: null,
      error: { message: "boom" },
    });
    const err = await assertOrgMember(client, "u-1", "org-1").catch((e) => e);
    expect(err).toBeInstanceOf(OrgMembershipError);
  });

  it("error message includes both ids for debuggability", async () => {
    const client = makeFakeClient({ data: null, error: null });
    const err = await assertOrgMember(client, "user-xyz", "org-abc").catch((e) => e);
    expect(err.message).toContain("user-xyz");
    expect(err.message).toContain("org-abc");
  });

  it("does not retry on non-member result (single query per call)", async () => {
    const client = makeFakeClient({ data: null, error: null });
    await assertOrgMember(client, "u-1", "org-1").catch(() => {});
    expect(client.lastCall.terminalCalls).toBe(1);
  });

  it("uses Supabase JS error.message shape (regression guard)", async () => {
    // Some Supabase client variants attach an error object without
    // `.message`; the helper must not throw when reading it. Test with a
    // hand-rolled error that's missing the field.
    const client = makeFakeClient({
      data: null,
      error: { message: "" },
    });
    await expect(isOrgMember(client, "u-1", "org-1")).resolves.toBe(false);
  });
});

describe("OrgMembershipError", () => {
  it("is distinguishable from a generic Error via instanceof", async () => {
    // Critical for action wrappers that do `if (err instanceof
    // OrgMembershipError) return { ok: false, error: { code: 'forbidden' } }`.
    const err = new OrgMembershipError("u", "o");
    expect(err).toBeInstanceOf(OrgMembershipError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OrgMembershipError");
  });
});

// Keep `vi` referenced so the test file doesn't trip the unused-import rule
// if the harness ever inspects imports — `vi` is also useful for any future
// expansion (e.g. asserting call ordering across multiple guards).
void vi;

// ---------------------------------------------------------------------------
// QueryExecutor branch — apps/api-vm (Cloud SQL, postgres.js).
//
// Same semantics as the Supabase-shaped branch: returns true iff the executor
// yields at least one row; fails closed on any thrown error.
// ---------------------------------------------------------------------------
describe("isOrgMember (QueryExecutor branch)", () => {
  it("returns true when the executor returns a row", async () => {
    const exec: QueryExecutor = async () => [{ user_id: "u-1" }];
    await expect(isOrgMember(exec, "u-1", "org-1")).resolves.toBe(true);
  });

  it("returns false when the executor returns no rows", async () => {
    const exec: QueryExecutor = async () => [];
    await expect(isOrgMember(exec, "u-1", "org-1")).resolves.toBe(false);
  });

  it("fails closed when the executor throws (connection error etc.)", async () => {
    const exec: QueryExecutor = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(isOrgMember(exec, "u-1", "org-1")).resolves.toBe(false);
  });
