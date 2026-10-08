import { describe, expect, it } from "vitest";
import { pinnedVegaStyleConfig } from "./vega-style.js";

describe("pinnedVegaStyleConfig", () => {
  it("does not materialize the default post corpus as an explicit choice", () => {
    expect(pinnedVegaStyleConfig({ maxStyleExemplars: 3 }, "Eliana_Jordan")).toEqual(
      expect.not.objectContaining({ styleExemplarKinds: expect.anything() }),
    );
  });

  it("preserves an explicit corpus choice", () => {
    expect(pinnedVegaStyleConfig({ styleExemplarKinds: ["post"] }, "Eliana_Jordan"))
      .toEqual(expect.objectContaining({ styleExemplarKinds: ["post"] }));
  });
});
