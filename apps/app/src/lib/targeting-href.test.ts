import { describe, expect, it } from "vitest";
import { targetingEditorHref } from "./targeting-href.js";

describe("targetingEditorHref", () => {
  const uuid = "11111111-1111-1111-1111-111111111111";

  it("links to the targeting editor using the real instance UUID", () => {
    expect(
      targetingEditorHref({ orgSlug: "acme", isXIntern: true, instanceId: uuid }),
    ).toBe(`/app/acme/agents/${uuid}/watchlist`);
  });

  it("returns undefined on a roster placeholder (no real instance)", () => {
    // Regression: previously the href was built from the URL slug, producing a
    // dead link that 404s in the editor. No instance → no link.
    expect(
      targetingEditorHref({ orgSlug: "acme", isXIntern: true, instanceId: null }),
    ).toBeUndefined();
    expect(
      targetingEditorHref({ orgSlug: "acme", isXIntern: true, instanceId: undefined }),
    ).toBeUndefined();
  });

  it("returns undefined for non-X-intern agents", () => {
    expect(
      targetingEditorHref({ orgSlug: "acme", isXIntern: false, instanceId: uuid }),
    ).toBeUndefined();
  });
});
