import { describe, expect, it } from "vitest";
import {
  keepLatestPostPerWatchlistedPerson,
  type PendingApprovalRow,
} from "./queries";

/**
 * Build a minimal PendingApprovalRow for the per-person collapse. Only the
 * fields the helper reads are populated (priority, author id, posted_at, the
 * draft kind); everything else is cast away.
 */
function mkRow(opts: {
  approvalId: string;
  leadId: string | null;
  priority?: boolean | null;
  authorId?: string;
  postedAt?: string;
  kind?: "reply" | "dm";
}): PendingApprovalRow {
  const { approvalId, leadId, priority, authorId, postedAt, kind } = opts;
  return {
    approval: { id: approvalId, lead_id: leadId, created_at: "2026-06-01T00:00:00Z" },
    draft: { payload: { kind: kind ?? "reply" } },
    lead:
      leadId == null
        ? null
        : {
            id: leadId,
            priority: priority ?? null,
            payload: { author_id: authorId, posted_at: postedAt },
          },
  } as unknown as PendingApprovalRow;
}

const ids = (rows: PendingApprovalRow[]) => rows.map((r) => r.approval.id);

describe("keepLatestPostPerWatchlistedPerson", () => {
  it("collapses a watched author to only their newest post, keeping all its approvals", () => {
    const rows = [
      // newest post for @ann — three reply angles + a DM (4 approval rows)
      mkRow({ approvalId: "new-1", leadId: "L2", priority: true, authorId: "ann", postedAt: "2026-06-05T10:00:00Z" }),
      mkRow({ approvalId: "new-2", leadId: "L2", priority: true, authorId: "ann", postedAt: "2026-06-05T10:00:00Z" }),
      mkRow({ approvalId: "new-dm", leadId: "L2", priority: true, authorId: "ann", postedAt: "2026-06-05T10:00:00Z", kind: "dm" }),
      // older post for the same author — should be dropped entirely
      mkRow({ approvalId: "old-1", leadId: "L1", priority: true, authorId: "ann", postedAt: "2026-06-01T10:00:00Z" }),
    ];
    expect(ids(keepLatestPostPerWatchlistedPerson(rows))).toEqual([
      "new-1",
      "new-2",
      "new-dm",
    ]);
  });

  it("leaves non-watchlisted leads fully intact even with multiple posts", () => {
    const rows = [
      mkRow({ approvalId: "a", leadId: "L1", priority: false, authorId: "bob", postedAt: "2026-06-01T00:00:00Z" }),
      mkRow({ approvalId: "b", leadId: "L2", priority: false, authorId: "bob", postedAt: "2026-06-05T00:00:00Z" }),
      mkRow({ approvalId: "c", leadId: "L3", priority: null, authorId: "bob", postedAt: "2026-06-09T00:00:00Z" }),
    ];
    expect(ids(keepLatestPostPerWatchlistedPerson(rows))).toEqual(["a", "b", "c"]);
  });

  it("keeps lead-less rows untouched", () => {
    const rows = [
      mkRow({ approvalId: "no-lead", leadId: null }),
      mkRow({ approvalId: "old", leadId: "L1", priority: true, authorId: "ann", postedAt: "2026-06-01T00:00:00Z" }),
      mkRow({ approvalId: "new", leadId: "L2", priority: true, authorId: "ann", postedAt: "2026-06-05T00:00:00Z" }),
    ];
    expect(ids(keepLatestPostPerWatchlistedPerson(rows))).toEqual(["no-lead", "new"]);
  });

  it("collapses each watched author independently", () => {
    const rows = [
      mkRow({ approvalId: "ann-old", leadId: "A1", priority: true, authorId: "ann", postedAt: "2026-06-01T00:00:00Z" }),
      mkRow({ approvalId: "ann-new", leadId: "A2", priority: true, authorId: "ann", postedAt: "2026-06-08T00:00:00Z" }),
      mkRow({ approvalId: "cid-new", leadId: "C2", priority: true, authorId: "cid", postedAt: "2026-06-09T00:00:00Z" }),
      mkRow({ approvalId: "cid-old", leadId: "C1", priority: true, authorId: "cid", postedAt: "2026-06-02T00:00:00Z" }),
    ];
    expect(ids(keepLatestPostPerWatchlistedPerson(rows))).toEqual([
      "ann-new",
      "cid-new",
    ]);
  });

  it("on missing/tied posted_at keeps whichever post sorted first", () => {
    const rows = [
      mkRow({ approvalId: "first", leadId: "L1", priority: true, authorId: "ann" }),
      mkRow({ approvalId: "second", leadId: "L2", priority: true, authorId: "ann" }),
    ];
    expect(ids(keepLatestPostPerWatchlistedPerson(rows))).toEqual(["first"]);
  });

  it("returns the input unchanged when no rows are watchlisted", () => {
    const rows = [
      mkRow({ approvalId: "a", leadId: "L1", authorId: "bob", postedAt: "2026-06-01T00:00:00Z" }),
      mkRow({ approvalId: "b", leadId: "L2", authorId: "ann", postedAt: "2026-06-05T00:00:00Z" }),
    ];
    expect(ids(keepLatestPostPerWatchlistedPerson(rows))).toEqual(["a", "b"]);
  });
});
