import { describe, expect, it, vi } from "vitest";
import type { NoelleContext } from "../context.js";
import { approvalsModule } from "./approvals.js";

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
  Object.assign(sql, {begin: async (fn: (tx: unknown) => Promise<unknown>) => {
    const fixture=results.shift()?.[0] as Record<string,unknown>|undefined;
    const record=fixture ? {id:"approval",draft_id:"draft",agent_instance_id:"instance",kind:fixture.lead_id===null?"dm":"reply",
      receipt:null,sent_at:null,posted_at:null,...fixture} : undefined;
    const tx=Object.assign((strings:TemplateStringsArray,...values:unknown[])=>{
      const q=strings.join("$"); queries.push({text:q,values});
      if (q.includes("from noelle.agent_instances")) return Promise.resolve([{id:"instance"}]);
      if (q.includes("from noelle.approvals") && q.trimStart().startsWith("select")) return Promise.resolve(record?[record]:[]);
      if (q.includes("update noelle.approvals")) return Promise.resolve(results.shift()??[]);
      return Promise.resolve([]);
    },{json:(value:unknown)=>value,unsafe:(value:string)=>value});
    return fn(tx);
  }});
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

describe("approvals MCP tools", () => {
  it.each(["noelle_list_approvals", "noelle_get_approval"])("%s exposes a DM's own writing check without treating a legacy reply verdict as its review", async (tool) => {
    const rows = [
      { a_id: "dm-new", a_status: "pending", a_lead_id: "lead", kind: "dm", body: "how did you choose the controller?", review_pass: true, review_reasons: ["reply was grounded"], dm_writing_pass: "true", dm_writing_attempts: "1", dm_writing_reasons: [] },
      { a_id: "dm-old", a_status: "pending", a_lead_id: "lead", kind: "dm", body: "old saved DM", review_pass: true, review_reasons: ["inherited reply verdict"] },
    ];
    const { ctx, queries } = makeCtx(tool === "noelle_get_approval" ? [[rows[0]], rows] : [rows]);
    const result = await approvalsModule.handle(tool, { approvalId: "dm-new", platform: "linkedin" }, ctx);
    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("writing check: pass, rewrites: 1");
    expect(body).toContain("wording only");
    expect(body).toContain("writing check: unavailable");
    expect(body).not.toContain("review: pass");
    expect(body).not.toContain("inherited reply verdict");
    for (const query of queries) expect(query.text).toContain("d.payload->'dm_voice_check'");
  });

  it.each(["noelle_list_approvals", "noelle_get_approval"])("%s does not attach an original DM check to edited wording", async (tool) => {
    const row = { a_id: "dm", kind: "dm", body: "edited message", dm_writing_pass: true, dm_writing_stale: true };
    const { ctx, queries } = makeCtx([[row]]);
    const result = await approvalsModule.handle(tool, { approvalId: "dm" }, ctx);
    expect(result?.content[0]?.text).toContain("writing check: unavailable (edited)");
    expect(result?.content[0]?.text).not.toContain("writing check: pass");
    expect(queries[0]?.text).toContain("as dm_writing_stale");
  });

  it("shows a failed DM writing check with its own reasons", async () => {
    const row = { a_id: "dm", kind: "dm", body: "Curious how it went?", dm_writing_pass: false, dm_writing_attempts: "1", dm_writing_reasons: ["question preamble"] };
    const { ctx } = makeCtx([[row]]);
    const result = await approvalsModule.handle("noelle_get_approval", { approvalId: "dm" }, ctx);
    expect(result?.content[0]?.text).toContain("writing check: fail, rewrites: 1");
    expect(result?.content[0]?.text).toContain("question preamble");
  });

  it("filters reads by the requested platform instead of forcing X", async () => {
    const { ctx, queries } = makeCtx([
      [
        {
          a_id: "approval-li",
          a_status: "pending",
          a_created_at: "2026-09-14T00:00:00Z",
          a_lead_id: "lead-li",
          a_draft_id: "draft-li",
          body: "LinkedIn draft body",
          kind: "reply",
          platform: "linkedin",
          l_author_handle: "ada",
          l_score: "0.91",
        },
      ],
    ]);

    const result = await approvalsModule.handle(
      "noelle_list_approvals",
      { platform: "linkedin", status: "pending" },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("linkedin");
    expect(body).toContain("approval-li");
    expect(queries[0]?.values).toContain("linkedin");
    expect(queries[0]?.text).not.toContain("l.platform = 'x'");
  });

  it("shows source and verifier reasoning on approval detail", async () => {
    const row = {
      a_id: "approval-li",
      a_status: "pending",
      a_created_at: "2026-09-14T00:00:00Z",
      a_lead_id: "lead-li",
      a_draft_id: "draft-li",
      body: "Full LinkedIn draft body",
      kind: "reply",
      platform: "linkedin",
      source_url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
      review_pass: false,
      review_reasons: ["too generic", "needs founder detail"],
      review_attempts: "2",
      l_external_id: "123",
      l_author_handle: "ada",
      l_tier: "T1",
      l_label: "technical",
      l_score: "0.91",
      l_priority: true,
      lead_text: "Source post text",
    };
    const { ctx, queries } = makeCtx([[row], [row]]);

    const result = await approvalsModule.handle(
      "noelle_get_approval",
      { approvalId: "approval-li" },
      ctx,
    );

    const body = result?.content[0]?.text ?? "";
    expect(body).toContain("linkedin");
    expect(body).toContain(row.source_url);
    expect(body).toContain("review: fail");
    expect(body).toContain("too generic");
    expect(body).toContain("Full LinkedIn draft body");
    expect(queries[1]?.text).toContain("d.payload->'verifier_meta'->>'pass' as review_pass");
  });

  it("does not restore an approval rejected by automatic review", async () => {
    const { ctx, queries } = makeCtx([
      [{ lead_id: "lead-x", status: "skipped", decided_by: "automatic-review" }],
    ]);

    const result = await approvalsModule.handle(
      "noelle_unskip_draft",
      { approvalId: "approval-auto-rejected" },
      ctx,
    );

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("automatic review");
    expect(queries.some(query=>query.text.includes("update noelle.approvals"))).toBe(false);
  });

  it("restores a manual reply skip without restoring automatic-review siblings", async () => {
    const { ctx, queries } = makeCtx([
      [{ lead_id: "lead-x", status: "skipped", decided_by: "tester" }],
      [{ id: "approval-manual" }],
    ]);

    const result = await approvalsModule.handle(
      "noelle_unskip_draft",
      { approvalId: "approval-manual" },
      ctx,
    );

    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("Restored **1**");
    expect(queries.find(query=>query.text.includes("update noelle.approvals"))?.text).toContain("automatic-review");
  });

  it("still restores a manually skipped DM", async () => {
    const { ctx } = makeCtx([
      [{ lead_id: null, status: "skipped", decided_by: "tester" }],
      [{ id: "approval-dm" }],
    ]);

    const result = await approvalsModule.handle(
      "noelle_unskip_draft",
      { approvalId: "approval-dm" },
      ctx,
    );

    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("Restored **1**");
  });
});

it("does not route LinkedIn approvals through the X send path", async () => {
  const apiFetch = vi.fn();
  const { ctx } = makeCtx([
    [
      {
        lead_id: "lead-li",
        status: "pending",
        kind: "reply",
        draft_id: "draft-li",
        external_id: "123",
        body: "LinkedIn reply",
        platform: "linkedin",
      },
    ],
  ]);
  Object.assign(ctx, { apiConfigured: () => true, apiFetch });

  const result = await approvalsModule.handle(
    "noelle_send_draft",
    { approvalId: "approval-li" },
    ctx,
  );

  expect(result?.isError).toBe(true);
  expect(result?.content[0]?.text).toContain("only queues or sends X drafts");
  expect(apiFetch).not.toHaveBeenCalled();
});

it("describes API send results as accepted, not definitely posted", async () => {
  const apiFetch = vi.fn().mockResolvedValue({ status: "accepted" });
  const { ctx } = makeCtx([
    [
      {
        lead_id: "lead-x",
        status: "pending",
        kind: "reply",
        draft_id: "draft-x",
        external_id: "123",
        body: "X reply",
        platform: "x",
      },
    ],
  ]);
  Object.assign(ctx, { apiConfigured: () => true, apiFetch });

  const result = await approvalsModule.handle(
    "noelle_send_draft",
    { approvalId: "approval-x" },
    ctx,
  );

  const body = result?.content[0]?.text ?? "";
  expect(result?.isError).not.toBe(true);
  expect(body).toContain("accepted");
  expect(body).not.toContain("has been posted");
});
