import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("@/components/nav/AppLink", () => ({ AppLink: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
import { WorkspaceNav } from "./WorkspaceNav";
import { LANE_VIEWS } from "@/lib/agent-content-config";
test("draft work stays selected across channel changes and exposes secondary tools in Resources", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceNav, { orgSlug: "selected", lane: LANE_VIEWS.find(lane => lane.platform === "x")!, activeSection: "drafts", counts: { drafts: 7 } }));
  expect(html).toContain('href="/app/selected/content?board=drafts&amp;platform=linkedin"');
  expect(html).toContain('aria-label="Content sections"'); expect(html).toContain('aria-label="Content resources"');
  expect(html).toContain("Resources"); expect(html).toContain("Voice");
  expect(html).not.toContain("New</span>"); expect(html).not.toContain("Vega");
});
test("a section unsupported by the destination channel falls back to Drafts", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceNav, { orgSlug: "selected", lane: LANE_VIEWS.find(lane => lane.platform === "x")!, activeSection: "schedule" }));
  expect(html).toContain('href="/app/selected/content?board=drafts"');
  expect(html).toContain('href="/app/selected/content?board=schedule&amp;platform=linkedin"');
});
