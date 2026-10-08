import { describe, expect, it } from "vitest";
import { lint, charCountX } from "./voice.js";

describe("voice.lint", () => {
  it("flags as-an-ai", async () => {
    const r = await lint("as an AI, I cannot help");
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.rule === "as-an-ai")).toBe(true);
  });
  it("accepts clean text", async () => {
    const r = await lint("yeah this is the move. ship it.");
    expect(r.ok).toBe(true);
  });
});

describe("voice.charCountX", () => {
  it("counts URLs as 23", async () => {
    const r = await charCountX("see https://example.com/very/long/path");
    expect(r.count).toBe("see ".length + 23);
    expect(r.urls.length).toBe(1);
  });
  it("rejects > 280", async () => {
    const r = await charCountX("x".repeat(300));
    expect(r.isValid).toBe(false);
  });
});
