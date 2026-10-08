import { describe, expect, it, vi } from "vitest";
import { nextContentPostTargetPlatforms } from "@noelle/runtime";
import { NoelleError, type NoelleContext, type OrgRef } from "../context.js";
import {
  generatePostWithProgress,
  getPostWithFullDrafts,
  hasEveryExpectedPlatform,
  postWaitSeconds,
  renderGenerationResult,
  requestedPostPlatforms,
  type GenerationRequest,
  type PostDraftRow,
  type PostIdeaRow,
} from "./content-posts.js";

const idea: PostIdeaRow = {
  id: "idea-1",
  org_id: "org-1",
  agent_instance_id: "agent-1",
  platform: "linkedin",
  target_platforms: ["linkedin", "x"],
  pending_platforms: null,
  generation_request_id: null,
  generation_review_required: false,
  hook: "Hook",
  thesis: null,
  angle: null,
  pillar: null,
  status: "approved",
  source_engine: null,
  model: null,
  suggested_day: null,
  batch_id: null,
  created_at: "2026-09-14T00:00:00Z",
  updated_at: "2026-09-14T00:00:00Z",
};

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    idea,
    requestId: "11111111-1111-1111-1111-111111111111",
    requestStatus: "queued",
    requestedAt: "2026-09-14T00:01:00Z",
    requestedPlatforms: null,
    expectedPlatforms: ["linkedin", "x"],
    reviewRequired: true,
    source: "mcp",
    waitSeconds: 0,
    ...overrides,
  };
}

function draft(platform: string, overrides: Partial<PostDraftRow> = {}): PostDraftRow {
  return {
    id: `new-${platform}`,
    platform,
    status: "draft",
    stage: "draft",
    body: `Fresh ${platform} body`,
    final_body: null,
    char_count: 20,
    hook: "Hook",
    source_engine: "codex",
    model: "gpt-test",
    quality_score: null,
    quality_passed: null,
    verifier_meta: null,
    generation_request_id: "11111111-1111-1111-1111-111111111111",
    created_at: "2026-09-14T00:02:00Z",
    updated_at: "2026-09-14T00:02:00Z",
    ...overrides,
  };
}

describe("post generation args", () => {
  it("caps waitSeconds at the tool budget", () => {
    expect(postWaitSeconds({ waitSeconds: 99 })).toBe(45);
    expect(postWaitSeconds({ waitSeconds: "3.9" })).toBe(3);
    expect(() => postWaitSeconds({ waitSeconds: -1 })).toThrow(NoelleError);
  });

  it("dedupes and validates requested platforms", () => {
    expect(requestedPostPlatforms({ platforms: ["linkedin", "x", "linkedin"] })).toEqual([
      "linkedin",
      "x",
    ]);
    expect(requestedPostPlatforms({})).toBeNull();
    expect(() => requestedPostPlatforms({ platforms: ["threads"] })).toThrow(NoelleError);
  });

  it("preserves targets unless an explicit platform subset adds a revision target", () => {
    expect(nextContentPostTargetPlatforms({ target_platforms: ["linkedin"] }, null)).toEqual(["linkedin"]);
    expect(nextContentPostTargetPlatforms({ target_platforms: ["linkedin"] }, ["x", "linkedin"])).toEqual([
      "linkedin",
      "x",
    ]);
  });
});

describe("post generation tool flow", () => {
  it("creates a durable reviewed request and returns the worker-stamped result", async () => {
    let requestId = "";
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join(" ");
      if (q.startsWith("set local ")) return [];
      if (q.includes("from noelle.agent_instances")) return [{ id: idea.agent_instance_id }];
      if (q.includes("from noelle.content_schedule_slots") || q.includes("from noelle.ideation_requests")) return [];
      if (q.includes("from noelle.post_ideas where id")) return [idea];
      if (q.includes("from noelle.post_ideas i")) return [{ ...idea, status: "drafted" }];
      if (q.includes("status in ('queued','drafting','review_pending')")) return [];
      if (q.includes("insert into noelle.post_generation_requests")) {
        requestId = String(values[0]);
        return [{ id: requestId, org_id: idea.org_id, agent_instance_id: idea.agent_instance_id,
          idea_id: idea.id, platforms: ["linkedin"], guidance: "make it specific", review_required: true,
          source: "mcp", status: "queued", created_at: "2026-09-14T00:01:00Z",
          updated_at: "2026-09-14T00:01:00Z", completed_at: null }];
      }
      if (q.includes("update noelle.post_ideas")) return [{ status: "approved" }];
      if (q.includes("insert into noelle.drafter_notes")) return [];
      if (q.includes("from noelle.post_generation_requests") && q.includes("where id =")) {
        return [{
          id: requestId, org_id: idea.org_id, agent_instance_id: idea.agent_instance_id,
          idea_id: idea.id, platforms: ["linkedin"], guidance: "make it specific",
          review_required: true, source: "mcp", status: "drafted",
          created_at: "2026-09-14T00:01:00Z", updated_at: "2026-09-14T00:02:00Z", completed_at: "2026-09-14T00:02:00Z",
        }];
      }
      if (q.includes("from noelle.post_drafts") && q.includes("generation_request_id")) {
        return [
          draft("linkedin", {
            generation_request_id: requestId,
            quality_score: "0.93",
            quality_passed: true,
            verifier_meta: { pass: true, reasons: ["specific"] },
          }),
        ];
      }
      throw new Error(`unexpected SQL: ${q}`);
    }) as never as NoelleContext["sql"];
    (sql as unknown as { begin: (fn: (tx: never) => unknown) => Promise<unknown> }).begin = async (
      fn,
    ) => fn(sql as never);
    const ctx = { sql } as NoelleContext;
    const org: OrgRef = { orgId: "org-1", slug: "workspace", name: "Workspace" };

    const out = await generatePostWithProgress(
      { platforms: ["linkedin"], waitSeconds: 0 },
      ctx,
      org,
      "idea-1",
      "make it specific",
    );

    const body = out.content[0]!.text;
    expect(body).toContain("Post generation drafted");
    expect(body).toContain(`request_id:** ${requestId}`);
    expect(body).toContain("reviewer_result:** passed, score 0.93");
    expect(body).toContain("review_required:** true");
    expect(body).toContain("source:** mcp");
  });
});

