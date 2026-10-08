import { describe, expect, it } from "vitest";
import { withinActiveHours } from "./cadence.js";

// Reddit reads go through Apify (no login to protect), so Orion runs 24/7 — the
// active-hours gate is a no-op that always returns true.
describe("withinActiveHours", () => {
  it("always returns true (Reddit runs 24/7)", () => {
    expect(withinActiveHours()).toBe(true);
  });
});
