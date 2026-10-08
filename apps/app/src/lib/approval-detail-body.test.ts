import { expect, test, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

const state = vi.hoisted(() => ({ edit: null as unknown }));
vi.mock("@/lib/queries", () => ({
  getApprovalDetail: async () => {
    const approval = { id: "approval", org_id: "org", agent_instance_id: "instance", status: "pending" };
    const draft = { payload: { kind: "dm", body: "Old DM", edited_body: state.edit } };
    return { approval, draft, lead: { platform: "x", payload: {} }, siblings: [{ approval, draft }] };
  },
  getLinkedInApprovalDetail: vi.fn(), getRedditApprovalDetail: vi.fn(),
  listPendingRedditApprovals: vi.fn(), getPersonIdForHandle: vi.fn(),
  getWatchlistPeopleForInstance: vi.fn(), getLinkedInWatchlistPeopleForInstance: vi.fn(),
  listPendingApprovalsForOrg: async () => [], listPendingLinkedInApprovals: vi.fn(),
  listAgentInstancesForOrg: async () => [], dedupeApprovalsByLead: () => [],
  keepLatestPostPerWatchlistedPerson: vi.fn(), keepLatestLinkedInPostPerPerson: vi.fn(),
}));
vi.mock("@/components/approvals/DMReviewPanel", () => ({ DMReviewPanel: function DMReviewPanel() { return null; } }));
import { DMReviewPanel } from "@/components/approvals/DMReviewPanel";
import ApprovalDetailPage from "@/app/app/[orgSlug]/approvals/[approvalId]/page";

function dmBody(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(dmBody).find((value) => value !== undefined);
  if (!isValidElement<{ body?: unknown; children?: ReactNode }>(node)) return undefined;
  return node.type === DMReviewPanel ? node.props.body : dmBody(node.props.children);
}

test.each([[null], [0], [{}], [[]], [""], ["   "]])("the actual approval page passes an empty authoritative DM edit: %j", async (edit) => {
  state.edit = edit;
  const page = await ApprovalDetailPage({
    params: Promise.resolve({ orgSlug: "org", approvalId: "approval" }), searchParams: Promise.resolve({}),
  });
  expect(dmBody(page)).toBe("");
});

test("the actual approval page preserves a valid edited DM", async () => {
  state.edit = "Confirmed DM";
  const page = await ApprovalDetailPage({
    params: Promise.resolve({ orgSlug: "org", approvalId: "approval" }), searchParams: Promise.resolve({}),
  });
  expect(dmBody(page)).toBe("Confirmed DM");
});
