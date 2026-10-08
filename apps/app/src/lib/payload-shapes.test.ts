import { describe, expect, it } from "vitest";
import { bodyForAngle, leadPayload } from "./payload-shapes.js";
import type { DraftPayloadView } from "./payload-shapes.js";
import type { NoelleLead } from "@/lib/db-types";

function lead(
  payload: Record<string, unknown>,
  external_id: string | null = null,
): NoelleLead {
  return { payload, external_id } as unknown as NoelleLead;
}

describe("leadPayload — producer-key aliasing", () => {
  it("surfaces post text from original_post_text (the real producer key)", () => {
    // This is the actual shape the outbound route writes onto a drafted lead.
    const lp = leadPayload(
      lead({
        author_handle: "eng_khairallah1",
        original_post_id: "2063182000656351580",
        original_post_text: "agents keep hallucinating imports in my repo",
        original_post_url: "https://x.com/eng_khairallah1/status/2063182000656351580",
        matched_trigger: "hallucinating imports",
      }),
    );
    expect(lp.post_text).toBe("agents keep hallucinating imports in my repo");
    expect(lp.originalPostUrl).toBe(
      "https://x.com/eng_khairallah1/status/2063182000656351580",
    );
    expect(lp.matched_trigger_id).toBe("hallucinating imports");
  });

  it("derives the x.com URL from original_post_id when no url present", () => {
    const lp = leadPayload(
      lead({ author_handle: "bob", original_post_id: "999", original_post_text: "hi" }),
    );
    expect(lp.post_text).toBe("hi");
    expect(lp.originalPostUrl).toBe("https://x.com/bob/status/999");
  });

  it("still honors the legacy post_text/post_id shape", () => {
    const lp = leadPayload(lead({ author_handle: "x", post_id: "1", post_text: "legacy" }));
    expect(lp.post_text).toBe("legacy");
    expect(lp.originalPostUrl).toBe("https://x.com/x/status/1");
  });

  it("passes anchors through for the Context-loaded card", () => {
    const lp = leadPayload(
      lead({ original_post_text: "p", anchors: [{ snippet: "ship small", score: 4.2 }] }),
    );
    expect(lp.anchors).toEqual([{ snippet: "ship small", score: 4.2 }]);
  });

  it("returns {} for a null payload", () => {
    expect(leadPayload(null)).toEqual({});
  });
});

describe("leadPayload — external_id fallback for the post link", () => {
  it("falls back to leads.external_id when post_id isn't synced", () => {
    // The common 0.0.1 case: drafter never writes post_id, but external_id holds
    // the real tweet id. Previously this produced no link at all.
    const lp = leadPayload(lead({ author_handle: "jane" }, "222"));
    expect(lp.originalPostUrl).toBe("https://x.com/jane/status/222");
  });

  it("produces no link for a synthetic external_id", () => {
    const lp = leadPayload(lead({ author_handle: "jane" }, "synthetic-abc"));
    expect(lp.originalPostUrl).toBeUndefined();
  });

  it("links via /i when there is a tweet id but no handle", () => {
    const lp = leadPayload(lead({}, "333"));
    expect(lp.originalPostUrl).toBe("https://x.com/i/status/333");
  });
});

describe("bodyForAngle — authoritative edits", () => {
  const bundle = { angle: "technical", angles: { technical: { body: "Old technical" }, contrarian: { body: "Original counterpoint" } }, body: "Old flat" } as DraftPayloadView;
  it("uses the selected angle's confirmed edit without changing another angle", () => {
    const payload = { ...bundle, edited_body: "Confirmed technical edit" };
    expect(bodyForAngle(payload, "technical")).toBe("Confirmed technical edit");
    expect(bodyForAngle(payload, "contrarian")).toBe("Original counterpoint");
  });
  it.each(["", null, 0, false, {}, []])("does not revive the affected angle after an explicit cleared or invalid edit %j", (edit) => {
    const payload = { ...bundle, edited_body: edit } as unknown as DraftPayloadView;
    expect(bodyForAngle(payload, "technical")).toBeUndefined();
    expect(bodyForAngle(payload, "contrarian")).toBe("Original counterpoint");
  });
  it("keeps each unedited legacy bundle variant", () => {
    expect(bodyForAngle({ angles: bundle.angles }, "technical")).toBe("Old technical");
    expect(bodyForAngle({ angles: bundle.angles }, "contrarian")).toBe("Original counterpoint");
  });
  it("does not assign an angle-ambiguous legacy edit to every original variant", () => {
    const payload = { angles: bundle.angles, edited_body: "Confirmed edit with unknown angle" };
    expect(bodyForAngle(payload, "technical")).toBeUndefined();
    expect(bodyForAngle(payload, "contrarian")).toBeUndefined();
  });
  it("can associate an edit with the unique legacy bundled angle", () => {
    expect(bodyForAngle({ angles: { technical: { body: "Old" } }, edited_body: "Edited" }, "technical")).toBe("Edited");
    expect(bodyForAngle({ angles: { technical: { body: "Old" } }, edited_body: "Edited" }, "contrarian")).toBeUndefined();
  });
  it.each([0, {}, []])("does not expose non-text original bundled or flat body %j", (body) => {
    expect(bodyForAngle({ angle: "technical", body, angles: { technical: { body } } } as unknown as DraftPayloadView, "technical")).toBeUndefined();
  });
});
