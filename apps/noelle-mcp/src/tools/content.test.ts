import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { contentModule } from "./content.js";

function context() {
  const updates: unknown[][] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$");
    if (query.startsWith("set local ")) return [];
    if (query.includes("from noelle.post_ideas where id"))
      return [{ id: "idea", agent_instance_id: "instance", platform: "x" }];
    if (query.includes("from noelle.agent_instances")) return [{ id: "instance" }];
    if (query.includes("from noelle.post_ideas i"))
      return [
        {
          id: "idea",
          org_id: "org",
          agent_instance_id: "instance",
          platform: "x",
          status: "drafted",
        },
      ];
    if (query.includes("from noelle.content_schedule_slots")) return [];
    if (query.includes("update noelle.post_ideas")) {
      updates.push(values);
      return [];
    }
    throw new Error("Unexpected fixture query");
  });
  Object.assign(sql, { begin: async (write: (tx: unknown) => Promise<unknown>) => write(sql) });
  return {
    updates,
    ctx: {
      sql,
      assertWritable: vi.fn(),
      resolveOrg: async () => ({ orgId: "org", slug: "one", name: "One" }),
    } as unknown as NoelleContext,
  };
}

describe("suggested post day", () => {
  it("acknowledges a stored suggestion without claiming a publication was scheduled", async () => {
    const { ctx, updates } = context();
    const result = await contentModule.handle(
      "noelle_schedule_post",
      { ideaId: "idea", day: "2026-10-09" },
      ctx,
    );
    expect(result?.isError).not.toBe(true);
    expect(updates[0]?.[0]).toBe("2026-10-09");
    expect(result?.content[0]?.text).toContain("suggested publish day");
    expect(result?.content[0]?.text).toContain("No publication slot was created");
    expect(result?.content[0]?.text).not.toContain("Scheduled idea");
  });

  it("continues to acknowledge clearing a suggestion", async () => {
    const { ctx, updates } = context();
    const result = await contentModule.handle("noelle_schedule_post", { ideaId: "idea" }, ctx);
    expect(result?.isError).not.toBe(true);
    expect(updates[0]?.[0]).toBeNull();
    expect(result?.content[0]?.text).toContain("Cleared the suggested day");
  });
});
