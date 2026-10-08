import { describe, it, expect } from "vitest";
import { AccountFeederConfigSchema } from "./account-feeder.js";

describe("AccountFeederConfigSchema.styleExemplarKinds", () => {
  it("defaults to posts-only for an empty config", () => {
    const cfg = AccountFeederConfigSchema.parse({});
    expect(cfg.styleExemplarKinds).toEqual(["post"]);
  });

  it("preserves the other defaults alongside the new knob", () => {
    const cfg = AccountFeederConfigSchema.parse({});
    expect(cfg.maxStyleExemplars).toBe(1);
    expect(cfg.batchLightLeads).toBe(true);
    expect(cfg.styleExemplarKinds).toEqual(["post"]);
  });

  it("accepts an explicit posts + comments selection", () => {
    const cfg = AccountFeederConfigSchema.parse({ styleExemplarKinds: ["post", "comment"] });
    expect(cfg.styleExemplarKinds).toEqual(["post", "comment"]);
  });

  it("accepts comments-only", () => {
    const cfg = AccountFeederConfigSchema.parse({ styleExemplarKinds: ["comment"] });
    expect(cfg.styleExemplarKinds).toEqual(["comment"]);
  });

  it("rejects an empty kinds array", () => {
    expect(() => AccountFeederConfigSchema.parse({ styleExemplarKinds: [] })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => AccountFeederConfigSchema.parse({ styleExemplarKinds: ["repost"] })).toThrow();
  });

  it("stays strict — an unknown top-level key is rejected", () => {
    expect(() => AccountFeederConfigSchema.parse({ notAKey: 1 })).toThrow();
  });
});
