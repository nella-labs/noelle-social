import { beforeEach, expect, test, vi } from "vitest";
import type { GuidedSignals } from "./types";

const fixture = vi.hoisted(() => ({ pending: vi.fn(), xApi: vi.fn(), signals: vi.fn(), dismissed: vi.fn() }));
vi.mock("@/lib/queries", () => ({ countPendingApprovalsAcrossAgents: fixture.pending, getXApiConnection: fixture.xApi }));
vi.mock("./dismissal", () => ({ isGuidedDismissed: fixture.dismissed }));
vi.mock("./signals", () => ({ loadGuidedSignals: fixture.signals }));
import { loadGuidedSetup } from "./load";

const empty: GuidedSignals = { vaultStage: null, hasApifyToken: false, agents: [], discoveredAny: false,
  draftedAny: false, pendingApprovals: 0, actionedAny: false, xPostingReady: false };
beforeEach(() => {
  fixture.pending.mockReset().mockResolvedValue(0);
  fixture.xApi.mockReset().mockResolvedValue({ connected: false });
  fixture.signals.mockReset().mockResolvedValue(empty);
  fixture.dismissed.mockReset().mockResolvedValue(false);
});
const load = () => loadGuidedSetup({ orgId: "org", orgSlug: "selected" });

test("known empty organization has a ready incomplete plan", async () => {
  expect(await load()).toMatchObject({ status: "ready", dismissed: false, plan: { complete: false, currentId: "data-source" } });
  expect(fixture.signals).toHaveBeenCalledExactlyOnceWith({ orgId: "org", pendingApprovals: 0, xPostingReady: false });
});
test.each(["pending", "xApi", "signals"] as const)("failed %s read is unavailable without fabricated progress", async key => {
  fixture[key].mockRejectedValue(new Error("inert progress read failed"));
  expect(await load()).toEqual({ status: "unavailable", dismissed: false });
});
test("dismissal-cookie failure keeps a healthy setup visible", async () => {
  fixture.dismissed.mockRejectedValue(new Error("inert cookie error"));
  expect(await load()).toMatchObject({ status: "ready", dismissed: false });
});
test("healthy current progress and dismissal remain authoritative", async () => {
  fixture.pending.mockResolvedValue(2); fixture.xApi.mockResolvedValue({ connected: true }); fixture.dismissed.mockResolvedValue(true);
  fixture.signals.mockResolvedValue({ ...empty, hasApifyToken: true,
    agents: [{ role: "x_intern", instanceId: "x", displayName: "Vega", status: "active", hasTargeting: true, replySendEnabled: true }],
    pendingApprovals: 2, xPostingReady: true, draftedAny: true, actionedAny: true });
  expect(await load()).toMatchObject({ status: "ready", dismissed: true, plan: { complete: true, requiredTotal: 5 } });
  expect(fixture.signals).toHaveBeenCalledExactlyOnceWith({ orgId: "org", pendingApprovals: 2, xPostingReady: true });
});
