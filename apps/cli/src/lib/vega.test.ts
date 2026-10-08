import { beforeEach, describe, expect, it, vi } from "vitest";

// Captures every tagged-template query vegaEnable issues: the SQL fragments and
// the interpolated values, in order. That is what lets these tests assert on the
// STATEMENT the DB would actually run, not on a hand-rolled stand-in for it.
interface Captured {
  sql: string;
  values: unknown[];
}
const captured: Captured[] = [];
let returnedRow: Record<string, unknown> | undefined;

vi.mock("postgres", () => ({
  default: () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push({ sql: strings.join("?"), values });
      return Promise.resolve(returnedRow ? [returnedRow] : []);
    };
    sql.end = () => Promise.resolve();
    return sql;
  },
}));

const { vegaEnable } = await import("./vega.js");

const ROW = {
  status: "active",
  budget_cap_cents: 10000,
  discovery_enabled: true,
  classifier_enabled: true,
  drafter_enabled: true,
  send_enabled: false,
  auto_send_enabled: false,
};

beforeEach(() => {
  captured.length = 0;
  returnedRow = { ...ROW };
});

/** The one UPDATE vegaEnable issues. */
function theUpdate(): Captured {
  const u = captured.find((c) => c.sql.includes("update noelle.agent_instances"));
  if (!u) throw new Error("vegaEnable issued no UPDATE");
  return u;
}

/**
 * The interpolation order is [preserveFlag, capForCoalesce, capForElse, orgSlug].
 * Asserting POSITIONALLY matters: `toContain(false)` would also be satisfied by
 * any unrelated false in the bind list, so it could pass on a statement that
 * never bound the flag at all.
 */
function boundFlag(u: Captured): unknown {
  return u.values[0];
}

describe("vegaEnable budget_cap_cents stamping", () => {
  it("preserveExistingCap keeps a cap the operator already set (coalesce), never lowering it", async () => {
    await vegaEnable({
      dbUrl: "postgres://x",
      orgSlug: "workspace",
      budgetCapCents: 2500,
      preserveExistingCap: true,
      log: () => {},
    });
    const u = theUpdate();
    // The guard must be a COALESCE over the existing column — an UPDATE that
    // simply assigns the config value is what silently reverted the dashboard.
    expect(u.sql).toContain("coalesce(ai.budget_cap_cents");
    // ...and the branch has to actually be selected at runtime.
    expect(boundFlag(u)).toBe(true);
  });

  it("without the flag the cap is stamped unconditionally (explicit `vega enable`)", async () => {
    await vegaEnable({
      dbUrl: "postgres://x",
      orgSlug: "workspace",
      budgetCapCents: 7500,
      log: () => {},
    });
    const u = theUpdate();
    // The operator asked for this cap on the command line, so it must win even
    // when a different one is already stored.
    expect(boundFlag(u)).toBe(false);
    // Both the coalesce arm and the else arm carry the requested cap.
    expect(u.values.slice(1, 3)).toEqual([7500, 7500]);
  });

  it("reports the cap the ROW carries, not the one requested", async () => {
    // The regression this guards: under preserveExistingCap the requested and
    // stored caps differ, and logging the request announced a reset to $25 that
    // never happened — which is exactly how the bug stayed invisible.
    returnedRow = { ...ROW, budget_cap_cents: 10000 };
    const lines: string[] = [];
    await vegaEnable({
      dbUrl: "postgres://x",
      orgSlug: "workspace",
      budgetCapCents: 2500,
      preserveExistingCap: true,
      log: (m) => lines.push(m),
    });
    expect(lines.join("\n")).toContain("$100.00");
    expect(lines.join("\n")).not.toContain("$25.00");
  });

  it("still seeds the cap when the instance has none", async () => {
    // What coalesce(NULL, 2500) leaves behind, so a fresh install is still
    // capped and the budget pre-check can never be skipped.
    returnedRow = { ...ROW, budget_cap_cents: 2500 };
    const lines: string[] = [];
    await vegaEnable({
      dbUrl: "postgres://x",
      orgSlug: "workspace",
      budgetCapCents: 2500,
      preserveExistingCap: true,
      log: (m) => lines.push(m),
    });
    expect(theUpdate().values).toContain(2500);
    expect(lines.join("\n")).toContain("$25.00");
  });

  it("keeps forcing send + auto-send OFF on explicit enable", async () => {
    await vegaEnable({
      dbUrl: "postgres://x",
      orgSlug: "workspace",
      budgetCapCents: 2500,
      log: () => {},
    });
    const u = theUpdate();
    expect(u.sql).toContain("send_enabled = case");
    expect(u.sql).toContain("auto_send_enabled = case");
    expect(u.values.slice(3, 9)).toEqual([false, false, false, false, false, false]);
  });

  it("preserves a stopped pipeline and every worker flag during automatic bring-up", async () => {
    returnedRow = {
      ...ROW,
      status: "paused",
      discovery_enabled: false,
      classifier_enabled: false,
      drafter_enabled: false,
      send_enabled: true,
      auto_send_enabled: true,
    };
    await vegaEnable({
      dbUrl: "postgres://x",
      orgSlug: "workspace",
      budgetCapCents: 2500,
      preserveExistingCap: true,
      preservePipelineState: true,
      log: () => {},
    });
    const u = theUpdate();
    expect(u.sql).toContain("then ai.status");
    expect(u.sql).toContain("then ai.discovery_enabled");
    expect(u.sql).toContain("then ai.classifier_enabled");
    expect(u.sql).toContain("then ai.drafter_enabled");
    expect(u.sql).toContain("then ai.send_enabled");
    expect(u.sql).toContain("then ai.auto_send_enabled");
    expect(u.values.slice(3, 9)).toEqual([true, true, true, true, true, true]);
  });

  it("reports the preserved pipeline state instead of saying Vega is active", async () => {
    returnedRow = {
      ...ROW,
      status: "paused",
      discovery_enabled: false,
      classifier_enabled: false,
      drafter_enabled: false,
    };
    const lines: string[] = [];
    await vegaEnable({
      dbUrl: "postgres://x",
      orgSlug: "workspace",
      budgetCapCents: 2500,
      preserveExistingCap: true,
      preservePipelineState: true,
      log: (message) => lines.push(message),
    });
    expect(lines.join("\n")).toContain("Vega paused");
    expect(lines.join("\n")).not.toContain("Vega active");
  });
});
