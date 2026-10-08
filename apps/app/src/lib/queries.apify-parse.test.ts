import { describe, it, expect } from "vitest";
import { parseApifyTokens } from "./queries";

describe("parseApifyTokens", () => {
  it("splits one-token-per-line", () => {
    const raw = "apify_api_aaaaaaaaaaaa\napify_api_bbbbbbbbbbbb\napify_api_cccccccccccc";
    expect(parseApifyTokens(raw)).toEqual({
      tokens: ["apify_api_aaaaaaaaaaaa", "apify_api_bbbbbbbbbbbb", "apify_api_cccccccccccc"],
      rejected: 0,
    });
  });

  it("splits on commas and arbitrary whitespace too", () => {
    const raw = "apify_api_aaaaaaaaaaaa, apify_api_bbbbbbbbbbbb\t  apify_api_cccccccccccc";
    expect(parseApifyTokens(raw).tokens).toEqual([
      "apify_api_aaaaaaaaaaaa",
      "apify_api_bbbbbbbbbbbb",
      "apify_api_cccccccccccc",
    ]);
  });

  it("trims, drops blank lines, and ignores trailing newlines", () => {
    const raw = "\n\n   apify_api_aaaaaaaaaaaa   \n\n  \napify_api_bbbbbbbbbbbb\n";
    expect(parseApifyTokens(raw).tokens).toEqual([
      "apify_api_aaaaaaaaaaaa",
      "apify_api_bbbbbbbbbbbb",
    ]);
  });

  it("de-dupes, keeping first-seen order", () => {
    const raw = "apify_api_aaaaaaaaaaaa\napify_api_bbbbbbbbbbbb\napify_api_aaaaaaaaaaaa";
    const { tokens } = parseApifyTokens(raw);
    expect(tokens).toEqual(["apify_api_aaaaaaaaaaaa", "apify_api_bbbbbbbbbbbb"]);
  });

  it("rejects fragments shorter than 12 chars and counts them", () => {
    const raw = "short\ntiny\napify_api_aaaaaaaaaaaa";
    expect(parseApifyTokens(raw)).toEqual({
      tokens: ["apify_api_aaaaaaaaaaaa"],
      rejected: 2,
    });
  });

  it("returns empty for an all-blank or all-junk paste", () => {
    expect(parseApifyTokens("   \n\t , ,")).toEqual({ tokens: [], rejected: 0 });
    expect(parseApifyTokens("a b c")).toEqual({ tokens: [], rejected: 3 });
  });

  it("does not count duplicates of a valid token as rejected", () => {
    const raw = "apify_api_aaaaaaaaaaaa apify_api_aaaaaaaaaaaa";
    expect(parseApifyTokens(raw)).toEqual({
      tokens: ["apify_api_aaaaaaaaaaaa"],
      rejected: 0,
    });
  });
});
