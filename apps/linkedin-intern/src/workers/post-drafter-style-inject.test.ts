import { describe, it, expect, vi } from "vitest";
import { runPostDrafterTick } from "./post-drafter-tick.js";
import { buildPostDrafterSystem, buildPostStyleBlock } from "../lib/post-drafter.js";
import type { PostStyleSelection } from "../lib/post-drafter.js";
import type { ApprovedIdea } from "../lib/post-ideas-db.js";
import type { PostDraftContext } from "../lib/post-drafter.js";
import type { ActiveInstance } from "../lib/activation.js";
import type { StyleExemplarRow, UltraProfileRow } from "../lib/account-feeder-db.js";

// Unit tests for F8 — post-style injection into the post-drafter. All tests are
// DB-free and network-free. CI typechecks under noUncheckedIndexedAccess so every
// array index is guarded.

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

it("renders unknown post-exemplar counts beside measured zero", () => {
  const selection = { exemplars: [{ body: "Saved source text", likeCount: 0, commentCount: null }], styleNotes: "" } as unknown as PostStyleSelection;
  const block = buildPostStyleBlock(selection);
  expect(block).toContain("0 likes, unknown comments");
  expect(block).not.toContain("high-performing");
});

const instance = {
  id: "i1",
  org_id: "o1",
  model_overrides: null,
  objective: null,
  account_feeder_config: null,
} as unknown as ActiveInstance;

const idea: ApprovedIdea = {
  id: "idea-1",
  orgId: "o1",
  agentInstanceId: "i1",
  platform: "linkedin",
  targetPlatforms: ["linkedin"],
  pendingPlatforms: null,
  generationRequestId: null,
  generationReviewRequired: false,
  hook: "Stop hiring seniors",
  thesis: "juniors compound",
  angle: "contrarian",
  pillar: "hiring",
  inspirationRefs: [],
};

const ctx: PostDraftContext = {
  hook: idea.hook,
  thesis: idea.thesis,
  angle: idea.angle,
  pillar: idea.pillar,
  voiceAnchors: ["blunt lowercase"],
  inspirationExcerpts: [],
  hookPatterns: [],
  standingRules: [],
  chatGuidance: [],
};

function makeRunner(body = "I hire juniors. They compound fast.") {
  return {
    draft: vi.fn().mockResolvedValue({
      text: JSON.stringify({ body }),
      engine: "bedrock",
      model: "opus",
    }),
  };
}

// A minimal StyleExemplarRow factory.
function styleRow(
  over: Partial<StyleExemplarRow> & { external_id: string },
): StyleExemplarRow {
  return {
    external_id: over.external_id,
    body: over.body ?? `style body ${over.external_id}`,
    like_count: over.like_count ?? 100,
    comment_count: over.comment_count ?? 20,
    account_handle: over.account_handle ?? "guru",
    posted_at: over.posted_at ?? null,
  };
}

// ── buildPostStyleBlock unit tests ─────────────────────────────────────────────

describe("buildPostStyleBlock — gate-off returns empty string", () => {
  it("returns '' for null selection", () => {
    expect(buildPostStyleBlock(null)).toBe("");
  });

  it("returns '' for undefined selection", () => {
    expect(buildPostStyleBlock(undefined)).toBe("");
  });

  it("returns '' for a selection with zero exemplars", () => {
    expect(buildPostStyleBlock({ exemplars: [], styleNotes: "" })).toBe("");
  });
});

describe("buildPostStyleBlock — on with exemplars", () => {
  const sel: PostStyleSelection = {
    exemplars: [
      { body: "Hook. Real point. No fluff.", likeCount: 300, commentCount: 40 },
      { body: "Second example post here.", likeCount: 150, commentCount: 10 },
    ],
    styleNotes: "punchy and direct\nHooks: starts with a bold claim",
  };

  it("includes the STYLE TO EMULATE header", () => {
    const block = buildPostStyleBlock(sel);
    expect(block).toContain("STYLE TO EMULATE");
  });

  it("includes the do-NOT-borrow-content instruction", () => {
    const block = buildPostStyleBlock(sel);
    expect(block).toContain("Do NOT borrow their content");
  });

  it("reinforces the no-fabrication hard ban", () => {
    const block = buildPostStyleBlock(sel);
    expect(block).toContain("NEVER invent a story");
  });

  it("includes the styleNotes prose", () => {
    const block = buildPostStyleBlock(sel);
    expect(block).toContain("punchy and direct");
    expect(block).toContain("starts with a bold claim");
  });

  it("includes each exemplar body (truncated to 800 chars)", () => {
    const block = buildPostStyleBlock(sel);
    expect(block).toContain("Hook. Real point. No fluff.");
    expect(block).toContain("Second example post here.");
  });

  it("includes the engagement performance label", () => {
    const block = buildPostStyleBlock(sel);
    expect(block).toContain("300 likes");
    expect(block).toContain("40 comments");
  });
});

// ── buildPostDrafterSystem — gate-off is byte-identical ───────────────────────

describe("buildPostDrafterSystem — NOELLE_POST_STYLE gate-off is byte-identical", () => {
  it("system with no styleSelection equals system with null styleSelection", () => {
    // Calling without the styleSelection arg vs with undefined/null must produce
    // the IDENTICAL string — the gate-off path must not change the prompt at all.
    const base = buildPostDrafterSystem("linkedin", "grow the product", "Brand", undefined);
    const withNull = buildPostDrafterSystem("linkedin", "grow the product", "Brand", undefined, null);
    const withUndef = buildPostDrafterSystem("linkedin", "grow the product", "Brand", undefined, undefined);
    expect(withNull).toBe(base);
    expect(withUndef).toBe(base);
  });

  it("system with an empty exemplars selection equals the no-selection system", () => {
    const base = buildPostDrafterSystem("linkedin", null, null);
    const emptyPool = buildPostDrafterSystem("linkedin", null, null, undefined, { exemplars: [], styleNotes: "" });
    expect(emptyPool).toBe(base);
  });

  it("system WITH style injection differs from the no-style system", () => {
    const base = buildPostDrafterSystem("linkedin", null, null);
    const withStyle = buildPostDrafterSystem("linkedin", null, null, undefined, {
      exemplars: [{ body: "A great hook. Short. Punchy.", likeCount: 500, commentCount: 50 }],
      styleNotes: "direct voice",
    });
    // Must be DIFFERENT (the STYLE block is present).
    expect(withStyle).not.toBe(base);
    expect(withStyle).toContain("STYLE TO EMULATE");
  });
});

// ── runPostDrafterTick — gate-off with no stylePool produces identical behavior ─

describe("runPostDrafterTick — gate OFF → no style, behavior unchanged", () => {
  it("drafts without a STYLE block when postStyleEnabled is absent (default)", async () => {
    const runner = makeRunner();
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });

    const n = await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 0,
      sink,
      release: vi.fn(),
      // No postStyleEnabled, no stylePool → gate-off
    });

    expect(n).toBe(1);
    // System prompt passed to runner must NOT contain the STYLE block.
    const systemArg: string = runner.draft.mock.calls[0]![0].system;
    expect(systemArg).not.toContain("STYLE TO EMULATE");
  });

  it("drafts without a STYLE block when postStyleEnabled=false", async () => {
    const runner = makeRunner();
