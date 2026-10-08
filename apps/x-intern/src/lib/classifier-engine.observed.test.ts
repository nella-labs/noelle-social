import { describe, expect, it, vi } from "vitest";
import { createClassifier } from "./classifier-engine.js";

const input = {
  postText: "We changed our onboarding after users showed us where they got stuck",
  authorHandle: "builder",
  source: "x" as const,
  velocityAtDiscovery: 0,
};

function setup(choice: string, probability: number, threshold = 75) {
  const call = vi.fn();
  const evaluate = vi.fn().mockResolvedValue({
    kind: "choice", choice, probability,
    probabilities: { substantial: choice === "substantial" ? probability : 0.04,
      light: choice === "light" ? probability : 0.04,
      skip: choice === "skip" ? probability : 0.04 },
    provider: "jev",
  });
  const classifier = createClassifier({ backend: { call } as never, evaluate, vipScout: true });
  return { classifier, call, evaluate, threshold };
}

describe("strict X browser observation qualification", () => {
  it.each(["substantial", "light"])("rejects %s below the instance threshold", async (kind) => {
    const { classifier, call } = setup(kind, 0.85, 90);
    expect(await classifier.classifyObserved(input, 90)).toMatchObject({
      on_brand: false, reply_kind: "skip", q: 85,
      raw: { judge: "jev", choice: kind },
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("accepts a light category above both floors with its actual Jev score", async () => {
    const { classifier } = setup("light", 0.91);
    expect(await classifier.classifyObserved(input, 90)).toMatchObject({
      on_brand: true, reply_kind: "light", q: 91, tier: null,
    });
  });

  it("accepts a Jev category below 0.8 when it clears the instance threshold", async () => {
    const { classifier, call } = setup("substantial", 0.79);
    expect(await classifier.classifyObserved(input, 30)).toMatchObject({
      on_brand: true, reply_kind: "substantial", q: 79,
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("still rejects an explicit skip even above the instance threshold", async () => {
    const { classifier, call } = setup("skip", 0.95);
    expect(await classifier.classifyObserved(input, 30)).toMatchObject({
      on_brand: false, reply_kind: "skip",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps the non-observed 0.8 Jev fallback unchanged", async () => {
    const call = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        on_brand: true, on_brand_reason: "ICP", kind: "question",
        velocity_score: 70, q: 70, reply_kind: "substantial",
      }),
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    const classifier = createClassifier({
      backend: { call } as never,
      evaluate: vi.fn().mockResolvedValue({
        kind: "choice", choice: "substantial", probability: 0.79,
        probabilities: { substantial: 0.79, light: 0.12, skip: 0.09 },
        provider: "jev",
      }),
    });
    expect(await classifier.classify(input)).toMatchObject({
      on_brand: true, reply_kind: "substantial", raw: { judge: "legacy" },
    });
  });

  it("retains the observation on a Jev outage without calling the legacy model", async () => {
    const call = vi.fn();
    const classifier = createClassifier({
      backend: { call } as never,
      evaluate: vi.fn().mockResolvedValue({ kind: "unavailable", provider: "jev" }),
      vipScout: true,
    });
    expect(await classifier.classifyObserved(input, 75)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});
