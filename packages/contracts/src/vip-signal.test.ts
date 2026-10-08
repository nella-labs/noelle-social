import { describe, expect, it } from "vitest";
import { VipSignalSchema, parseVipSignal } from "./vip-signal.js";

describe("VipSignalSchema", () => {
  it("parses a full flagged signal", () => {
    const parsed = VipSignalSchema.parse({
      vip: true,
      reason: "YC W24 founder building AI devtools — high-leverage intro",
      tags: ["yc-founder", "icp"],
      add_to_watchlist: true,
      dm_soon: true,
      suggested_dm: "Saw your post on agent eval — how are you measuring it?",
    });
    expect(parsed.vip).toBe(true);
    expect(parsed.tags).toEqual(["yc-founder", "icp"]);
    expect(parsed.suggested_dm).toContain("agent eval");
  });

  it("defaults the optional fields so a minimal {vip} still parses", () => {
    const parsed = VipSignalSchema.parse({ vip: false });
    expect(parsed.reason).toBe("");
    expect(parsed.tags).toEqual([]);
    expect(parsed.add_to_watchlist).toBe(false);
    expect(parsed.dm_soon).toBe(false);
    expect(parsed.suggested_dm).toBeNull();
  });

  it("caps tags at 6 and rejects an over-long DM", () => {
    expect(
      VipSignalSchema.safeParse({ vip: true, tags: Array(7).fill("x") }).success,
    ).toBe(false);
    expect(
      VipSignalSchema.safeParse({ vip: true, suggested_dm: "x".repeat(701) })
        .success,
    ).toBe(false);
  });
});

describe("parseVipSignal", () => {
  it("returns null for absent or malformed input (fail-open)", () => {
    expect(parseVipSignal(null)).toBeNull();
    expect(parseVipSignal(undefined)).toBeNull();
    expect(parseVipSignal({ nope: true })).toBeNull();
    expect(parseVipSignal("not json")).toBeNull();
  });

  it("parses a valid object", () => {
    const sig = parseVipSignal({ vip: true, reason: "founder" });
    expect(sig?.vip).toBe(true);
    expect(sig?.reason).toBe("founder");
  });
});
