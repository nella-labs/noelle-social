import { describe, expect, it } from "vitest";
import { videoInternChatProfile } from "./video_intern.js";
import type { ChatVideoDraft } from "./types.js";

describe("videoInternChatProfile.greeting", () => {
  it("includes the display name and offers concrete suggestions", () => {
    const g = videoInternChatProfile.greeting({ displayName: "Nova" });
    expect(g.body).toContain("Nova");
    expect(g.body).toContain("Video Growth Intern");
    expect(g.suggestions.length).toBeGreaterThan(0);
  });
});

describe("videoInternChatProfile.systemPrompt", () => {
  it("labels missing views as unknown in the clip snapshot", () => {
    const prompt = videoInternChatProfile.systemPrompt({
      displayName: "Nova",
      context: { videoIntel: { brandGuide: [], topClips: [{ handle: "example", views: null, caption: "A clip" }] } },
    });
    expect(prompt).toContain("@example, unknown views");
    expect(prompt).not.toContain("null views");
  });

  it("preserves a measured zero view/follower ratio without an audience claim", () => {
    const prompt = videoInternChatProfile.systemPrompt({
      displayName: "Nova",
      context: { currentDraft: {
        hook: "A hook", status: "draft", beats: [], script: "A script", visuals: [], sounds: [], inspiredBy: [],
        inspirations: [{ handle: "example", views: 0, reachMultiple: 0 }],
      } },
    });
    expect(prompt).toContain("0 views, 0.0× views/followers");
  });

  it("renders the full persona even with an empty snapshot", () => {
    const prompt = videoInternChatProfile.systemPrompt({
      displayName: "Nova",
      context: {},
    });
    expect(prompt).toContain('"Nova"');
    expect(prompt).toContain("Video Growth Intern");
    // Draft-only invariant: never posts / auto-publishes.
    expect(prompt).toMatch(/never post/i);
    expect(prompt).toMatch(/never invent/i);
    // No draft open → no refine block.
    expect(prompt).not.toMatch(/RIGHT NOW the operator is in the Drafts studio/);
  });

  it("pins the chat to the open draft when one is being refined", () => {
    const currentDraft: ChatVideoDraft = {
      hook: "Most creators waste 20 hours a week on research",
      status: "draft",
      beats: [
        { tStart: 0, tEnd: 5, purpose: "hook", line: "Stop wasting 20 hours a week." },
        { tStart: 5, tEnd: 12, purpose: "claim", line: "I built an AI that does it in minutes." },
      ],
      script: "Stop wasting 20 hours a week. I built an AI that does it in minutes.",
      visuals: ["Weekly Research Time (bar)"],
      sounds: ["Upbeat Corporate Tech"],
      inspiredBy: ["raycfu", "mavgpt"],
    };

    const prompt = videoInternChatProfile.systemPrompt({
      displayName: "Nova",
      context: { currentDraft },
    });

    // The refine-mode instruction is present and pins Nova to this video as its author.
    expect(prompt).toMatch(/RIGHT NOW the operator is in the Drafts studio refining/);
    expect(prompt).toMatch(/YOU wrote this script/);
    // It teaches the apply protocol (the fenced script-edit block).
    expect(prompt).toContain("noelle-script-edit");
    expect(prompt).toMatch(/0-based/);

    // The draft's real content makes it into the snapshot so Nova can quote it.
    expect(prompt).toContain("Most creators waste 20 hours a week on research");
    expect(prompt).toContain("Stop wasting 20 hours a week.");
    expect(prompt).toContain("I built an AI that does it in minutes.");
    expect(prompt).toContain("0–5s");
    expect(prompt).toContain("[hook]");
    // Modeled-on creators + soundtrack + visuals are surfaced.
    expect(prompt).toContain("@raycfu");
    expect(prompt).toContain("Upbeat Corporate Tech");
    expect(prompt).toContain("Weekly Research Time (bar)");
  });

  it("grounds the refiner in the exemplar reels' teardowns (same knowledge as the scripter)", () => {
    const currentDraft: ChatVideoDraft = {
      hook: "A hook",
      status: "draft",
      beats: [{ tStart: 0, tEnd: 5, purpose: "hook", line: "open" }],
      script: "open",
      visuals: [],
      sounds: [],
      inspiredBy: ["raycfu"],
      inspirations: [
        { handle: "raycfu", views: 142200, reachMultiple: 0.7, hook: "How to build a dev team with 4 AI agents", whyItWorked: "opens on a bold claim then cuts fast" },
      ],
    };
    const prompt = videoInternChatProfile.systemPrompt({ displayName: "Nova", context: { currentDraft } });
    expect(prompt).toMatch(/modeled on these reels/);
    expect(prompt).toContain("@raycfu");
    expect(prompt).toContain("opens on a bold claim then cuts fast");
    // beats are numbered by index so the script-edit block can target them.
    expect(prompt).toContain("beat 0");
  });

  it("falls back to the raw script when a draft has no structured beats", () => {
    const currentDraft: ChatVideoDraft = {
      hook: "A hook",
      status: "ready",
      beats: [],
      script: "Line one. Line two. Line three.",
      visuals: [],
      sounds: [],
      inspiredBy: [],
    };
    const prompt = videoInternChatProfile.systemPrompt({
      displayName: "Nova",
      context: { currentDraft },
    });
    expect(prompt).toContain("Line one. Line two. Line three.");
  });
});
