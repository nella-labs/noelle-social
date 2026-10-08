// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DEFAULTS, resolveTweaks, THEME_BOOTSTRAP } from "./theme-preferences";

describe("workspace appearance", () => {
  it("preserves mode and discards obsolete company-layout and color preferences", () => {
    expect(resolveTweaks(JSON.stringify({ theme: "dark", density: "compact", orgLayout: "tree", accent: "#B85B3A" }), DEFAULTS)).toEqual({ theme: "dark" });
  });

  it.each(["broken", "null", "[]", '{"theme":"broken"}'])("falls back safely for %s", (raw) => {
    expect(resolveTweaks(raw, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("uses the same mode before hydration and clears stale inline colors", () => {
    const storage = { getItem: () => JSON.stringify({ theme: "dark", accent: "#087F8C" }) };
    document.documentElement.style.setProperty("--accent", "#087F8C");
    new Function("document", "localStorage", THEME_BOOTSTRAP)(document, storage);
    expect(document.documentElement.dataset).toMatchObject({ theme: "dark", type: "grotesk", density: "regular" });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("");
  });
});
