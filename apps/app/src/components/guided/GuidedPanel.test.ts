import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { buildGuidedPlan } from "@/lib/guided/plan";

vi.mock("./DismissGuided", () => ({ DismissGuided: ({ label }: { label: string }) => createElement("button", {}, label) }));
vi.mock("@/components/nav/AppLink", () => ({ AppLink: ({ children, ...props }: { children: ReactNode }) => createElement("a", props, children) }));
const fixture = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/guided/load", () => ({ loadGuidedSetup: fixture.load }));
vi.mock("@/lib/queries", () => ({
  getOrgBySlug: async () => ({ id: "org", name: "Selected", slug: "selected" }),
  getCurrentUser: async () => null, listAgentInstancesForOrg: async () => [],
  countPendingApprovalsForOrg: async () => 0, countSentApprovalsForOrg: async () => 0,
  countActionedApprovalsForOrg: async () => 0, getLastSyncRun: async () => null,
  getOrgSpendForMonth: async () => [], listActiveWorkers: async () => new Set(),
  getCapStatusForXIntern: async () => null, listRecentActivityForInstance: async () => [],
  isApifyBucket: () => false,
}));
import { GuidedPanel } from "./GuidedPanel";
import GuidedSetupPage from "@/app/app/[orgSlug]/onboarding/page";
const plan = buildGuidedPlan({ vaultStage: null, hasApifyToken: false, agents: [], discoveredAny: false,
  draftedAny: false, pendingApprovals: 0, actionedAny: false, xPostingReady: false }, "selected");
beforeEach(() => { fixture.load.mockReset().mockResolvedValue({ status: "ready", plan, dismissed: false }); });
test("known empty setup retains its actual five-step progress", () => {
  const html = renderToStaticMarkup(createElement(GuidedPanel, { orgSlug: "selected", status: "ready", plan, dismissed: false }));
  expect(html).toContain("0 of 5"); expect(html).toContain("Add an Apify token"); expect(html).toContain('role="progressbar"');
});
test("onboarding composes the shared unavailable panel", async () => {
  fixture.load.mockResolvedValue({ status: "unavailable", dismissed: false });
  const html = renderToStaticMarkup(await GuidedSetupPage({ params: Promise.resolve({ orgSlug: "selected" }) }));
  expect(html).toMatch(/Setup is.*unavailable/i); expect(html).not.toContain('role="progressbar"');
  expect(fixture.load).toHaveBeenCalledExactlyOnceWith({ orgId: "org", orgSlug: "selected" });
});
test.each(["hero", "page"] as const)("unavailable %s has no fabricated progress or empty-org instruction", variant => {
  const html = renderToStaticMarkup(createElement(GuidedPanel, { orgSlug: "selected", status: "unavailable", dismissed: false, variant }));
  expect(html).toMatch(/setup.*unavailable/i); expect(html).not.toContain('role="progressbar"'); expect(html).not.toContain("Add an Apify token"); expect(html).not.toContain("running");
});
