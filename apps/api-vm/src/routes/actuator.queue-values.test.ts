import { describe, expect, it } from "vitest";
import { buildActionable, buildActionableX, buildActionableReddit, bodyHasExternalLink, type XJoinedRow } from "./actuator.js";

const x: XJoinedRow = {
  approval_id: "a", draft_id: "d", lead_id: "l", external_id: "123",
  author_handle: "example", auto_send_target_at: null,
  lead_payload: { authorName: "Example" },
  draft_payload: { body: "supported reply", verifier_meta: { pass: true, judgeOk: true, scores: { voice: 1, grounding: 1, relevance: 1, format: 1 } } },
};
describe("actionable queue input boundaries", () => {
  it.each([true, 42, {}])("omits a malformed body and preserves other usable X rows: %s", body => {
    expect(buildActionableX([{ ...x, draft_payload: { ...x.draft_payload, body: body as never } }, x]).replies).toHaveLength(1);
  });
  it("does not fall back to unedited text when an explicit edit is malformed", () => {
    expect(buildActionableX([{ ...x, draft_payload: { ...x.draft_payload, edited_body: false as never } }]).replies).toHaveLength(0);
  });
  it.each(["0", "000", "9".repeat(26), "bad", 0])("omits an unusable target identity: %s", external_id => {
    expect(buildActionableX([{ ...x, external_id: external_id as never }]).replies).toHaveLength(0);
  });
  it("uses a numeric permalink when optional author fields are malformed", () => {
    const result = buildActionableX([{ ...x, author_handle: {} as never, lead_payload: { authorName: [] as never } }]);
    expect(result.replies[0]?.target).toMatchObject({ url: "https://x.com/i/status/123", author_handle: null, author_name: null });
  });
  it("omits malformed bodies across all browser queues", () => {
    const malformed = { body: {} } as never;
    expect(buildActionable([{ ...x, draft_payload: malformed, lead_payload: null, author_id: null, wp_name: null }]).comments).toHaveLength(0);
    expect(buildActionableReddit([{ ...x, draft_payload: malformed, lead_payload: null }]).replies).toHaveLength(0);
  });
  it("applies the shared bare-domain and obfuscated-domain policy", () => {
    expect(bodyHasExternalLink("details at example[.]com")).toBe(true);
    expect(bodyHasExternalLink("details at example.com")).toBe(true);
    expect(bodyHasExternalLink("thread https://x.com/example/status/123")).toBe(false);
  });
});
