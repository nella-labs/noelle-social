import { describe, expect, it } from "vitest";
import {
  keepLatestLinkedInPostPerPerson,
  type LinkedInApprovalView,
} from "./queries";

/** Minimal LinkedInApprovalView — only the fields the collapse reads. */
function mkView(opts: {
  approvalId: string;
  publicId?: string | null;
  name?: string | null;
  postedAt?: string | null;
  createdAt?: string;
}): LinkedInApprovalView {
  return {
    approvalId: opts.approvalId,
    status: "pending",
    createdAt: opts.createdAt ?? "2026-06-01T00:00:00Z",
    kind: "reply",
    authorName: opts.name ?? "A connection",
    authorHeadline: null,
    authorPublicId: opts.publicId ?? null,
    profileUrl: null,
    postText: `post ${opts.approvalId}`,
    postUrl: null,
    postedAt: opts.postedAt ?? null,
    body: "draft body",
    angle: "empathetic",
    charCount: 10,
    styleSource: null,
  };
}

const ids = (v: LinkedInApprovalView[]) => v.map((x) => x.approvalId);

describe("keepLatestLinkedInPostPerPerson", () => {
  it("keeps only the newest post per person", () => {
    const views = [
      mkView({ approvalId: "ann-old", publicId: "ann", postedAt: "2026-06-01T00:00:00Z" }),
      mkView({ approvalId: "ann-new", publicId: "ann", postedAt: "2026-06-07T00:00:00Z" }),
      mkView({ approvalId: "bob", publicId: "bob", postedAt: "2026-06-03T00:00:00Z" }),
    ];
    expect(ids(keepLatestLinkedInPostPerPerson(views))).toEqual(["ann-new", "bob"]);
  });

  it("falls back to createdAt when posted_at is missing", () => {
    const views = [
      mkView({ approvalId: "old", publicId: "ann", createdAt: "2026-06-01T00:00:00Z" }),
      mkView({ approvalId: "new", publicId: "ann", createdAt: "2026-06-09T00:00:00Z" }),
    ];
    expect(ids(keepLatestLinkedInPostPerPerson(views))).toEqual(["new"]);
  });

  it("keys on display name when public id is absent", () => {
    const views = [
      mkView({ approvalId: "a1", publicId: null, name: "Dana", postedAt: "2026-06-02T00:00:00Z" }),
      mkView({ approvalId: "a2", publicId: null, name: "Dana", postedAt: "2026-06-06T00:00:00Z" }),
    ];
    expect(ids(keepLatestLinkedInPostPerPerson(views))).toEqual(["a2"]);
  });

  it("keeps identity-less views and on ties keeps the first", () => {
    const views = [
      mkView({ approvalId: "anon", publicId: null, name: null }),
      mkView({ approvalId: "tie-1", publicId: "ann", postedAt: "2026-06-05T00:00:00Z" }),
      mkView({ approvalId: "tie-2", publicId: "ann", postedAt: "2026-06-05T00:00:00Z" }),
    ];
    expect(ids(keepLatestLinkedInPostPerPerson(views))).toEqual(["anon", "tie-1"]);
  });
});
