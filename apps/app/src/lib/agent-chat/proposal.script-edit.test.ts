import { describe, expect, it } from "vitest";
import { extractScriptEdit } from "./proposal";

describe("extractScriptEdit", () => {
  it("returns no edit when there's no block", () => {
    const r = extractScriptEdit("Your hook is solid — I wouldn't touch it.");
    expect(r.scriptEdit).toBeNull();
    expect(r.text).toBe("Your hook is solid — I wouldn't touch it.");
  });

  it("extracts + validates a beats edit and strips the block from the text", () => {
    const raw = [
      "Your 0–5s buries the claim. Drop in three hard beats:",
      "```noelle-script-edit",
      JSON.stringify({
        beats: [{ index: 0, line: "20 hours a week. Gone." }],
        summary: "tighten the hook into three hard beats",
      }),
      "```",
    ].join("\n");
    const r = extractScriptEdit(raw);
    expect(r.scriptEdit).not.toBeNull();
    expect(r.scriptEdit!.beats?.[0]).toEqual({ index: 0, line: "20 hours a week. Gone." });
    expect(r.scriptEdit!.summary).toContain("tighten");
    expect(r.text).not.toContain("noelle-script-edit");
    expect(r.text).toContain("buries the claim");
  });

  it("extracts a full-script rewrite", () => {
    const raw = [
      "Here's a whole-pass rewrite.",
      "```noelle-script-edit",
      JSON.stringify({ fullScript: "New script body.", summary: "full rewrite" }),
      "```",
    ].join("\n");
    const r = extractScriptEdit(raw);
    expect(r.scriptEdit!.fullScript).toBe("New script body.");
  });

  it("tolerates the model's key drift (text→line, note→summary, string index)", () => {
    const raw = [
      "Here:",
      "```noelle-script-edit",
      JSON.stringify({ beats: [{ index: "0", text: "Scrolling. Guessing. Exhausting." }], note: "snap the hook" }),
      "```",
    ].join("\n");
    const r = extractScriptEdit(raw);
    expect(r.scriptEdit).not.toBeNull();
    expect(r.scriptEdit!.beats?.[0]).toEqual({ index: 0, line: "Scrolling. Guessing. Exhausting." });
    expect(r.scriptEdit!.summary).toBe("snap the hook");
  });

  it("drops an invalid block (bad index) but still strips it", () => {
    const raw = [
      "Try this.",
      "```noelle-script-edit",
      JSON.stringify({ beats: [{ index: -3, line: "x" }], summary: "bad" }),
      "```",
    ].join("\n");
    const r = extractScriptEdit(raw);
    expect(r.scriptEdit).toBeNull();
    expect(r.text).not.toContain("noelle-script-edit");
  });
});
