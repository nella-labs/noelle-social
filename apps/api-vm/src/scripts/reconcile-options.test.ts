import { describe, expect, it } from "vitest";
import { parseReconcileOptions, resolveXReplyMaxAgeHours } from "./reconcile-options.js";

describe("pending reply reconciliation options", () => {
  const orgId = "11111111-1111-4111-8111-111111111111";

  it("defaults to a dry run and requires a tenant UUID", () => {
    expect(parseReconcileOptions(["--org-id", orgId])).toEqual({ orgId, apply: false });
    expect(() => parseReconcileOptions([])).toThrow("--org-id must be a UUID");
  });

  it("requires the explicit apply switch for mutations", () => {
    expect(parseReconcileOptions(["--apply", "--org-id", orgId])).toEqual({ orgId, apply: true });
    expect(() => parseReconcileOptions(["--org-id", orgId, "--wat"])).toThrow("unknown option");
  });

  it("matches the actor's X age policy defaults", () => {
    expect(resolveXReplyMaxAgeHours(undefined)).toBe(25);
    expect(resolveXReplyMaxAgeHours("garbage")).toBe(25);
    expect(resolveXReplyMaxAgeHours("0")).toBe(0);
    expect(resolveXReplyMaxAgeHours("48")).toBe(48);
  });
  it.each(["", " ", "\t"])("keeps the default expiry for blank configuration %j", raw => {
    expect(resolveXReplyMaxAgeHours(raw)).toBe(25);
  });
});