describe("post generation progress", () => {
  it("requires a fresh draft for every expected platform before claiming drafted", () => {
    expect(hasEveryExpectedPlatform([draft("linkedin")], ["linkedin", "x"])).toBe(false);
    expect(hasEveryExpectedPlatform([draft("linkedin"), draft("x")], ["linkedin", "x"])).toBe(true);
  });

  it("renders queued when no new worker drafts have been correlated", () => {
    const out = renderGenerationResult(request(), [], false).content[0]!.text;
    expect(out).toContain("Post generation queued");
    expect(out).toContain("not claiming the draft is done");
    expect(out).toContain("request_id:** 11111111-1111-1111-1111-111111111111");
    expect(out).toContain("waiting_for:** linkedin, x");
  });

  it("does not infer completion from platform presence while the request is still drafting", () => {
    const out = renderGenerationResult(
      request({ requestStatus: "drafting" }),
      [
        draft("linkedin", { quality_score: "0.91", quality_passed: true, verifier_meta: { pass: true } }),
        draft("x", { quality_score: "0.92", quality_passed: true, verifier_meta: { pass: true } }),
      ],
      false,
    ).content[0]!.text;
    expect(out).toContain("Post generation drafting");
    expect(out).toContain("not claiming the draft is done");
  });

  it("renders every worker-created variant for the request", () => {
    const out = renderGenerationResult(
      request({ requestStatus: "needs_review" }),
      [
        draft("x", { id: "x-3", body: "third x", quality_score: "0.91", quality_passed: true, verifier_meta: { pass: true } }),
        draft("x", { id: "x-2", body: "second x", quality_score: "0.41", quality_passed: false, verifier_meta: { pass: false } }),
        draft("x", { id: "x-1", body: "first x", quality_score: "0.88", quality_passed: true, verifier_meta: { pass: true } }),
        draft("linkedin", { body: "linkedin", quality_score: "0.93", quality_passed: true, verifier_meta: { pass: true } }),
      ],
      false,
    ).content[0]!.text;
    expect(out).toContain("Post generation needs_review");
    expect(out).toContain("request_drafts_found:** 4");
    expect(out).toContain("third x");
    expect(out).toContain("second x");
    expect(out).toContain("first x");
  });

  it("renders failed verifier output as needs_review for a completed request", () => {
    const out = renderGenerationResult(
      request({ requestStatus: "needs_review", requestedPlatforms: ["linkedin"], expectedPlatforms: ["linkedin"] }),
      [
        draft("linkedin", {
          quality_score: "0.41",
          quality_passed: false,
          verifier_meta: { pass: false, reasons: ["too generic"] },
        }),
      ],
      false,
    ).content[0]!.text;
    expect(out).toContain("Post generation needs_review");
    expect(out).toContain("reviewer_result:** failed, score 0.41");
    expect(out).toContain("too generic");
  });

  it("renders real worker draft bodies and verifier metadata when present", () => {
    const out = renderGenerationResult(
      request({ requestStatus: "drafted", requestedPlatforms: ["linkedin"], expectedPlatforms: ["linkedin"] }),
      [
        draft("linkedin", {
          quality_score: "0.91",
          quality_passed: true,
          verifier_meta: { pass: true },
        }),
      ],
      false,
    ).content[0]!.text;
    expect(out).toContain("Post generation drafted");
    expect(out).toContain("reviewer_result:** passed, score 0.91");
    expect(out).toContain("Fresh linkedin body");
    expect(out).toContain('"pass": true');
  });
});

