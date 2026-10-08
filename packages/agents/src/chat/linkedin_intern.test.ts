import { describe, expect, it } from "vitest";
import { linkedinInternChatProfile } from "./linkedin_intern.js";

describe("linkedinInternChatProfile.greeting", () => {
  it("includes the display name and offers concrete suggestions", () => {
    const g = linkedinInternChatProfile.greeting({ displayName: "Lyra" });
    expect(g.body).toContain("Lyra");
    expect(g.body).toContain("LinkedIn Growth Intern");
    expect(g.suggestions.length).toBeGreaterThan(0);
  });
});

describe("linkedinInternChatProfile.systemPrompt", () => {
  it("renders the full persona even with an empty snapshot", () => {
    const prompt = linkedinInternChatProfile.systemPrompt({
      displayName: "Lyra",
      context: {},
    });
    expect(prompt).toContain('"Lyra"');
    expect(prompt).toContain("LinkedIn Growth Intern");
    expect(prompt).toMatch(/discovery/);
    expect(prompt).toMatch(/profiler/);
    expect(prompt).toMatch(/drafter/);
    // Draft-only invariant: never posts / auto-sends.
    expect(prompt).toMatch(/never|draft-only/i);
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/never invent/i);
  });

  it("teaches the model to propose mission + people changes via a noelle-proposal block", () => {
    const prompt = linkedinInternChatProfile.systemPrompt({
      displayName: "Lyra",
      context: {},
    });
    // The one mutation it can drive from chat.
    expect(prompt).toMatch(/who's worth replying to/i);
    expect(prompt).toContain("noelle-proposal");
    // Propose-then-confirm, never self-apply.
    expect(prompt).toMatch(/PROPOSE|confirm/i);
    // LinkedIn-shaped fields only — people + mission, no handles/keywords.
    expect(prompt).toContain("addPeople");
    expect(prompt).toContain("removePeople");
    expect(prompt).not.toContain("addHandles");
    expect(prompt).not.toContain("addKeywords");
    // Disambiguation: category → mission, specific person → addPeople.
    expect(prompt).toMatch(/MISSION edit/i);
    expect(prompt).toMatch(/addPeople/);
  });

  it("renders the current mission when the operator has set one", () => {
    const prompt = linkedinInternChatProfile.systemPrompt({
      displayName: "Lyra",
      context: { objective: "engage YC founders shipping AI" },
    });
    expect(prompt).toContain("Current mission");
    expect(prompt).toContain("engage YC founders shipping AI");
  });

  it("renders the current watchlist so the model proposes accurate diffs", () => {
    const prompt = linkedinInternChatProfile.systemPrompt({
      displayName: "Lyra",
      context: { targeting: { handles: ["Jane Doe", "in/john-smith"], keywords: [] } },
    });
    expect(prompt).toContain("Watchlist");
    expect(prompt).toContain("Jane Doe");
    expect(prompt).toContain("in/john-smith");
  });

  it("flags an empty queue explicitly instead of staying silent", () => {
    const prompt = linkedinInternChatProfile.systemPrompt({
      displayName: "Lyra",
      context: { totalPendingCount: 0, pendingApprovals: [] },
    });
    expect(prompt).toMatch(/Queue snapshot: empty/i);
  });
  it("keeps unavailable queue and recent-post reads distinct from measured empty snapshots", () => {
    const prompt = linkedinInternChatProfile.systemPrompt({ displayName: "Lyra", context: {} });
    expect(prompt).toContain("Queue snapshot: unavailable");
    expect(prompt).toContain("Recent posts: unavailable");
    expect(prompt).not.toContain("Queue snapshot: empty");
  });
  it("does not attribute shared worker success to this specific instance", () => {
    const prompt = linkedinInternChatProfile.systemPrompt({ displayName: "Lyra", context: { workerFreshness: [{ worker: "drafter", lastSuccessAt: null }] } });
    expect(prompt).toContain("shared worker history");
    expect(prompt).toContain("not an instance-specific completion receipt");
  });
});
