import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { leadsModule } from "./leads.js";

type Query = { text: string; values: unknown[] };

function makeCtx(results: unknown[][]) {
  const queries: Query[] = [];
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join("$"), values });
      return Promise.resolve(results.shift() ?? []);
    }),
    { json: (value: unknown) => value },
  );
  return {
    queries,
    ctx: {
      sql,
      resolveOrg: vi.fn().mockResolvedValue({ orgId: "org-1", slug: "workspace", name: "Workspace" }),
      operatorId: () => "tester",
      assertWritable: vi.fn(),
      apiConfigured: () => false,
    } as unknown as NoelleContext,
  };
}

const lead = {
  id: "lead-li",
  platform: "linkedin",
  status: "drafted",
  author_handle: "ada",
  payload: {
    text: "source post",
    url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
  },
};

describe("reply request MCP tools", () => {
  it.each(["drafted", "drafting"])("reuses an older completed key while the latest request is %s", async (status) => {
    const current = {
      ...lead, status,
      payload: { ...lead.payload, reply_requested: status === "drafting", reply_request: { request_key: "new-key" } },
    };
    const { ctx, queries } = makeCtx([[current], [{
      a_id: "old-approval", a_status: "pending", kind: "reply", body: "Original reviewed reply",
      review_pass: true, review_reasons: [], review_attempts: "1",
    }]]);
    const result = await leadsModule.handle("noelle_request_reply", {
      leadId: lead.id, requestKey: "old-key", instructions: "must not replace the old request",
    }, ctx);
    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("Original reviewed reply");
    expect(result?.content[0]?.text).toContain("completed");
    expect(queries.some((query) => query.text.includes("update noelle.leads"))).toBe(false);
    const lookup = queries.find((query) => query.text.includes("from noelle.approvals"));
    expect(lookup?.values).toEqual([lead.id, "org-1", "old-key"]);
  });

  it("marks an existing LinkedIn lead for a human-review reply without touching lane flags", async () => {
    const { ctx, queries } = makeCtx([
      [lead],
      [{ ...lead, status: "classified", payload: {} }],
      [{ ...lead, status: "classified", payload: { reply_request: { request_key: "manual-1" } } }],
      [],
    ]);

    const result = await leadsModule.handle(
      "noelle_request_reply",
      {
        leadId: "lead-li",
        platform: "linkedin",
        requestKey: "manual-1",
        instructions: "ask about the database constraint",
      },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    const update = queries.find((q) => q.text.includes("update noelle.leads"));
    const marker = update?.values.find((v) => typeof v === "object" && v !== null) as
      | Record<string, unknown>
      | undefined;

    expect(body).toContain("queued_for_drafting");
    expect(body).toContain("lead-li:manual-1");
    expect(marker?.reply_requested).toBe(true);
    expect(update?.text).toContain("coalesce(payload->>'reply_requested', 'false') <> 'true'");
    expect(update?.text).toContain("returning id, platform, status, author_handle, payload");
    expect(marker?.reply_request).toMatchObject({
      request_key: "manual-1",
      instructions: "ask about the database constraint",
      force_human_review: true,
      requested_by: "tester",
    });
    expect(queries.map((q) => q.text).join("\n")).not.toContain("agent_instances");
  });

  it("reads completed request drafts with full body and verifier status", async () => {
    const { ctx } = makeCtx([
      [{ ...lead, payload: { ...lead.payload, reply_request: { request_key: "manual-1" } } }],
      [
        {
          a_id: "approval-li",
          a_status: "pending",
          kind: "reply",
          body: "Full requested reply body",
          review_pass: true,
          review_reasons: [],
          review_attempts: "1",
        },
      ],
    ]);

    const result = await leadsModule.handle(
      "noelle_get_reply_request_status",
      { leadId: "lead-li", requestKey: "manual-1" },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("completed");
    expect(body).toContain("Full requested reply body");
    expect(body).toContain("review: pass");
    expect(body).toContain("source_post: source post");
    expect(body).toContain("source_url: https://www.linkedin.com/feed/update/urn:li:activity:123/");
  });

  it("does not treat untagged reply drafts as completed requested replies", async () => {
    const { ctx, queries } = makeCtx([
      [{ ...lead, payload: { ...lead.payload, reply_request: { request_key: "manual-1" } } }],
      [],
    ]);

    const result = await leadsModule.handle(
      "noelle_get_reply_request_status",
      { leadId: "lead-li", requestKey: "manual-1" },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    const draftQuery = queries.find((q) => q.text.includes("from noelle.approvals"));
    expect(body).toContain("queued_for_drafting");
    expect(draftQuery?.text).toContain("d.payload->>'reply_request_key' = $");
    expect(draftQuery?.text).not.toContain("reply_request_key' is null");
    expect(draftQuery?.text).not.toContain("requested_at");
  });

  it("reads an older request key without showing the latest request metadata", async () => {
    const { ctx } = makeCtx([
      [{
        ...lead,
        payload: { ...lead.payload, reply_request: { request_key: "latest-key", instructions: "latest guidance" } },
      }],
      [{
        a_id: "approval-old",
        a_status: "pending",
        kind: "reply",
        body: "Old requested reply body",
        review_pass: true,
        review_reasons: [],
        review_attempts: "0",
      }],
    ]);

    const result = await leadsModule.handle(
      "noelle_get_reply_request_status",
      { leadId: "lead-li", requestKey: "old-key" },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("lead-li:old-key");
    expect(body).toContain("**request_key:** old-key");
    expect(body).toContain("Old requested reply body");
    expect(body).not.toContain("latest guidance");
  });

  it("reports requested drafts without a passing verifier as review work, not completed", async () => {
    const { ctx } = makeCtx([
      [{ ...lead, payload: { ...lead.payload, reply_request: { request_key: "manual-1" } } }],
      [{
        a_id: "approval-li",
        a_status: "pending",
        kind: "reply",
        body: "Draft awaiting review result",
        review_pass: null,
        review_reasons: null,
        review_attempts: null,
      }],
    ]);

    const result = await leadsModule.handle(
      "noelle_get_reply_request_status",
      { leadId: "lead-li", requestKey: "manual-1" },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("review_pending");
    expect(body).toContain("review: pending");
    expect(body).not.toContain("completed");
  });

  it("reports failed verifier drafts as needs_review, not completed", async () => {
    const { ctx } = makeCtx([
      [{ ...lead, payload: { ...lead.payload, reply_request: { request_key: "manual-1" } } }],
      [{
        a_id: "approval-li",
        a_status: "pending",
        kind: "reply",
        body: "Draft with a failed verifier result",
        review_pass: false,
        review_reasons: ["too generic"],
        review_attempts: "2",
      }],
    ]);

    const result = await leadsModule.handle(
      "noelle_get_reply_request_status",
      { leadId: "lead-li", requestKey: "manual-1" },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("needs_review");
    expect(body).toContain("review: fail");
    expect(body).not.toContain("completed");
  });

  it("refuses to overwrite a different in-flight reply request on the same lead", async () => {
    const { ctx, queries } = makeCtx([
      [
        {
          ...lead,
          status: "classified",
          payload: {
            ...lead.payload,
            reply_requested: true,
            reply_request: { request_key: "old-key" },
          },
        },
      ],
    ]);

    const result = await leadsModule.handle(
      "noelle_request_reply",
      { leadId: "lead-li", requestKey: "new-key" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("already has an in-flight reply request");
    expect(queries.some((q) => q.text.includes("update noelle.leads"))).toBe(false);
  });

  it("detects a competing in-flight request when the guarded update loses the race", async () => {
    const { ctx, queries } = makeCtx([
      [{ ...lead, status: "classified", payload: { ...lead.payload } }],
      [],
      [{
        ...lead,
        status: "classified",
        payload: { reply_requested: true, reply_request: { request_key: "other-key" } },
      }],
    ]);

    const result = await leadsModule.handle(
      "noelle_request_reply",
      { leadId: "lead-li", requestKey: "new-key" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("other-key");
    expect(queries.find((q) => q.text.includes("update noelle.leads"))?.text).toContain(
      "coalesce(payload->>'reply_requested', 'false') <> 'true'",
    );
  });

  it("rejects request keys over the outbound 200 character contract", async () => {
    const { ctx } = makeCtx([]);

    const result = await leadsModule.handle(
      "noelle_request_reply",
      { leadId: "lead-li", requestKey: "x".repeat(201) },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("requestKey must be 200 characters or fewer");
  });

  it("rejects waitSeconds outside the 0..45 second tool contract", async () => {
    const { ctx } = makeCtx([[lead]]);

    const result = await leadsModule.handle(
      "noelle_request_reply",
      { leadId: "lead-li", waitSeconds: 60 },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("waitSeconds must be between 0 and 45");
  });

  it("advertises local idempotent draft-queue annotations on the new tools", () => {
    const request = leadsModule.tools.find((tool) => tool.name === "noelle_request_reply");
    const status = leadsModule.tools.find(
      (tool) => tool.name === "noelle_get_reply_request_status",
    );
    expect(request?.annotations).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(status?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(status?.inputSchema.properties).toMatchObject({
      waitSeconds: expect.objectContaining({ type: "number" }),
    });
  });
  it("refuses a new key while the worker owns the lead", async () => {
    const { ctx, queries } = makeCtx([[{
      ...lead, status: "drafting", payload: { ...lead.payload, reply_request: { request_key: "owned" } },
    }]]);
    const result = await leadsModule.handle("noelle_request_reply", { leadId: lead.id, requestKey: "replacement" }, ctx);
    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("already being processed");
    expect(queries.some((q) => q.text.includes("update noelle.leads"))).toBe(false);
  });

  it("does not report a newer failure for an unknown older request", async () => {
    const { ctx } = makeCtx([[{
      ...lead, status: "errored", payload: { ...lead.payload, reply_request: { request_key: "latest" } },
    }], []]);
    const result = await leadsModule.handle("noelle_get_reply_request_status", { leadId: lead.id, requestKey: "old" }, ctx);
    expect(result?.content[0]?.text).toContain("request_not_found");
  });

});