describe("post generation evidence", () => {
  it.each(["drafted", "needs_review"])(
    "does not claim a finished review from an empty %s journal",
    (requestStatus) => {
      const output = renderGenerationResult(request({ requestStatus }), [], false).content[0]!.text;
      expect(output).toContain("Post generation drafts_missing");
      expect(output).toContain(`journal_status:** ${requestStatus}`);
      expect(output).not.toContain("passed the existing reviewer/verifier");
      expect(output).not.toContain("failed at least one platform");
    },
  );

  it("keeps a missing platform visible after the journal claims completion", () => {
    const output = renderGenerationResult(
      request({ requestStatus: "drafted" }),
      [draft("linkedin", { quality_passed: true, verifier_meta: { pass: true } })],
      false,
    ).content[0]!.text;
    expect(output).toContain("Post generation drafts_missing");
    expect(output).toContain("waiting_for:** x");
    expect(output).not.toContain("passed the existing reviewer/verifier");
  });

  it("does not treat missing verdicts as a passed review", () => {
    const output = renderGenerationResult(
      request({ requestStatus: "drafted" }),
      [draft("linkedin"), draft("x")],
      false,
    ).content[0]!.text;
    expect(output).toContain("Post generation review_pending");
    expect(output).not.toContain("passed the existing reviewer/verifier");
  });

  it.each([
    ["missing metadata pass", true, {}, "review_pending"],
    ["nonboolean metadata pass", true, { pass: "true" }, "review_pending"],
    ["array metadata", true, [], "review_pending"],
    ["string metadata", true, "passed", "review_pending"],
    ["missing quality verdict", null, { pass: true }, "review_pending"],
    ["failed metadata", true, { pass: false }, "needs_review"],
    ["failed quality verdict", false, { pass: true }, "needs_review"],
    ["failed quality with incomplete metadata", false, {}, "needs_review"],
  ])("does not claim a passing review with %s", (_label, qualityPassed, meta, status) => {
    const output = renderGenerationResult(
      request({ requestStatus: "drafted", expectedPlatforms: ["x"] }),
      [draft("x", { quality_passed: qualityPassed as boolean | null, verifier_meta: meta })],
      false,
    ).content[0]!.text;
    expect(output).toContain(`Post generation ${status}`);
    expect(output).not.toContain("passed the existing reviewer/verifier");
    expect(output).not.toContain("reviewer_result:** passed");
    if (status === "needs_review") expect(output).toContain("failed review result");
  });

  it("shows a real failed verdict even if the journal says drafted", () => {
    const output = renderGenerationResult(
      request({ requestStatus: "drafted" }),
      [
        draft("linkedin", { quality_passed: true, verifier_meta: { pass: true } }),
        draft("x", { quality_passed: false, verifier_meta: { pass: false } }),
      ],
      false,
    ).content[0]!.text;
    expect(output).toContain("Post generation needs_review");
    expect(output).not.toContain("passed the existing reviewer/verifier");
  });

  it("keeps optional review distinct from a measured passing verdict", () => {
    const output = renderGenerationResult(
      request({ requestStatus: "drafted", reviewRequired: false }),
      [draft("linkedin"), draft("x")],
      false,
    ).content[0]!.text;
    expect(output).toContain("Post generation drafted");
    expect(output).toContain("Automatic review was not required");
    expect(output).not.toContain("passed the existing reviewer/verifier");
  });

  it("keeps polling an empty terminal journal until actual drafts arrive", async () => {
    vi.useFakeTimers();
    let draftReads = 0;
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join("$");
      if (query.includes("from noelle.post_ideas")) return [idea];
      if (query.includes("from noelle.post_generation_requests"))
        return [
          {
            id: request().requestId,
            org_id: idea.org_id,
            idea_id: idea.id,
            agent_instance_id: idea.agent_instance_id,
            platforms: ["linkedin", "x"],
            review_required: true,
            source: "mcp",
            status: "drafted",
            created_at: idea.created_at,
          },
        ];
      if (query.includes("from noelle.post_drafts"))
        return ++draftReads === 1
          ? []
          : [
              draft("linkedin", { quality_passed: true, verifier_meta: { pass: true } }),
              draft("x", { quality_passed: true, verifier_meta: { pass: true } }),
            ];
      throw new Error("Unexpected fixture query");
    });
    try {
      const pending = getPostWithFullDrafts(
        { sql } as unknown as NoelleContext,
        { orgId: idea.org_id, slug: "one", name: "One" },
        idea.id,
        { requestId: request().requestId, waitSeconds: 1 },
      );
      await vi.runAllTimersAsync();
      const output = (await pending).content[0]!.text;
      expect(draftReads).toBe(2);
      expect(output).toContain("Fresh linkedin body");
      expect(output).toContain("Post generation drafted");
    } finally {
      vi.useRealTimers();
    }
  });
});
