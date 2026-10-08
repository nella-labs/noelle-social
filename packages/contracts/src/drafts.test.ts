import { describe, expect, it } from "vitest";
import { ApprovalStatusSchema } from "./common.js";
import { DraftParkInSchema, DraftParkOutSchema } from "./drafts.js";

describe("parked-DM contracts", () => {
  it("ApprovalStatusSchema includes 'deferred' (parked DM)", () => {
    expect(ApprovalStatusSchema.safeParse("deferred").success).toBe(true);
  });

  it("DraftParkInSchema accepts an empty body", () => {
    expect(DraftParkInSchema.safeParse({}).success).toBe(true);
  });

  it("DraftParkOutSchema validates a deferred result", () => {
    const r = DraftParkOutSchema.safeParse({
      approval_id: "00000000-0000-0000-0000-000000000000",
      status: "deferred",
    });
    expect(r.success).toBe(true);
  });

  it("DraftParkOutSchema rejects an unknown status", () => {
    const r = DraftParkOutSchema.safeParse({
      approval_id: "00000000-0000-0000-0000-000000000000",
      status: "parked",
    });
    expect(r.success).toBe(false);
  });
});
