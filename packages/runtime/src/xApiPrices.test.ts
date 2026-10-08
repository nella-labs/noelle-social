import { describe, expect, it } from "vitest";
import { xApiActionRow } from "./xApiPrices";

describe("xApiActionRow", () => {
  const base = { orgId: "o1", instanceId: "i1", startedAt: new Date("2026-06-30T00:00:00Z") };

  it("meters a post write under engine 'xapi' with zero per-call cents", () => {
    const row = xApiActionRow({ ...base, worker: "content-publish", kind: "post" });
    expect(row.engine).toBe("xapi");
    expect(row.bucket).toBe("xapi-post");
    expect(row.cents).toBe(0); // X API bills a flat monthly tier — metered separately
    expect(row.agentRole).toBe("x_intern");
    expect(row.model).toBe("xapi");
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
    expect(row.status).toBe("ok");
  });

  it("meters a reply write under bucket xapi-reply", () => {
    const row = xApiActionRow({ ...base, worker: "send", kind: "reply", latencyMs: 412 });
    expect(row.bucket).toBe("xapi-reply");
    expect(row.cents).toBe(0);
    expect(row.latencyMs).toBe(412);
  });
});
