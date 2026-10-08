import { describe, expect, it } from "vitest";
import { buildAngles, buildAnglesFromDrafts } from "./build-angles.js";
import type { DraftPayloadView } from "./payload-shapes.js";

const reply = (angle: string, body: string): DraftPayloadView => ({
  kind: "reply",
  angle: angle as DraftPayloadView["angle"],
  body,
});

describe("buildAngles (single draft)", () => {
  it("reads a flat single-angle draft", () => {
    const out = buildAngles(reply("technical", "sharp take"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "technical", text: "sharp take" });
  });
  it("returns [] for a DM", () => {
    expect(buildAngles({ kind: "dm", body: "hellooo" })).toEqual([]);
  });
  it("renders the selected confirmed edit and retains the untouched bundle variant", () => {
    expect(buildAngles({ angle: "technical", edited_body: "Edited", angles: { technical: { body: "Old" }, contrarian: { body: "Counterpoint" } } })
      .map(({ id, text }) => ({ id, text }))).toEqual([{ id: "technical", text: "Edited" }, { id: "contrarian", text: "Counterpoint" }]);
  });
  it.each(["", null, 0, false, {}, []])("omits an explicitly cleared or invalid selected body %j", (edit) => {
    expect(buildAngles({ angle: "technical", edited_body: edit, body: "Old", angles: { technical: { body: "Old" } } } as unknown as DraftPayloadView)).toEqual([]);
  });
  it("does not revive ambiguous legacy variants after a confirmed edit", () => {
    expect(buildAngles({ edited_body: "Edited", angles: { empathetic: { body: "Warm" }, technical: { body: "Sharp" } } })).toEqual([]);
  });
});

describe("buildAnglesFromDrafts (per-lead, across reply drafts)", () => {
  it("assembles the 3 angles from 3 separate drafts, each with its own approvalId", () => {
    const out = buildAnglesFromDrafts([
      { approvalId: "ap-emp", payload: reply("empathetic", "warm") },
      { approvalId: "ap-tech", payload: reply("technical", "sharp") },
      { approvalId: "ap-con", payload: reply("contrarian", "counter") },
    ]);
    expect(out.map((a) => a.id)).toEqual(["empathetic", "technical", "contrarian"]);
    // The critical bit: each angle carries the approval that backs it, so the
    // detail page can send/skip the *selected* angle's approval.
    expect(out.find((a) => a.id === "technical")?.approvalId).toBe("ap-tech");
    expect(out.find((a) => a.id === "empathetic")?.approvalId).toBe("ap-emp");
  });

  it("always orders empathetic → technical → contrarian regardless of input order", () => {
    const out = buildAnglesFromDrafts([
      { approvalId: "c", payload: reply("contrarian", "z") },
      { approvalId: "e", payload: reply("empathetic", "a") },
      { approvalId: "t", payload: reply("technical", "m") },
    ]);
    expect(out.map((a) => a.id)).toEqual(["empathetic", "technical", "contrarian"]);
  });

  it("dedupes a repeated angle — first draft wins", () => {
    const out = buildAnglesFromDrafts([
      { approvalId: "first", payload: reply("technical", "one") },
      { approvalId: "second", payload: reply("technical", "two") },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.approvalId).toBe("first");
    expect(out[0]?.text).toBe("one");
  });

  it("ignores DM drafts (they are not angles)", () => {
    const out = buildAnglesFromDrafts([
      { approvalId: "dm", payload: { kind: "dm", body: "hellooo" } },
      { approvalId: "rep", payload: reply("empathetic", "hi") },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("empathetic");
  });
});
