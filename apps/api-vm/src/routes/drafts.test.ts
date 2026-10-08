import { describe, it, expect } from "vitest";
import { DraftMarkSentInSchema } from "@noelle/contracts";

describe("DraftMarkSentInSchema", () => {
  it("accepts sent_via=extension", () => {
    const p = DraftMarkSentInSchema.parse({ sent_via: "extension" });
    expect(p.sent_via).toBe("extension");
  });
  it("defaults to undefined sent_via (handler falls back to manual)", () => {
    const p = DraftMarkSentInSchema.parse({});
    expect(p.sent_via).toBeUndefined();
  });
});
