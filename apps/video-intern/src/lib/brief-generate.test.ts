import { describe, expect, it, vi } from "vitest";
import { RecordingBriefOutputSchema, type RecordingBriefOutput } from "@noelle/contracts";
import {
  createBriefer,
  renderBriefMarkdown,
  countForgeFollowups,
  countWords,
} from "./brief-generate.js";
import { createVideoModelOperation } from "./video-gemini.js";
import type { JsonFn } from "./video-generate.js";

function fixture(over: Partial<RecordingBriefOutput> = {}): RecordingBriefOutput {
  return {
    title: "Why juniors compound faster than seniors",
    runtimeTarget: 42,
    hookCheck: "Hook lands in the first 2 seconds: open on the bold claim, no throat-clearing.",
    shotList: [
      { tStart: 0, tEnd: 3, description: "Talking head, medium shot, deliver the hook straight to camera" },
      { tStart: 3, tEnd: 20, description: "Screen recording of the onboarding doc" },
      { tStart: 20, tEnd: 42, description: "Back to talking head for the payoff and CTA" },
    ],
    bRoll: ["Hands typing at a laptop", "Whiteboard with the compounding curve"],
    camAngles: ["Eye-level medium", "Slight over-the-shoulder on the screen recording"],
    props: {
      inFrame: ["Laptop", "Coffee mug"],
      mustNotBeInFrame: ["Competitor logo on the monitor", "Messy background"],
    },
    onTheDayNotes: [
      { note: "Charge the mic before you start", forgeWouldHelp: false },
      { note: "Overlay the compounding curve as an animated chart", forgeWouldHelp: true },
      { note: "Generate a title card for the hook", forgeWouldHelp: true },
    ],
    ...over,
  };
}

describe("countForgeFollowups", () => {
  it("counts exactly the notes flagged forgeWouldHelp", () => {
    expect(countForgeFollowups(fixture())).toBe(2);
  });

  it("is 0 when nothing is flagged", () => {
    expect(
      countForgeFollowups(
        fixture({ onTheDayNotes: [{ note: "a", forgeWouldHelp: false }, { note: "b", forgeWouldHelp: false }] }),
      ),
    ).toBe(0);
  });

  it("is 0 for an empty notes list", () => {
    expect(countForgeFollowups(fixture({ onTheDayNotes: [] }))).toBe(0);
  });
});

describe("renderBriefMarkdown", () => {
  const md = renderBriefMarkdown(fixture());

  it("renders every section", () => {
    for (const heading of [
      "## Hook check",
      "## Shot list",
      "## B-roll",
      "## Cam angles",
      "## Props & setting",
      "## On-the-day notes",
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain("# Why juniors compound faster than seniors");
  });

  it("surfaces the founder-journey must-not-be-in-frame rule", () => {
    expect(md).toContain("Keep OUT of frame:");
    expect(md).toContain("Competitor logo on the monitor");
  });

  it("tags forge-flagged notes and prints the deterministic follow-up total", () => {
    // Flagged notes carry the [Forge] marker; unflagged ones do not.
    expect(md).toContain("[Forge] Overlay the compounding curve");
    expect(md).toContain("[Forge] Generate a title card");
    expect(md).toContain("- Charge the mic before you start");
    expect(md).not.toContain("[Forge] Charge the mic");
    // Foot total equals the deterministic count.
    expect(md).toContain("Forge follow-ups: 2");
  });

  it("stays under the 600-word phone-first budget", () => {
    expect(countWords(md)).toBeLessThanOrEqual(600);
  });

  it("uses no em dashes (house anti-slop rule)", () => {
    expect(md).not.toMatch(/[—–―]|--/);
  });

  it("renders shot list rows with their time ranges", () => {
    expect(md).toContain("0s-3s:");
    expect(md).toContain("20s-42s:");
  });
});

describe("RecordingBriefOutputSchema", () => {
  it("parses a valid brief and applies defaults", () => {
    const parsed = RecordingBriefOutputSchema.safeParse({
      title: "t",
      runtimeTarget: 30,
      hookCheck: "ok",
      shotList: [{ tStart: 0, tEnd: 3, description: "d" }],
      // bRoll / camAngles / props / onTheDayNotes omitted → defaulted
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bRoll).toEqual([]);
      expect(parsed.data.props).toEqual({ inFrame: [], mustNotBeInFrame: [] });
      expect(parsed.data.onTheDayNotes).toEqual([]);
    }
  });

  it("defaults a note's forgeWouldHelp to false", () => {
    const parsed = RecordingBriefOutputSchema.safeParse({
      title: "t",
      runtimeTarget: 30,
      hookCheck: "ok",
      onTheDayNotes: [{ note: "n" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.onTheDayNotes[0]?.forgeWouldHelp).toBe(false);
  });

  it("rejects a malformed brief (missing title, negative runtime)", () => {
    expect(RecordingBriefOutputSchema.safeParse({ runtimeTarget: 30, hookCheck: "x" }).success).toBe(false);
    expect(
      RecordingBriefOutputSchema.safeParse({ title: "t", runtimeTarget: -5, hookCheck: "x" }).success,
    ).toBe(false);
  });
});

describe("createBriefer", () => {
  it("forwards its operation separately from the model prompt and keeps absent-operation arity", async () => {
    const json = vi.fn<JsonFn>(async () => fixture()); const operation = createVideoModelOperation(async () => "dispatch");
    const briefer = createBriefer(json); const input = { hook: "h", concept: "c", script: "s", platform: "instagram" as const };
    expect(await briefer.brief({ ...input, operation })).toEqual(fixture());
    expect(json.mock.calls[0]).toHaveLength(3); expect(json.mock.calls[0]?.[2]).toBe(operation);
    expect(String(json.mock.calls[0]?.[1])).not.toContain("acknowledgement");
    await briefer.brief(input); expect(json.mock.calls[1]).toHaveLength(2);
  });
  it("validates and returns the brief from the injected json fn", async () => {
    const briefer = createBriefer(async () => fixture());
    const out = await briefer.brief({ hook: "h", concept: "c", script: "s", platform: "instagram" });
    expect(out?.title).toBe(fixture().title);
    expect(out?.onTheDayNotes).toHaveLength(3);
  });

  it("returns null when the json fn yields null (fail-open)", async () => {
    const briefer = createBriefer(async () => null);
    await expect(
      briefer.brief({ hook: "h", concept: null, script: "s", platform: "tiktok" }),
    ).resolves.toBeNull();
  });

  it("returns null when the json fn yields schema-invalid junk", async () => {
    const briefer = createBriefer(async () => ({ nope: true }));
    await expect(
      briefer.brief({ hook: "h", concept: null, script: "s", platform: "instagram" }),
    ).resolves.toBeNull();
  });
});
