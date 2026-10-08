import { describe, expect, it } from "vitest";
import { qualityGate } from "./quality-gate.js";

describe("qualityGate", () => {
  it("returns a numeric score 0..100", async () => {
    const res = await qualityGate({
      postText: "anyone using AI agents for outbound?",
      draftText: "yeah Nella threads agent context across sessions",
    });
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(100);
  });
  it("penalises off-topic drafts", async () => {
    const onTopic = await qualityGate({
      postText: "anyone using AI agents for outbound?",
      draftText: "yeah, agents work great for outbound",
    });
    const offTopic = await qualityGate({
      postText: "anyone using AI agents for outbound?",
      draftText: "have you tried mountain climbing instead",
    });
    expect(onTopic.score).toBeGreaterThan(offTopic.score);
  });
});
