import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { orgsModule } from "./orgs.js";
import { readPgBudgetHolds, type BudgetHoldsPage } from "@noelle/runtime/pg-budget-holds";

vi.mock("@noelle/runtime/pg-budget-holds", () => ({ readPgBudgetHolds: vi.fn() }));
const page: BudgetHoldsPage = {
  period: "week", periodStartedAt: "2026-10-05 00:00:00+00",
  holds: [
    { id: "hold-a", instanceId: "instance", agentRole: "x_intern", worker: "drafter", engine: "bedrock", model: "model",
      bucket: "drafter", admittedAt: "2026-10-05 12:00:00.123456+00", estimatedCents: 8, pot: "common",
      receipt: { id: "receipt-a", status: "timeout", cents: 2, costBasis: "failure_estimate", startedAt: "2026-10-05 12:00:01+00" },
      recordedPeriodCents: 2, heldCapacityCents: 6 },
    { id: "hold-b", instanceId: "instance", agentRole: "x_intern", worker: "drafter", engine: "bedrock", model: "model",
      bucket: "drafter", admittedAt: "2026-10-05 12:00:00.123455+00", estimatedCents: 8, pot: "common",
      receipt: { id: "receipt-b", status: "ok", cents: 0, costBasis: "unknown", startedAt: "2026-10-05 12:00:01+00" },
      recordedPeriodCents: 0, heldCapacityCents: 8 },
    { id: "hold-c", instanceId: "instance", agentRole: "x_intern", worker: "drafter", engine: "codex-cli", model: "gpt-5",
      bucket: "drafter", admittedAt: "2026-10-05 12:00:00.123454+00", estimatedCents: 9, pot: "codex", receipt: null,
      recordedPeriodCents: 0, heldCapacityCents: 9 },
  ], nextCursor: { id: "11111111-1111-1111-1111-111111111111", admittedAt: "2026-10-05 12:00:00.123454+00" },
};

function context(results: unknown[][]) {
  return {
    sql: vi.fn(async () => results.shift() ?? []),
    resolveOrg: vi.fn(async () => ({ orgId: "org", slug: "example", name: "Example" })),
    assertWritable: vi.fn(),
  } as unknown as NoelleContext;
}

describe("budget visibility tools", () => {
  it("registers a read-only bounded holds page rather than a release action", () => {
    const tool = orgsModule.tools.find((t) => t.name === "noelle_budget_holds");
    expect(tool).toMatchObject({ annotations: { readOnlyHint: true },
      inputSchema: { properties: { limit: { maximum: 100 } } } });
    expect(tool?.inputSchema.properties).not.toHaveProperty("release");
  });
  it("labels organization month-cache values as accounting instead of live cap pressure", async () => {
    const ctx = context([[{ plan: "test", llm_backend: "aws" }], [{ budget_cap_cents: 1000 }], [{ bucket: "drafter", cents: "300" }]]);
    const result = await orgsModule.handle("noelle_get_org", {}, ctx);
    expect(result?.content[0]?.text).toContain("cached monthly accounting");
    expect(result?.content[0]?.text).toContain("noelle_budget_holds");
    expect(result?.content[0]?.text).not.toContain("LLM spend this month");
  });
  it("labels status month-cache values and points to unresolved capacity", async () => {
    const ctx = context([[], [], [{ n: 0 }], [{ n: 0 }], [{ bucket: "drafter", cents: "300" }], [{ cents: 1000 }]]);
    const result = await orgsModule.handle("noelle_status", {}, ctx);
    expect(result?.content[0]?.text).toContain("cached monthly accounting");
    expect(result?.content[0]?.text).toContain("noelle_budget_holds");
  });
  it("resolves the org before reading and reports only page-scoped accounting and held estimates", async () => {
    vi.mocked(readPgBudgetHolds).mockResolvedValue(structuredClone(page));
    const ctx = context([]);
    const result = await orgsModule.handle("noelle_budget_holds", { org: "requested", limit: 1000 }, ctx);
    expect(ctx.resolveOrg).toHaveBeenCalledWith("requested");
    expect(readPgBudgetHolds).toHaveBeenCalledWith(ctx.sql, expect.objectContaining({ orgId: "org", limit: 100 }));
    expect(ctx.assertWritable).not.toHaveBeenCalled();
    expect(result?.content[0]?.text).toContain("Page totals");
    expect(result?.content[0]?.text).toContain("| common | 2 | 14 |");
    expect(result?.content[0]?.text).toContain("| codex | 0 | 9 |");
    expect(result?.content[0]?.text).toContain("failure_estimate");
    expect(result?.content[0]?.text).toContain("unknown");
    expect(result?.content[0]?.text).toContain(".123454");
    expect(result?.content[0]?.text).not.toContain("invoice");
  });
  it("rejects a foreign instance without reading its reservations", async () => {
    vi.mocked(readPgBudgetHolds).mockClear();
    const ctx = context([[]]);
    const result = await orgsModule.handle("noelle_budget_holds", { agentInstanceId: "foreign" }, ctx);
    expect(result?.isError).toBe(true);
    expect(readPgBudgetHolds).not.toHaveBeenCalled();
  });
  it("passes a valid scoped instance and the exact microsecond cursor to the shared reader", async () => {
    vi.mocked(readPgBudgetHolds).mockResolvedValue({ ...structuredClone(page), holds: [], nextCursor: null });
    const ctx = context([[{ id: "instance", role: "x_intern" }]]);
    const result = await orgsModule.handle("noelle_budget_holds", {
      role: "x_intern", agentInstanceId: "instance", cursor: page.nextCursor,
    }, ctx);
    expect(result?.isError).not.toBe(true);
    expect(readPgBudgetHolds).toHaveBeenCalledWith(ctx.sql, {
      orgId: "org", instanceId: "instance", limit: 50, cursor: page.nextCursor,
    });
    expect(ctx.assertWritable).not.toHaveBeenCalled();
  });
  it("rejects a role that contradicts the selected instance", async () => {
    vi.mocked(readPgBudgetHolds).mockClear();
    const ctx = context([[{ id: "instance", role: "linkedin_intern" }]]);
    const result = await orgsModule.handle("noelle_budget_holds", { role: "x_intern", agentInstanceId: "instance" }, ctx);
    expect(result?.isError).toBe(true);
    expect(readPgBudgetHolds).not.toHaveBeenCalled();
  });
  it("surfaces unavailable accounting as an error instead of an empty healthy page", async () => {
    vi.mocked(readPgBudgetHolds).mockRejectedValue(new Error("Bounded database operation failed: database"));
    const result = await orgsModule.handle("noelle_budget_holds", {}, context([]));
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("database");
  });
});
