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
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });

    await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 0,
      sink,
      release: vi.fn(),
      postStyleEnabled: false,
      stylePool: [styleRow({ external_id: "a" })],
    });

    const systemArg: string = runner.draft.mock.calls[0]![0].system;
    expect(systemArg).not.toContain("STYLE TO EMULATE");
  });

  it("drafts without a STYLE block when postStyleEnabled=true but pool is empty", async () => {
    const runner = makeRunner();
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });

    await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 0,
      sink,
      release: vi.fn(),
      postStyleEnabled: true,
      stylePool: [], // empty pool → selectStyleExemplars returns null → no block
    });

    const systemArg: string = runner.draft.mock.calls[0]![0].system;
    expect(systemArg).not.toContain("STYLE TO EMULATE");
  });
});

// ── runPostDrafterTick — gate ON with a real pool injects STYLE block ─────────

describe("runPostDrafterTick — gate ON + kind='post' corpus → STYLE block present", () => {
  const pool: StyleExemplarRow[] = [
    styleRow({ external_id: "p1", body: "Juniors beat seniors in 12 months.", like_count: 500, comment_count: 60 }),
    styleRow({ external_id: "p2", body: "Hiring slow is hiring wrong.", like_count: 300, comment_count: 30 }),
  ];

  const profiles: UltraProfileRow[] = [
    {
      account_handle: "guru",
      voice_summary: "punchy and concrete",
      tone: "direct",
      structure_notes: "one claim per paragraph",
      hook_patterns: ["bold contrarian claim"],
      signature_phrases: ["here's the thing"],
      top_topics: ["hiring"],
    },
  ];

  it("injects a STYLE TO EMULATE block when the gate is on and pool is non-empty", async () => {
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
      postStyleEnabled: true,
      stylePool: pool,
      styleUltraProfiles: profiles,
    });

    expect(n).toBe(1);
    const systemArg: string = runner.draft.mock.calls[0]![0].system;
    expect(systemArg).toContain("STYLE TO EMULATE");
  });

  it("style block includes exemplar bodies from the pool", async () => {
    const runner = makeRunner();
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });

    await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 0,
      sink,
      release: vi.fn(),
      postStyleEnabled: true,
      stylePool: pool,
      styleUltraProfiles: profiles,
    });

    const systemArg: string = runner.draft.mock.calls[0]![0].system;
    // At least one exemplar body must appear in the system prompt.
    const hasBody =
      systemArg.includes("Juniors beat seniors") ||
      systemArg.includes("Hiring slow is hiring wrong");
    expect(hasBody).toBe(true);
  });

  it("style block includes ultra-profile style notes", async () => {
    const runner = makeRunner();
    const sink = vi.fn().mockResolvedValue({ draft_id: "d1" });

    await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner,
      makeVerifierCalls: () => [],
      verifyRetries: 0,
      sink,
      release: vi.fn(),
      postStyleEnabled: true,
      stylePool: pool,
      styleUltraProfiles: profiles,
    });

    const systemArg: string = runner.draft.mock.calls[0]![0].system;
    expect(systemArg).toContain("punchy and concrete");
  });

  it("the no-fabrication rule is always present (reinforces existing ban)", async () => {
    // Regardless of the style gate, the hard-ban must be in the system prompt.
    const runnerOn = makeRunner();
    const sinkOn = vi.fn().mockResolvedValue({ draft_id: "d1" });
    await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner: runnerOn,
      makeVerifierCalls: () => [],
      verifyRetries: 0,
      sink: sinkOn,
      release: vi.fn(),
      postStyleEnabled: true,
      stylePool: pool,
      styleUltraProfiles: profiles,
    });

    const runnerOff = makeRunner();
    const sinkOff = vi.fn().mockResolvedValue({ draft_id: "d2" });
    await runPostDrafterTick({
      log,
      instance,
      ideas: [idea],
      gather: async () => ctx,
      runner: runnerOff,
      makeVerifierCalls: () => [],
      verifyRetries: 0,
      sink: sinkOff,
      release: vi.fn(),
      postStyleEnabled: false,
    });

    const onSystem: string = runnerOn.draft.mock.calls[0]![0].system;
    const offSystem: string = runnerOff.draft.mock.calls[0]![0].system;
    // Both paths must include the no-fabrication hard ban.
    expect(onSystem).toContain("FAKE THE OPERATOR");
    expect(offSystem).toContain("FAKE THE OPERATOR");
  });
});

// ── Fail-open: Voyage error / no key ─────────────────────────────────────────

describe("runPostDrafterTick — fail-open on style error", () => {
  it("drafts the post when a fake fetch always errors (fail-open, no STYLE block)", async () => {
    const pool: StyleExemplarRow[] = [
      styleRow({ external_id: "x1", body: "A post body.", like_count: 100, comment_count: 10 }),
    ];
    // A fetch that always throws — simulates a Voyage network error.
    const badFetch = vi.fn().mockRejectedValue(new Error("network error")) as unknown as typeof fetch;

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
