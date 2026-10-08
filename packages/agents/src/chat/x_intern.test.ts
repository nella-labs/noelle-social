import { describe, expect, it } from "vitest";
import { xInternChatProfile } from "./x_intern.js";
import type { AgentChatContext } from "./types.js";

describe("xInternChatProfile.greeting", () => {
  it("includes the display name and offers concrete suggestions", () => {
    const g = xInternChatProfile.greeting({ displayName: "Vega" });
    expect(g.body).toContain("Vega");
    expect(g.body).toContain("X Growth Intern");
    expect(g.suggestions.length).toBeGreaterThan(0);
    expect(g.suggestions).toContain("Show me the best leads for today");
  });
});

describe("xInternChatProfile.systemPrompt", () => {
  it("describes current configurable discovery, candidate review and opt-in sending without fixed cadence or angle promises", () => {
    const prompt = xInternChatProfile.systemPrompt({ displayName: "Vega", context: {} });
    expect(prompt).toMatch(/browser/i);
    expect(prompt).toMatch(/configured/i);
    expect(prompt).toMatch(/consent/i);
    expect(prompt).not.toMatch(/every 5 min|exactly three|never send autonomously|founder approves every reply|one-click send/i);
    expect(xInternChatProfile.greeting({ displayName: "Vega" }).suggestions).not.toContain("Draft a contrarian angle for the top lead");
  });

  it("keeps an unavailable queue distinct from a measured empty queue", () => {
    const prompt = xInternChatProfile.systemPrompt({ displayName: "Vega", context: {} });
    expect(prompt).toMatch(/Queue snapshot: unavailable/i);
    expect(prompt).not.toMatch(/Queue snapshot: empty/i);
  });

  it("renders the full persona even with an empty snapshot", () => {
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: {},
    });
    expect(prompt).toContain('"Vega"');
    expect(prompt).toContain("X Growth Intern");
    // Job description — pipeline must be named so the agent knows what it does.
    expect(prompt).toMatch(/discovery/);
    expect(prompt).toMatch(/classifier/);
    expect(prompt).toMatch(/drafter/);
    expect(prompt).toMatch(/send worker/);
    // Read-only chat constraint
    expect(prompt).toMatch(/read-only/i);
    // No-fabrication rule
    expect(prompt).toMatch(/never invent/i);
  });

  it("appends a non-empty queue snapshot when approvals are present", () => {
    const context: AgentChatContext = {
      totalPendingCount: 3,
      totalSentLifetime: 42,
      workerFreshness: [
        { worker: "discovery", lastSuccessAt: "2026-05-26T11:55:00.000Z" },
        { worker: "drafter", lastSuccessAt: null },
      ],
      pendingApprovals: [
        {
          approvalId: "11111111-1111-1111-1111-111111111111",
          authorHandle: "marcus_h_writes",
          postText: "Trying to figure out how to coordinate three AI agents.",
          selectedAngle: "empathetic",
          draftBody: "Coordinated three agents last week — happy to share what worked.",
          tier: "T1",
          velocityScore: 87,
          createdAt: "2026-05-26T11:00:00.000Z",
        },
      ],
    };
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context,
    });
    expect(prompt).toContain("Live snapshot");
    expect(prompt).toContain("3 approvals pending");
    expect(prompt).toContain("42 sent or skipped lifetime");
    expect(prompt).toContain("@marcus_h_writes");
    expect(prompt).toContain("tier=T1");
    expect(prompt).toContain("velocity=87");
    expect(prompt).toContain("selected_angle=empathetic");
    expect(prompt).toContain("Trying to figure out how to coordinate");
    // Worker freshness rendered
    expect(prompt).toContain("drafter=never");
  });

  it("renders today's real leads with reply + post links", () => {
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: {
        bestLeads: [
          {
            handle: "simonw",
            tier: "T1",
            score: 91,
            postText: "agents keep hallucinating imports",
            postId: "1790",
            originalPostUrl: "https://x.com/simonw/status/1790",
            replyUrl: "https://x.com/intent/tweet?in_reply_to=1790",
            hasDraft: false,
          },
        ],
      },
    });
    expect(prompt).toContain("Today's leads");
    expect(prompt).toContain("@simonw");
    expect(prompt).toContain("tier=T1");
    expect(prompt).toContain("not drafted yet");
    expect(prompt).toContain("reply_link: https://x.com/intent/tweet?in_reply_to=1790");
    expect(prompt).toContain("post_link: https://x.com/simonw/status/1790");
  });

  it("appends the prefilled reply link to a drafted approval row", () => {
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: {
        pendingApprovals: [
          {
            approvalId: "a",
            authorHandle: "fred",
            postText: "p",
            selectedAngle: "technical",
            draftBody: "d",
            tier: "T2",
            velocityScore: 70,
            createdAt: "2026-05-26T11:00:00.000Z",
            postId: "1791",
            replyUrl: "https://x.com/intent/tweet?in_reply_to=1791&text=d",
          },
        ],
      },
    });
    expect(prompt).toContain("reply_link: https://x.com/intent/tweet?in_reply_to=1791&text=d");
  });

  it("instructs the model to surface real links as markdown and never invent a URL", () => {
    const prompt = xInternChatProfile.systemPrompt({ displayName: "Vega", context: {} });
    expect(prompt).toMatch(/reply_link|post_link/);
    expect(prompt).toMatch(/never invent, guess, or edit a URL/i);
    expect(prompt).toMatch(/\[reply to @handle\]/);
  });

  it("flags an empty queue explicitly instead of staying silent", () => {
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: { totalPendingCount: 0, pendingApprovals: [] },
    });
    expect(prompt).toMatch(/Queue snapshot: empty/i);
  });

  it("teaches the model to propose targeting/mission changes via a noelle-proposal block", () => {
    const prompt = xInternChatProfile.systemPrompt({ displayName: "Vega", context: {} });
    // The one mutation it can drive from chat.
    expect(prompt).toMatch(/watchlist|hunt for/i);
    expect(prompt).toContain("noelle-proposal");
    // Propose-then-confirm, never self-apply.
    expect(prompt).toMatch(/PROPOSE|confirm/i);
    expect(prompt).toContain("addHandles");
    expect(prompt).toContain("removeKeywords");
  });

  it("renders the current mission when the operator has set one", () => {
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: { objective: "find founders frustrated with social media" },
    });
    expect(prompt).toContain("Current mission");
    expect(prompt).toContain("find founders frustrated with social media");
  });

  it("states there is no custom mission when none is set", () => {
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: {},
    });
    expect(prompt).toMatch(/no.{0,3}set|default brief/i);
  });

  it("renders the current targeting so the model proposes accurate diffs", () => {
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: { targeting: { handles: ["levelsio"], keywords: ["X growth"] } },
    });
    expect(prompt).toContain("Currently hunting for");
    expect(prompt).toContain("@levelsio");
    expect(prompt).toContain("X growth");
  });

  it("truncates long post text + draft body so the prompt stays bounded", () => {
    const longPost = "x".repeat(500);
    const longDraft = "y".repeat(500);
    const prompt = xInternChatProfile.systemPrompt({
      displayName: "Vega",
      context: {
        pendingApprovals: [
          {
            approvalId: "a",
            authorHandle: "fred",
            postText: longPost,
            selectedAngle: "technical",
            draftBody: longDraft,
