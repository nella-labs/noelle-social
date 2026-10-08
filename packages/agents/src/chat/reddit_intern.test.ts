import { describe, expect, it } from "vitest";
import { redditInternChatProfile } from "./reddit_intern.js";

describe("redditInternChatProfile.greeting", () => {
  it("includes the display name and offers concrete suggestions", () => {
    const g = redditInternChatProfile.greeting({ displayName: "Orion" });
    expect(g.body).toContain("Orion");
    expect(g.body).toContain("Reddit Growth Intern");
    expect(g.suggestions.length).toBeGreaterThan(0);
  });
});

describe("redditInternChatProfile.systemPrompt", () => {
  it("does not attribute shared worker success to this specific instance", () => {
    const prompt = redditInternChatProfile.systemPrompt({ displayName: "Orion", context: { workerFreshness: [{ worker: "drafter", lastSuccessAt: null }] } });
    expect(prompt).toContain("shared worker history");
    expect(prompt).toContain("not an instance-specific completion receipt");
  });
  it("reports unavailable watchlist and queue data without declaring them empty", () => {
    const prompt = redditInternChatProfile.systemPrompt({ displayName: "Orion", context: {} });
    expect(prompt).toContain("Watchlist unavailable");
    expect(prompt).toContain("Queue snapshot unavailable");
    expect(prompt).not.toContain("Queue snapshot: empty");
  });
  it("leaves configured posting to reviewed and consented account workflows", () => {
    const prompt = redditInternChatProfile.systemPrompt({ displayName: "Orion", context: {} });
    expect(prompt).toContain("configured actuator");
    expect(prompt).not.toContain("You NEVER post to Reddit");
    expect(prompt).not.toContain("exactly three reply angles");
  });
  it("renders the full persona even with an empty snapshot", () => {
    const prompt = redditInternChatProfile.systemPrompt({
      displayName: "Orion",
      context: {},
    });
    expect(prompt).toContain('"Orion"');
    expect(prompt).toContain("Reddit Growth Intern");
    expect(prompt).toMatch(/discovery/);
    expect(prompt).toMatch(/classifier/);
    expect(prompt).toMatch(/drafter/);
    // Posting belongs to a configured, gated account workflow.
    expect(prompt).toContain("This chat cannot post to Reddit");
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/never invent/i);
  });

  it("teaches the model to propose mission + subreddit changes via a noelle-proposal block", () => {
    const prompt = redditInternChatProfile.systemPrompt({
      displayName: "Orion",
      context: {},
    });
    // The one mutation it can drive from chat.
    expect(prompt).toMatch(/who's worth replying to/i);
    expect(prompt).toContain("noelle-proposal");
    // Propose-then-confirm, never self-apply.
    expect(prompt).toMatch(/PROPOSE|confirm/i);
    // Reddit-shaped fields only — subreddits + mission, no people/handles/keywords.
    expect(prompt).toContain("addSubreddits");
    expect(prompt).toContain("removeSubreddits");
    expect(prompt).not.toContain("addPeople");
    expect(prompt).not.toContain("addHandles");
    expect(prompt).not.toContain("addKeywords");
    // Disambiguation: category → mission, specific subreddit → addSubreddits.
    expect(prompt).toMatch(/MISSION edit/i);
    expect(prompt).toMatch(/addSubreddits/);
  });

  it("renders the current mission when the operator has set one", () => {
    const prompt = redditInternChatProfile.systemPrompt({
      displayName: "Orion",
      context: { objective: "engage founders shipping AI" },
    });
    expect(prompt).toContain("Current mission");
    expect(prompt).toContain("engage founders shipping AI");
  });

  it("renders the current watchlist so the model proposes accurate diffs", () => {
    const prompt = redditInternChatProfile.systemPrompt({
      displayName: "Orion",
      context: { targeting: { handles: ["r/SaaS", "r/startups"], keywords: [] } },
    });
    expect(prompt).toContain("Watchlist");
    expect(prompt).toContain("r/SaaS");
    expect(prompt).toContain("r/startups");
  });

  it("flags an empty queue explicitly instead of staying silent", () => {
    const prompt = redditInternChatProfile.systemPrompt({
      displayName: "Orion",
      context: { totalPendingCount: 0, pendingApprovals: [] },
    });
    expect(prompt).toMatch(/Queue snapshot: empty/i);
  });
});
