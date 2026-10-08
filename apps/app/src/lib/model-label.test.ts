import { describe, expect, test } from "vitest";
import { cleanModelLabel, scrubBackendTokens } from "./model-label";

describe("cleanModelLabel", () => {
  test("maps known model ids to clean names", () => {
    expect(cleanModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(cleanModelLabel("claude-opus-4-7")).toBe("Opus 4.7");
    expect(cleanModelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(cleanModelLabel("gemini-2-5-flash")).toBe("Gemini 2.5 Flash");
  });

  test("strips any engine prefix the data layer might still carry", () => {
    expect(cleanModelLabel("bedrock · claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(cleanModelLabel("vertex/claude-opus-4-6")).toBe("Opus 4.6");
    expect(cleanModelLabel("vertex · gemini-2-5-pro")).toBe("Gemini 2.5 Pro");
  });

  test("NEVER surfaces a backend or gpt-5 — unknown/banned ids return null", () => {
    expect(cleanModelLabel("gpt-5")).toBeNull();
    expect(cleanModelLabel("codex · gpt-5")).toBeNull();
    expect(cleanModelLabel("bedrock")).toBeNull();
    expect(cleanModelLabel("vertex")).toBeNull();
    expect(cleanModelLabel("o3-mini")).toBeNull();
    expect(cleanModelLabel(null)).toBeNull();
    expect(cleanModelLabel("")).toBeNull();
  });

  test("never returns a string containing a banned token", () => {
    const banned = /bedrock|vertex|codex|gpt-?5|aws|gcp/i;
    for (const input of [
      "claude-sonnet-4-6",
      "bedrock · claude-sonnet-4-6",
      "vertex · gemini-2-5-flash",
      "codex · gpt-5",
      "gpt-5",
    ]) {
      const out = cleanModelLabel(input);
      if (out != null) expect(out).not.toMatch(banned);
    }
  });
});

describe("scrubBackendTokens", () => {
  const banned = /\b(bedrock|vertex|codex|aws|gcp|gpt-?5)\b/i;

  test("strips the backend token from worker error text but keeps the detail", () => {
    expect(scrubBackendTokens("drafter · vertex 503: model unavailable")).toBe(
      "drafter · 503: model unavailable",
    );
    expect(scrubBackendTokens("classifier · bedrock auth: expired")).toBe(
      "classifier · auth: expired",
    );
    expect(scrubBackendTokens("send · codex oauth expired")).toBe("send · oauth expired");
  });

  test("never lets a backend token through, across realistic error shapes", () => {
    for (const input of [
      "drafter · vertex 503: model unavailable",
      "classifier · bedrock auth: token expired",
      "send · codex oauth expired",
      "drafter · vertex call: ECONNRESET to aiplatform.googleapis.com",
      "Idle 14h — last error: codex oauth expired",
    ]) {
      expect(scrubBackendTokens(input)).not.toMatch(banned);
    }
  });

  test("leaves clean text and empties untouched", () => {
    expect(scrubBackendTokens("drafter · 0 rows")).toBe("drafter · 0 rows");
    expect(scrubBackendTokens("")).toBe("");
    expect(scrubBackendTokens(null)).toBe("");
  });
});
