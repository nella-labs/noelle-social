import { describe, expect, it } from "vitest";
import { errorResult, sanitizeText, text, truncate } from "./result.js";

// True if the string contains a UTF-16 surrogate code unit that is not part of
// a valid high+low pair — the exact condition that makes the Anthropic API
// reject a tool result with "The request body is not valid JSON".
function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = str.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// U+1D5D5 MATHEMATICAL SANS-SERIF BOLD CAPITAL B ("𝗕") — an astral-plane
// character stored as the surrogate pair 𝗕. These "fancy bold"
// letters are ubiquitous in LinkedIn/X posts and are what originally poisoned
// noelle_list_leads.
const BOLD_B = "\u{1D5D5}";

describe("sanitizeText", () => {
  it("strips a lone high surrogate", () => {
    expect(sanitizeText("abc\uD835")).toBe("abc");
  });
  it("strips a lone low surrogate", () => {
    expect(sanitizeText("\uDDD5xyz")).toBe("xyz");
  });
  it("preserves a valid surrogate pair (astral char)", () => {
    expect(sanitizeText(`ok ${BOLD_B} ok`)).toBe(`ok ${BOLD_B} ok`);
    expect(hasLoneSurrogate(sanitizeText(`ok ${BOLD_B} ok`))).toBe(false);
  });
  it("leaves plain text untouched", () => {
    expect(sanitizeText("hello world")).toBe("hello world");
  });
});

describe("truncate", () => {
  it("never splits a surrogate pair at the boundary (the list_leads bug)", () => {
    const s = BOLD_B.repeat(100); // 100 code points = 200 UTF-16 code units
    const out = truncate(s, 80); // boundary lands mid-pair under naive slice()
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out.endsWith("…")).toBe(true);
  });
  it("counts by code points, not code units", () => {
    // 10 astral chars is 20 code units; with n=8 it must still ellipsize (>8
    // code points) and stay clean.
    const out = truncate(BOLD_B.repeat(10), 8);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(Array.from(out).length).toBe(8); // 7 chars + the ellipsis
  });
  it("returns short strings unchanged", () => {
    expect(truncate("short", 80)).toBe("short");
    expect(truncate(null)).toBe("");
    expect(truncate(undefined)).toBe("");
  });
});

describe("result envelopes sanitize at the boundary", () => {
  it("text() cannot emit a lone surrogate", () => {
    const r = text(`poisoned${"\uD835"}tail`);
    expect(hasLoneSurrogate(r.content[0]!.text)).toBe(false);
  });
  it("errorResult() cannot emit a lone surrogate and marks isError", () => {
    const r = errorResult(`bad${"\uDDD5"}`);
    expect(hasLoneSurrogate(r.content[0]!.text)).toBe(false);
    expect(r.isError).toBe(true);
  });
});
