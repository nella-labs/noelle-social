import { describe, expect, it } from "vitest";
import { FORM_VARIANTS, REDDIT_FORM_VARIANTS, X_FORM_VARIANTS } from "./formVariants.js";
import { renderStyleBlock } from "./styleBlock.js";

it("labels unknown engagement without treating a partial measurement as a total", () => {
  const exemplar = { body: "A concrete example", accountHandle: "source", likeCount: 5, commentCount: null } as unknown as Parameters<typeof renderStyleBlock>[0]["exemplars"][number];
  const text = renderStyleBlock({ exemplars: [exemplar], styleNotes: "" });
  expect(text).toContain("engagement unknown");
  expect(text).not.toContain("5 engagements");
  expect(text).not.toMatch(/high-performing/i);
});

it("preserves source wording and style notes while labeling unknown performance", () => {
  const body = "A high-performing source example.";
  const notes = "The source uses the phrase high-performing.";
  const text = renderStyleBlock({ exemplars: [{ body, accountHandle: "source", likeCount: null, commentCount: null }], styleNotes: notes });
  expect(text).toContain(body);
  expect(text).toContain(notes);
  expect(text).toContain("Saved exemplars");
});

describe("faithful short-reaction guidance", () => {
  const base = { exemplars: [{ body: "the typo won again", accountHandle: "peer", likeCount: 8, commentCount: 1 }], styleNotes: "playful" };

  it.each(["MICRO", "ONE_SHORT"])("allows X %s to stand alone while retaining plagiarism rules", (id) => {
    const block = renderStyleBlock({ ...base, formVariant: X_FORM_VARIANTS.find((v) => v.id === id)! }, "neutral", true);
    expect(block).not.toContain("must make no sense if pasted under any other post");
    expect(block).toContain("Do not pad a brief reaction with an explanation");
    expect(block).toContain("do not plagiarize");
    expect(block).toContain("NEVER reuse their opening lines");
  });

  it("lets faithful evidence define the writer instead of imposing generic habits", () => {
    const block = renderStyleBlock({ ...base, formVariant: X_FORM_VARIANTS.find((v) => v.id === "MICRO")! }, "neutral", true);
    expect(block).toContain("as actually shown in their examples and style notes");
    expect(block).toContain("writer's OWN writing");
    expect(block).not.toContain("stay lowercase the way they do");
    expect(block).not.toContain("slip in a short (parenthetical aside)");
    expect(block).not.toContain("use a '?!' or '??'");
    expect(block).not.toContain("An occasional ALL-CAPS word");
  });

  it("lets faithful evidence override voice details embedded in an assigned shape", () => {
    const block = renderStyleBlock({
      ...base,
      formVariant: { id: "LEGACY", directive: "Write lowercase with a (parenthetical aside)." },
    }, "neutral", true);
    expect(block).toContain("controls length and beat structure only");
    expect(block).toContain("writer evidence wins");
    expect(block).not.toContain("follow it exactly");
  });

  it.each([{ variants: FORM_VARIANTS }, { variants: REDDIT_FORM_VARIANTS }])("preserves other platforms' existing guidance", ({ variants }) => {
    const block = renderStyleBlock({ ...base, formVariant: variants.find((v) => v.id === "MICRO")! }, "neutral", true);
    expect(block).toContain("must make no sense if pasted under any other post");
  });
});
