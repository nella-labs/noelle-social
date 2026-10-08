import { describe, expect, it } from "vitest";
import { OutboundDraftInSchema } from "./outbound.js";

describe("DM-specific writing checks", () => {
  const dm = { id: "dm", kind: "dm", angle: null, body: "so real", charCount: 7 };

  it("retains the result for the actual DM body", () => {
    const dmVoiceCheck = { pass: true, attempts: 1, reasons: [] };
    expect(OutboundDraftInSchema.parse({ ...dm, dmVoiceCheck })).toMatchObject({ dmVoiceCheck });
  });

  it("rejects an invalid retry count", () => {
    expect(OutboundDraftInSchema.safeParse({
      ...dm, dmVoiceCheck: { pass: true, attempts: -1, reasons: [] },
    }).success).toBe(false);
  });
});
