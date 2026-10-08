import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { friendlyDmsModule } from "./friendly-dms.js";

function ctxWith(rows: Record<string, unknown[] | ((query: string) => unknown[])>) {
  const calls: string[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    calls.push(query);
    const take = (key: string) => typeof rows[key] === "function"
      ? (rows[key] as (query: string) => unknown[])(query)
      : rows[key] ?? [];
    if (query.includes("from noelle.agent_instances")) return take("agent");
    if (query.includes("update noelle.agent_instances")) return take("set");
    if (query.includes("insert into noelle.relationship_dm_requests")) return take("request");
    if (query.includes("from noelle.relationship_dm_requests")) return take("list");
    if (query.includes("from noelle.persons")) return take("person");
    return [];
  });
  return {
    calls,
    ctx: {
      sql,
      resolveOrg: vi.fn(async () => ({ orgId: "org-1", slug: "workspace", name: "Workspace" })),
      assertWritable: vi.fn(),
      operatorId: vi.fn(() => "tester"),
    } as unknown as NoelleContext,
  };
}

describe("friendly DM MCP tools", () => {
  it("requests a durable friendly DM without enabling the recurring lane", async () => {
    const { ctx, calls } = ctxWith({
      agent: [{ id: "inst-x", role: "x_intern", display_name: "Vega" }],
      request: [{ id: "req-1" }],
      list: [{ id: "req-1", platform: "x", status: "pending", outputs: [] }],
    });
    const result = await friendlyDmsModule.handle(
      "noelle_request_friendly_dms",
      { org: "workspace", platform: "x", count: 2 },
      ctx,
    );
    expect(ctx.assertWritable).toHaveBeenCalledWith("request friendly DMs");
    expect(result?.content[0]?.text).toContain("req-1");
    expect(calls.some((q) => q.includes("lane_config"))).toBe(false);
  });

  it("sets only the recurring friendly DM flag", async () => {
    const { ctx, calls } = ctxWith({
      agent: [{ id: "inst-li", role: "linkedin_intern", display_name: "Lyra" }],
      set: [{ enabled: true }],
    });
    const result = await friendlyDmsModule.handle(
      "noelle_set_friendly_dms",
      { org: "workspace", platform: "linkedin", enabled: true },
      ctx,
    );
    expect(result?.content[0]?.text).toContain("enabled");
    expect(calls.some((q) => q.includes("update noelle.agent_instances"))).toBe(true);
    expect(calls.some((q) => q.includes("relationship_dm_requests"))).toBe(false);
  });

  it("lists requested DM drafts with full body and review status", async () => {
    const { ctx } = ctxWith({
      list: (query) => [{
        id: "req-1",
        platform: "x",
        status: "done",
        requested_count: 1,
        queued_count: 1,
        outputs: [{
          reservationId: "res-1",
          draftBody: "hey maya, your deployment checklist line made me laugh",
          reviewStatus: "pending",
          sourceText: query.includes("sourceText") ? "saved post from Maya about deployment checklists" : null,
          sourceUrl: query.includes("sourceUrl") ? "https://x.test/maya/1" : null,
        }],
      }],
    });
    const result = await friendlyDmsModule.handle(
      "noelle_list_friendly_dms",
      { org: "workspace", requestId: "req-1" },
      ctx,
    );
    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("hey maya, your deployment checklist line made me laugh");
    expect(body).toContain('"reviewStatus": "pending"');
    expect(body).toContain("saved post from Maya about deployment checklists");
    expect(body).toContain("https://x.test/maya/1");
  });
});
