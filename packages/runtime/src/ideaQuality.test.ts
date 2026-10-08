import { describe, expect, it, vi } from "vitest";
import { generateCheckedIdeas } from "./ideaQuality.js";

const clean = { hook: "The parser stops at the first missing field", thesis: "Show which field failed so the caller can fix it." };
const response = (ideas: typeof clean[], model = "first") => ({
  text: JSON.stringify({ ideas: model === "repair" ? ideas.map((idea, repair_id) => ({ ...idea, repair_id })) : ideas }), model,
});
const parse = (text: string): typeof clean[] | null => {
  try { return JSON.parse(text).ideas ?? null; } catch { return null; }
};

describe("generateCheckedIdeas", () => {
  it("keeps clean ideas and response metadata without another model call", async () => {
    const original = response([clean]);
    const generate = vi.fn().mockResolvedValue(original);
    expect(await generateCheckedIdeas(generate, parse)).toEqual({ response: original, ideas: [clean] });
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([
    { ...clean, hook: "Here's the thing: the parser stops." },
    { ...clean, thesis: "This is a pivotal moment for parsers." },
    { ...clean, hook: "A parser isn't a tool, it's a philosophy." },
    { ...clean, thesis: "The parser stopped — the field was missing." },
    { ...clean, hook: "x".repeat(601) },
    { ...clean, thesis: "x".repeat(1201) },
  ])("repairs a rejected field and returns only checked text: %j", async (bad) => {
    const generate = vi.fn<(feedback: string) => Promise<ReturnType<typeof response>>>()
      .mockResolvedValueOnce(response([bad])).mockResolvedValueOnce(response([clean], "repair"));
    const result = await generateCheckedIdeas(generate, parse);
    expect(result?.ideas).toEqual([clean]);
    expect(result?.response.model).toBe("repair");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0]).toContain(bad.hook);
    expect(generate.mock.calls[1]![0]).toMatch(/hook|thesis/);
  });

  it("rejects a second bad response with reasons instead of returning it", async () => {
    const bad = { ...clean, thesis: "Let that sink in." };
    const generate = vi.fn().mockResolvedValueOnce(response([bad])).mockResolvedValueOnce(response([bad], "repair"));
    await expect(generateCheckedIdeas(generate, parse)).rejects.toThrow(/anti-AI.*thesis/i);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not silently shrink a batch during repair", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(response([clean, { ...clean, hook: "Here's the thing: missing fields fail." }]))
      .mockResolvedValueOnce(response([clean]));
    await expect(generateCheckedIdeas(generate, parse)).rejects.toThrow(/count/i);
  });

  it("keeps source metadata when the repair changes or omits it", async () => {
    const original = { ...clean, hook: "Here's the thing: fields matter.", inspiration_tags: ["W1"], pillar: "parsers" };
    const generate = vi.fn().mockResolvedValueOnce(response([original, clean]))
      .mockResolvedValueOnce(response([
        { ...clean, inspiration_tags: [], pillar: "sales" } as typeof clean,
        { ...clean, hook: "The model replaced a clean idea" },
      ], "repair"));
    expect((await generateCheckedIdeas(generate, parse))?.ideas).toEqual([{ ...original, ...clean }, clean]);
  });

  it("rejects a reordered repair even when source metadata is identical", async () => {
    const original = { ...clean, hook: "Here's the thing: fields matter." };
    const generate = vi.fn().mockResolvedValueOnce(response([original, original]))
      .mockResolvedValueOnce({ text: JSON.stringify({ ideas: [{ ...clean, repair_id: 1 }, { ...clean, repair_id: 0 }] }) });
    await expect(generateCheckedIdeas(generate, parse)).rejects.toThrow(/repair.*order/i);
  });

  it("rejects a repair that omits stable identifiers", async () => {
    const generate = vi.fn().mockResolvedValueOnce(response([{ ...clean, hook: "Here's the thing: fields matter." }]))
      .mockResolvedValueOnce(response([clean]));
    await expect(generateCheckedIdeas(generate, parse)).rejects.toThrow(/repair.*order/i);
  });

  it("does not mistake a hook repeated as a thesis for repeated prose", async () => {
    const idea = { hook: clean.hook, thesis: clean.hook };
    expect((await generateCheckedIdeas(async () => response([idea]), parse))?.ideas).toEqual([idea]);
  });

  it("keeps the existing null result for initially malformed output", async () => {
    expect(await generateCheckedIdeas(async () => ({ text: "not json" }), parse)).toBeNull();
  });

  it("throws when repair returns malformed output", async () => {
    const generate = vi.fn().mockResolvedValueOnce(response([{ ...clean, hook: "Here's the thing: fields matter." }]))
      .mockResolvedValueOnce({ text: "not json" });
    await expect(generateCheckedIdeas(generate, parse)).rejects.toThrow(/anti-AI.*invalid/i);
  });
});
