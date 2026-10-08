import { describe, expect, it } from "vitest";
import {
  buildPlainTextScript,
  buildMarkdownScript,
  scriptFilenameSlug,
  type ScriptExportInput,
} from "./video-script-export";

const sample: ScriptExportInput = {
  hook: "Most creators waste 20 hours a week on research",
  status: "draft",
  sounds: ["Upbeat Corporate Tech"],
  beats: [
    { tStart: 0, tEnd: 5, purpose: "hook", line: "Stop wasting 20 hours a week.", cues: ["screen recording"], visuals: ["Weekly Research Time (bar)"] },
    { tStart: 5, tEnd: 12, purpose: "payoff", line: "I built an AI that does it in minutes.", cues: [], visuals: [] },
  ],
  script: "Stop wasting 20 hours a week. I built an AI that does it in minutes.",
};

describe("buildPlainTextScript", () => {
  it("leads with the hook then the full script", () => {
    const txt = buildPlainTextScript(sample);
    expect(txt.startsWith("Most creators waste 20 hours a week on research")).toBe(true);
    expect(txt).toContain("Stop wasting 20 hours a week. I built an AI that does it in minutes.");
    expect(txt.endsWith("\n")).toBe(true);
  });

  it("falls back to timed beat lines when there is no full script", () => {
    const txt = buildPlainTextScript({ ...sample, script: "" });
    expect(txt).toContain("[0–5s] Stop wasting 20 hours a week.");
    expect(txt).toContain("[5–12s] I built an AI that does it in minutes.");
  });
});

describe("buildMarkdownScript", () => {
  it("renders title, soundtrack, storyboard beats, cues, visuals, and the full script", () => {
    const md = buildMarkdownScript(sample);
    expect(md).toContain("# Most creators waste 20 hours a week on research");
    expect(md).toContain("**Status:** draft · **Soundtrack:** Upbeat Corporate Tech");
    expect(md).toContain("## Storyboard");
    expect(md).toContain("### 0–5s · hook");
    expect(md).toContain("🎬 _Footage:_ screen recording");
    expect(md).toContain("🖼 _On screen:_ Weekly Research Time (bar)");
    expect(md).toContain("## Full script");
  });

  it("handles an empty draft without throwing", () => {
    const md = buildMarkdownScript({ hook: "", status: "draft", sounds: [], beats: [], script: "" });
    expect(md).toContain("# Untitled video");
  });
});

describe("scriptFilenameSlug", () => {
  it("slugifies the hook and caps length", () => {
    expect(scriptFilenameSlug("Most creators waste 20 hours!")).toBe("most-creators-waste-20-hours");
  });
  it("falls back when the hook has no usable characters", () => {
    expect(scriptFilenameSlug("!!!")).toBe("video-script");
  });
});
