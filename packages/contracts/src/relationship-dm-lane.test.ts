import { describe, expect, it } from "vitest";
import { isRelationshipDmEnabled } from "./lane-config.js";

describe("independent Friendly DM lane", () => {
  it.each(["active", "paused"])("uses its own switch while the reply pipeline is %s", (status) => {
    expect(isRelationshipDmEnabled(status, {
      replies: { enabled: false },
      dms: { enabled: false, intro_dms_enabled: false, relationship_dms_enabled: true },
    })).toBe(true);
    expect(isRelationshipDmEnabled(status, {
      replies: { enabled: true },
      dms: { enabled: true, relationship_dms_enabled: false },
    })).toBe(false);
  });

  it.each([undefined, null, "provisioning", "retired", "errored"])("does not admit an unavailable agent (%s)", (status) => {
    expect(isRelationshipDmEnabled(status, { dms: { relationship_dms_enabled: true } })).toBe(false);
  });

  it.each([undefined, {}, { dms: { relationship_dms_enabled: "true" } }])("defaults missing or invalid configuration to off", (config) => {
    expect(isRelationshipDmEnabled("paused", config)).toBe(false);
  });
});
