import { describe, expect, it } from "vitest";
import { toSpeedrunLeads } from "./to-speedrun-draft.js";
import type { PendingApprovalRow } from "@/lib/queries";

// Minimal row builder: one approval+draft+lead. `kind`/`angle` shape the draft.
function row(
  approvalId: string,
  leadId: string,
  draft: { kind?: "reply" | "dm"; angle?: string; body: string; verifier_meta?: unknown; edited_body?: unknown },
  leadPayload: Record<string, unknown> = {},
): PendingApprovalRow {
  return {
    approval: { id: approvalId, lead_id: leadId, status: "pending", created_at: "2026-06-08T00:00:00Z" },
    draft: { id: `d-${approvalId}`, lead_id: leadId, payload: { kind: "reply", ...draft } },
    lead: {
      id: leadId,
      external_id: `x-${leadId}`,
      tier: "T1",
      classifier_score: 0.7,
      payload: { author_handle: leadId, post_text: `post by ${leadId}`, ...leadPayload },
    },
  } as unknown as PendingApprovalRow;
}

function leadRows(leadId: string): PendingApprovalRow[] {
  return [
    row(`${leadId}-emp`, leadId, { angle: "empathetic", body: "warm" }),
    row(`${leadId}-tec`, leadId, { angle: "technical", body: "sharp" }),
    row(`${leadId}-con`, leadId, { angle: "contrarian", body: "counter" }),
    row(`${leadId}-dm`, leadId, { kind: "dm", body: `hellooo ${leadId}` }),
  ];
}

describe("toSpeedrunLeads", () => {
  it.each([null, 0, {}, [], "", "   "])("does not revive a cleared or invalid standalone DM: %j", (edit) => {
    expect(toSpeedrunLeads([row("dm", "ada", { kind: "dm", body: "Old DM", edited_body: edit })]))
      .toEqual([]);
  });

  it("keeps the reply card while an authoritative cleared companion DM stays empty", () => {
    const [card] = toSpeedrunLeads([
      row("reply", "ada", { angle: "technical", body: "Useful reply" }),
      row("dm", "ada", { kind: "dm", body: "Old DM", edited_body: null }),
    ]);
    expect(card!.dmText).toBeNull();
    expect(card!.angles.map((angle) => angle.text)).toEqual(["Useful reply"]);
  });

  it("marks a post ready when any reply angle has a genuine passing review", () => {
    const [card] = toSpeedrunLeads([
      row("failed", "ada", { angle: "empathetic", body: "first" }, { post_id: "123" }),
      row("passed", "ada", { angle: "technical", body: "second", verifier_meta: { pass: true, judgeOk: true } }, { post_id: "123" }),
    ]);
    expect(card!.readyForActor).toBe(true);
  });

  it("collapses 4 approvals/lead into one card per lead (angles + DM together)", () => {
    const out = toSpeedrunLeads([...leadRows("alice"), ...leadRows("bob")]);
    expect(out).toHaveLength(2); // 8 approvals → 2 lead cards, not 8 rows
    const alice = out[0]!;
    expect(alice.id).toBe("alice");
    expect(alice.lead.handle).toBe("@alice");
    expect(alice.angles.map((a) => a.id)).toEqual([
      "empathetic",
      "technical",
      "contrarian",
    ]);
    expect(alice.dmText).toBe("hellooo alice");
    expect(alice.dmApprovalId).toBe("alice-dm");
  });

  it("keeps a standalone Friendly DM as an actionable DM card", () => {
    const [dm] = toSpeedrunLeads([
      row("friendly-dm", "friendly", { kind: "dm", body: "hiii, your launch story was hilarious" }, {
        post_kind: "relationship_dm",
      }),
    ]);

    expect(dm).toMatchObject({
      id: "friendly-dm",
      kind: "dm",
      dmApprovalId: "friendly-dm",
      dmText: "hiii, your launch story was hilarious",
      angles: [],
    });
  });

  it("stamps each angle with its own approvalId (so mark-sent targets the picked one)", () => {
    const [alice] = toSpeedrunLeads(leadRows("alice"));
    expect(alice!.angles.find((a) => a.id === "technical")?.approvalId).toBe("alice-tec");
    expect(alice!.angles.find((a) => a.id === "empathetic")?.approvalId).toBe("alice-emp");
  });

  it("preserves incoming lead order and the source post", () => {
    const out = toSpeedrunLeads([...leadRows("bob"), ...leadRows("alice")]);
    expect(out.map((d) => d.id)).toEqual(["bob", "alice"]);
    expect(out[0]!.sourceTweet).toBe("post by bob");
  });

  it("threads the real post permalink into postUrl (drives the ↗ X copy+open link)", () => {
    const [alice] = toSpeedrunLeads([
      row("alice-emp", "alice", { angle: "empathetic", body: "warm" }, {
        post_id: "1234567890",
      }),
    ]);
    expect(alice!.postUrl).toBe("https://x.com/alice/status/1234567890");
  });

  it("leaves postUrl null when there's no real tweet id (synthetic seed lead)", () => {
    const [alice] = toSpeedrunLeads(leadRows("alice"));
    expect(alice!.postUrl).toBeNull();
  });

  it("marks alreadyWatched from the watched-handle set (case-insensitive), so the VIP banner shows 'On watchlist ✓' after reload", () => {
    // 'alice' is on the watchlist (stored lower-case), 'bob' is not.
    const watched = new Set(["alice"]);
    const out = toSpeedrunLeads(
      [...leadRows("Alice"), ...leadRows("bob")],
      watched,
    );
    const alice = out.find((d) => d.watchlistRef === "Alice");
    const bob = out.find((d) => d.watchlistRef === "bob");
    expect(alice!.alreadyWatched).toBe(true);
    expect(bob!.alreadyWatched).toBe(false);
  });

  it("defaults alreadyWatched to false when no watched set is supplied", () => {
    const [alice] = toSpeedrunLeads(leadRows("alice"));
    expect(alice!.alreadyWatched).toBe(false);
  });
});
