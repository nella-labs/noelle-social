// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PatternRulesPage } from "@noelle/contracts";

const queries = vi.hoisted(() => ({
  getOrgBySlug: vi.fn(),
  getAgentInstance: vi.fn(),
  listAgentInstancesForOrg: vi.fn(),
  listPatternRules: vi.fn(),
  listVisiblePatternAlerts: vi.fn(),
}));
vi.mock("@/lib/queries", () => queries);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
}));
vi.mock("@/components/nav/AppLink", () => ({
  AppLink: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));
vi.mock("./actions", () => ({ setPatternRuleActive: vi.fn() }));
import PatternsPage from "./page";
const instance = "00000000-0000-4000-8000-000000000011";
const id = "00000000-0000-4000-8000-000000000031";
const cursor = {
  section: "active" as const,
  active: true,
  severity: "high" as const,
  createdAt: "2026-10-01T00:00:00.123456Z",
  id,
};
const empty: PatternRulesPage = {
  rules: [],
  total: 0,
  nextCursor: null,
  counts: { active: 0, disabled: 0, malformedActive: 0 },
};
const rule = {
  id,
  kind: "structure" as const,
  label: "stock closer",
  instruction: "Use a concrete detail",
  suggestion: null,
  regex: null,
  severity: "high" as const,
  active: true,
  source: "manual" as const,
  created_at: cursor.createdAt,
  updated_at: cursor.createdAt,
  admitted: true,
};
async function render(searchParams = {}) {
  document.body.innerHTML = renderToStaticMarkup(
    await PatternsPage({
      params: Promise.resolve({ orgSlug: "one", instanceId: instance }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
  return document.body.textContent ?? "";
}
beforeEach(() => {
  vi.clearAllMocks();
  queries.getOrgBySlug.mockResolvedValue({ id: "org", name: "One" });
  queries.getAgentInstance.mockResolvedValue({ id: instance, org_id: "org", display_name: "Vega" });
  queries.listPatternRules.mockResolvedValue(empty);
  queries.listVisiblePatternAlerts.mockResolvedValue({ alerts: [], total: 0, nextCursor: null });
});

describe("bounded pattern management", () => {
  it("shows verified empty pages without an unavailable or held state", async () => {
    const text = await render();
    expect(text).toContain("No active rules in this verified page");
    expect(text).not.toContain("Rules are unavailable");
    expect(text).not.toContain("Drafting is held");
    expect(queries.listPatternRules).toHaveBeenCalledWith(instance, {
      section: "active",
      limit: 50,
    });
  });
  it("distinguishes unavailable active rules and history from measured empty", async () => {
    queries.listPatternRules.mockRejectedValue(new Error("unavailable"));
    queries.listVisiblePatternAlerts.mockRejectedValue(new Error("unavailable"));
    const text = await render();
    expect(text).toContain("Rules are unavailable");
    expect(text).toContain("Alert history is unavailable");
    expect(text).not.toContain("No active rules in this verified page");
  });
  it("shows overflow and bounded continuation without hiding later rules", async () => {
    queries.listPatternRules.mockImplementation(async (_id, input) =>
      input.section === "active"
        ? {
            ...empty,
            rules: [rule],
            total: 126,
            counts: { active: 126, disabled: 0, malformedActive: 0 },
            nextCursor: cursor,
          }
        : empty,
    );
    const text = await render({
      disabledCursor: JSON.stringify({ ...cursor, section: "disabled", active: false }),
    });
    expect(text).toContain("Active rules · 126");
    expect(text).toContain("Drafting is held");
    const next = [...document.querySelectorAll("a")].find(
      (node) => node.textContent === "Next active rules",
    )!;
    const params = new URL(next.href).searchParams;
    expect(JSON.parse(params.get("activeCursor")!)).toEqual(cursor);
    expect(params.get("disabledCursor")).toBeTruthy();
  });
  it("keeps invalid rules visible with the existing disable control", async () => {
    queries.listPatternRules.mockImplementation(async (_id, input) =>
      input.section === "active"
        ? {
            ...empty,
            rules: [{ ...rule, admitted: false }],
            total: 1,
            counts: { active: 1, disabled: 0, malformedActive: 1 },
          }
        : empty,
    );
    const text = await render();
    expect(text).toContain("This rule cannot be applied");
    expect(document.querySelector('button[aria-pressed="true"]')).not.toBeNull();
    expect(document.querySelector("button")?.title).toContain("complete valid rule set");
  });
  it("renders terminal history with observed sample labels and explicit next page", async () => {
    queries.listVisiblePatternAlerts.mockResolvedValue({
      total: 51,
      nextCursor: {
        view: "history",
        createdAt: cursor.createdAt,
        id,
      },
      alerts: [
        {
          id,
          status: "acknowledged",
          pattern_name: "stock closer",
          description: "A repeated closer",
          frequency_count: 4,
          window_size: 10,
          examples: [{ snippet: "A source excerpt" }],
        },
      ],
    });
    const text = await render();
    expect(text).toContain("acknowledged");
    expect(text).toContain("4 of 10 posts in the observed sample");
    expect(text).toContain("Pattern alert history · 51");
    expect(
      [...document.querySelectorAll("a")].some((node) => node.textContent === "Next alerts"),
    ).toBe(true);
  });
  it("rejects malformed transport cursors without dispatching that section's read", async () => {
    const text = await render({ activeCursor: "x".repeat(513) });
    expect(text).toContain("Rules are unavailable");
    expect(queries.listPatternRules).toHaveBeenCalledTimes(1);
    expect(queries.listPatternRules).toHaveBeenCalledWith(instance, {
      section: "disabled",
      limit: 50,
    });
  });
});
