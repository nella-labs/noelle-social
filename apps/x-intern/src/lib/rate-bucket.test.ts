import { describe, expect, it } from "vitest";
import { createRateBucket } from "./rate-bucket.js";

describe("rate-bucket", () => {
  it("permits up to N requests then forces a wait", async () => {
    let t = 0;
    const bucket = createRateBucket({ tokens: 2, windowMs: 1000, now: () => t });
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    t = 1100;
    expect(bucket.tryTake()).toBe(true);
  });
});
