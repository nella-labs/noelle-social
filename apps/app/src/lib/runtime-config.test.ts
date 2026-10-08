import { describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "./runtime-config.js";

const M = "claude-opus-5";
const none = {};

describe("resolveRuntimeConfig", () => {
  it("reports the real deployment: claude subscription + chatgpt failover", () => {
    const v = resolveRuntimeConfig(none, { claudeCli: "1", codexCli: "1" }, M);
    expect(v.primary).toContain(M);
    expect(v.primary).toContain("claude subscription");
    expect(v.fallback).toContain("chatgpt");
    expect(v.escalation).toBe("budget spent → chatgpt");
    expect(v.runtime).toBe("local cli on this vm");
  });

  it("never invents a model — the old panel showed 'opus 4.7', which does not exist", () => {
    const all = Object.values(resolveRuntimeConfig(none, { claudeCli: "1", codexCli: "1" }, M)).join(" ");
    expect(all).not.toMatch(/opus 4\.7|sonnet 4\.6|residential vm/);
  });

  it("says '—' for escalation when no codex backend is wired", () => {
    const v = resolveRuntimeConfig(none, { claudeCli: "1" }, M);
    expect(v.escalation).toBe("—");
    expect(v.fallback).toContain("retry");
  });

  it("honours NOELLE_CODEX_FAILOVER=0 — wired but not escalating", () => {
    const v = resolveRuntimeConfig(none, { claudeCli: "1", codexCli: "1", codexFailover: "0" }, M);
    expect(v.escalation).toBe("—");
    // Still reachable as a routing fallback, just not on a spent budget.
    expect(v.fallback).toContain("chatgpt");
  });

  it("falls back to bedrock wording when no local CLI is wired", () => {
    const v = resolveRuntimeConfig(none, {}, M);
    expect(v.primary).toBe("bedrock");
    expect(v.runtime).toBe("bedrock api");
  });

  it("an explicit model_override still wins", () => {
    const v = resolveRuntimeConfig(
      { primary: "gemini-2-5-pro", fallback: "bedrock/claude-opus-4-6" },
      { claudeCli: "1", codexCli: "1" },
      M,
    );
    expect(v.primary).toBe("gemini-2-5-pro");
    expect(v.fallback).toBe("bedrock/claude-opus-4-6");
  });
});

import { budgetWindow } from "./runtime-config.js";

describe("budgetWindow", () => {
  it("says 'this week' and counts to Monday when the cap is weekly", () => {
    // Monday-based, matching date_trunc('week', …) — the same boundary the
    // spend query resets on, so the label cannot disagree with the cap.
    const sunday = new Date(2026, 7, 30); // Sun 2026-08-30
    expect(budgetWindow("week", sunday)).toEqual({ label: "this week", resetsInDays: 1 });
    const monday = new Date(2026, 7, 31);
    expect(budgetWindow("week", monday)).toEqual({ label: "this week", resetsInDays: 7 });
    const friday = new Date(2026, 8, 4);
    expect(budgetWindow("week", friday).resetsInDays).toBe(3);
  });

  it("falls back to the monthly wording when the period is unset", () => {
    const w = budgetWindow(undefined, new Date(2026, 7, 30));
    expect(w.label).toBe("this month");
    expect(w.resetsInDays).toBe(2); // Aug 30 -> Sep 1
  });

  it("never reports a negative countdown", () => {
    expect(budgetWindow("month", new Date(2026, 7, 31, 23, 59)).resetsInDays).toBeGreaterThanOrEqual(0);
  });
});
