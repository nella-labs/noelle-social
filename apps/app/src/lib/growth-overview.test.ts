import { SOCIAL_AGENT_ROLES } from "@noelle/contracts";
import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ channels: vi.fn(), sent: vi.fn(), daily: vi.fn(), schedule: vi.fn(), content: vi.fn(), pendingX: vi.fn(), pendingLi: vi.fn(), pendingReddit: vi.fn(), performance: vi.fn(), membership: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "member" }) }));
vi.mock("@/lib/db", () => ({ readSql: state.content, pgOrgMembersClient: () => "guard-client" }));
vi.mock("@noelle/runtime", () => ({ assertOrgMember: state.membership }));
vi.mock("@/lib/queries", () => ({ listAgentInstancesForOrg: state.channels, getSentStatsByAgent: state.sent, getSentDaily14ByAgent: state.daily,
  countPendingApprovalsForOrg: state.pendingX, countPendingLinkedInApprovals: state.pendingLi, countPendingRedditApprovals: state.pendingReddit }));
vi.mock("@/lib/schedule-queries", () => ({ listScheduleSlotsForOrg: state.schedule, getPublishedPostPerformance: state.performance }));
import { loadGrowthOverview } from "./growth-overview";
const now = new Date("2026-10-08T18:00:00Z");
beforeEach(() => {
  vi.clearAllMocks(); state.membership.mockResolvedValue(undefined); state.channels.mockResolvedValue([{ id: "x", role: "x_intern" }, { id: "li", role: "linkedin_intern" }, { id: "rd", role: "reddit_intern" }]);
  state.sent.mockResolvedValue({}); state.daily.mockResolvedValue([]); state.schedule.mockResolvedValue([]);
  state.content.mockResolvedValue([{ ideas: 3, drafts: 2, ready: 1 }]); state.pendingX.mockResolvedValue(4); state.pendingLi.mockResolvedValue(2); state.pendingReddit.mockResolvedValue(1); state.performance.mockResolvedValue({ posts: [] });
});
test("uses actual social query owners and a bounded UTC upcoming window", async () => {
  const data = await loadGrowthOverview("org", now);
  expect(state.membership).toHaveBeenCalledWith("guard-client", "member", "org");
  expect(state.schedule).toHaveBeenCalledWith("org", { from: "2026-10-08T18:00:00.000Z", to: "2026-10-15T18:00:00.000Z" });
  expect(state.pendingLi).toHaveBeenCalledWith("li"); expect(state.pendingReddit).toHaveBeenCalledWith("rd");
  expect(state.performance).toHaveBeenCalledWith("org", "x");
  expect(state.content.mock.calls[0]?.slice(1)).toEqual(["org", [...SOCIAL_AGENT_ROLES], "org", [...SOCIAL_AGENT_ROLES]]);
  expect(data.pending).toEqual({ status: "ready", value: 7 }); expect(data.content).toEqual({ status: "ready", value: { ideas: 3, drafts: 2, ready: 1 } });
});
test("failed counters and membership stay unavailable instead of becoming zero", async () => {
  state.pendingLi.mockRejectedValue(new Error("offline")); state.membership.mockRejectedValue(new Error("forbidden"));
  const data = await loadGrowthOverview("org", now);
  expect(data.pending).toEqual({ status: "unavailable" }); expect(data.content).toEqual({ status: "unavailable" }); expect(state.content).not.toHaveBeenCalled();
});
test("unavailable channels do not silently omit another platform's queues", async () => {
  state.channels.mockRejectedValue(new Error("offline")); const data = await loadGrowthOverview("org", now);
  expect(data.pending).toEqual({ status: "unavailable" }); expect(data.performance).toEqual({ status: "unavailable" }); expect(state.pendingX).not.toHaveBeenCalled(); expect(state.performance).not.toHaveBeenCalled();
});
