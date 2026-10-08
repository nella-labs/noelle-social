import { describe, it, expect } from "vitest";
import { X_COMMUNITIES, communityForVariant } from "./x-communities.js";
import { buildXPostSystem } from "./post-drafter.js";

describe("communityForVariant", () => {
  it("returns a distinct community per index, cycling", () => {
    const c0 = communityForVariant(0);
    const c1 = communityForVariant(1);
    const c2 = communityForVariant(2);
    expect(c0?.name).toBe(X_COMMUNITIES[0]!.name);
    expect(c1?.name).toBe(X_COMMUNITIES[1]!.name);
    expect(c2?.name).toBe(X_COMMUNITIES[2]!.name);
    // wraps around
    expect(communityForVariant(X_COMMUNITIES.length)?.name).toBe(X_COMMUNITIES[0]!.name);
  });
  it("returns null when the list is empty", () => {
    expect(communityForVariant(0, [])).toBeNull();
  });
});

describe("buildXPostSystem community framing", () => {
  it("injects the community frame when given", () => {
    const sys = buildXPostSystem(null, null, undefined, null, { name: "Build in Public", desc: "founders shipping in the open." });
    expect(sys).toContain('FRAME THIS POST FOR THE "Build in Public" community');
    expect(sys).toContain("founders shipping in the open.");
    expect(sys).toContain("SAME core idea");
  });
  it("is byte-identical to no-community when none is given", () => {
    const withNull = buildXPostSystem(null, null, undefined, null, null);
    const without = buildXPostSystem(null, null, undefined, null);
    expect(withNull).toBe(without);
    expect(withNull).not.toContain("FRAME THIS POST FOR THE");
  });
});
