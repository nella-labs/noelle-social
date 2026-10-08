import { describe, expect, it } from "vitest";
import { NoelleError, type NoelleContext, type OrgRef } from "../context.js";
import { withToolAnnotations } from "../tool-annotations.js";
import { getIdeationRequest } from "./content-ideation.js";
import { contentModule } from "./content.js";

const org: OrgRef = { orgId: "org-a", slug: "workspace", name: "Workspace" };
const request = {
  id: "request-a", agent_instance_id: "agent-a", batch_id: "batch-a", idea_id: null,
  status: "done", count: 2, topics: ["shipping"], target_platforms: ["linkedin"],
  error_message: null, created_at: "2026-09-14T00:00:00Z", finished_at: "2026-09-14T00:01:00Z",
};

function context(row: typeof request | null, ideas: unknown[] = []) {
  const queries: Array<{ query: string; values: unknown[] }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(" ");
    queries.push({ query, values });
    if (query.includes("from noelle.ideation_requests")) return row ? [row] : [];
    if (query.includes("from noelle.post_ideas")) return ideas;
    throw new Error(`Unexpected SQL: ${query}`);
  }) as NoelleContext["sql"];
  return { ctx: { sql } as NoelleContext, queries };
}

describe("ideation request results", () => {
  it("returns full worker ideas and sources scoped to the request's organization, owner and batch", async () => {
    const ideas = [{
      id: "idea-a", hook: "A saved source idea", thesis: "The full premise.",
      inspiration_refs: [{ kind: "replied_post", leadId: "lead-a", url: "https://x.com/a/status/1" }],
      source_engine: "codex-cli", model: "test-model",
    }];
    const { ctx, queries } = context(request, ideas);
    const result = JSON.parse((await getIdeationRequest(ctx, org, request.id)).content[0]!.text);
    expect(result.status).toBe("done");
    expect(result.ideas).toEqual(ideas);
    expect(queries[0]!.values).toEqual([request.id, org.orgId]);
    expect(queries[1]!.query).toContain("agent_instance_id =");
    expect(queries[1]!.query).toContain("batch_id =");
    expect(queries[1]!.values.slice(0, 2)).toEqual([org.orgId, request.agent_instance_id]);
    expect(queries[1]!.values).toContain(request.batch_id);
    expect(result.next).toContain("noelle_generate_post");
  });

  it("does not present a pending request as completed or suggest substitute ideas", async () => {
    const { ctx } = context({ ...request, status: "pending", finished_at: null } as unknown as typeof request);
    const result = JSON.parse((await getIdeationRequest(ctx, org, request.id)).content[0]!.text);
    expect(result.status).toBe("pending");
    expect(result.ideas).toEqual([]);
    expect(result.next).toContain("Poll this same request ID");
    expect(result.next).toContain("do not queue a duplicate");
  });

  it("returns the actual worker error without turning partial ideas into success", async () => {
    const { ctx } = context({ ...request, status: "error", error_message: "model unavailable" } as unknown as typeof request);
    const result = JSON.parse((await getIdeationRequest(ctx, org, request.id)).content[0]!.text);
    expect(result.status).toBe("error");
    expect(result.error).toBe("model unavailable");
    expect(result.next).toContain("Do not substitute chat-written ideas");
  });

  it("refuses a missing or out-of-org request before reading ideas", async () => {
    const { ctx, queries } = context(null);
    await expect(getIdeationRequest(ctx, org, "other-request")).rejects.toThrow(NoelleError);
    expect(queries).toHaveLength(1);
  });

  it("marks request polling read-only for chat clients", () => {
    const tool = contentModule.tools.find((item) => item.name === "noelle_get_ideation_request");
    expect(tool).toBeDefined();
    expect(withToolAnnotations(tool!).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});
