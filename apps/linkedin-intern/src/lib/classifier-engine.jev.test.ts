import { describe, expect, it, vi } from "vitest";
import { createClassifier } from "./classifier-engine.js";

const post = { postText: "We rebuilt onboarding after customers showed us where they got stuck", authorName: "Mira" };

function classifier(choice: unknown, threshold = 75) {
  const call = vi.fn().mockResolvedValue({
    text: '{"q":76,"reply_kind":"substantial","reason":"specific lesson"}',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const evaluateChoice = vi.fn().mockResolvedValue(choice);
  return {
    classify: createClassifier({
      backend: { call } as never,
      qThreshold: threshold,
      evaluateChoice: evaluateChoice as never,
    }),
    call,
    evaluateChoice,
  };
}

describe("LinkedIn Jev qualification", () => {
  it("uses a confident Jev verdict before the legacy model", async () => {
    const { classify, call } = classifier({
      kind: "choice", choice: "substantial",
      probabilities: { substantial: 0.91, light: 0.06, skip: 0.03 }, provider: "jev",
    });
    const result = await classify.classify(post);
    expect(result).toMatchObject({ reply_kind: "substantial", q: 91, tier: "T1", provider: "jev" });
    expect(call).not.toHaveBeenCalled();
  });

  it("uses the existing model when Jev is unavailable for a legacy lead", async () => {
    const { classify, call } = classifier({ kind: "unavailable", provider: "jev" });
    const result = await classify.classify(post);
    expect(result).toMatchObject({ reply_kind: "substantial", q: 76, provider: "legacy" });
    expect(call).toHaveBeenCalledOnce();
  });

  it("never calls the legacy model for an observed lead while Jev is unavailable", async () => {
    const { classify, call } = classifier({ kind: "unavailable", provider: "jev" });
    expect(await classify.classifyObserved(post)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a watched author's low-confidence category without fallback", async () => {
    const { classify, call } = classifier({
      kind: "choice", choice: "substantial",
      probabilities: { substantial: 0.79, light: 0.12, skip: 0.09 }, provider: "jev",
    });
    const result = await classify.classifyObserved(post);
    expect(result).toMatchObject({ reply_kind: "skip", provider: "jev", q: 79 });
    expect(call).not.toHaveBeenCalled();
  });

  it("applies the instance threshold and keeps a confident light reply eligible", async () => {
    const { classify, call, evaluateChoice } = classifier({
      kind: "choice", choice: "light",
      probabilities: { substantial: 0.05, light: 0.92, skip: 0.03 }, provider: "jev",
    }, 90);
    expect(await classify.classifyObserved(post)).toMatchObject({ reply_kind: "light", provider: "jev" });
    expect(call).not.toHaveBeenCalled();
    expect(evaluateChoice).toHaveBeenCalledOnce();
  });

  it("rejects an observed light post below the instance threshold without using a fallback", async () => {
    const { classify, call } = classifier({
      kind: "choice", choice: "light",
      probabilities: { substantial: 0.1, light: 0.85, skip: 0.05 }, provider: "jev",
    }, 90);
    expect(await classify.classifyObserved(post)).toMatchObject({
      reply_kind: "skip", q: 85, provider: "jev", reason: "Below instance classifier threshold",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("compares the exact Jev probability with the instance threshold", async () => {
    const { classify } = classifier({
      kind: "choice", choice: "substantial",
      probabilities: { substantial: 0.899, light: 0.05, skip: 0.051 }, provider: "jev",
    }, 90);
    expect(await classify.classifyObserved(post)).toMatchObject({ reply_kind: "skip", provider: "jev" });
  });

  it("keeps Jev's reply decision while the enabled legacy scout supplies VIP metadata", async () => {
    const call = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        q: 0, reply_kind: "skip", reason: "conflicting scout verdict",
        relationship: {
          vip: true, reason: "YC founder", tags: ["yc-founder"],
          add_to_watchlist: true, dm_soon: true,
        },
      }),
      usage: { input_tokens: 12, output_tokens: 6 },
    });
    const classify = createClassifier({
      backend: { call } as never,
      vipScout: true,
      evaluateBoolean: vi.fn().mockResolvedValue({
        kind: "confident", pass: true, probability: 0.93, provider: "jev",
      }) as never,
      evaluateChoice: vi.fn().mockResolvedValue({
        kind: "choice", choice: "substantial",
        probabilities: { substantial: 0.94, light: 0.03, skip: 0.03 }, provider: "jev",
      }) as never,
    });
    const result = await classify.classifyObserved({ ...post, authorHeadline: "Founder, YC W24" });
    expect(result).toMatchObject({
      provider: "jev", reply_kind: "substantial", q: 94,
      vip: { vip: true, dm_soon: true },
      usage: { inputTokens: 12, outputTokens: 6 },
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it("retains a Jev-qualified observed lead when the optional VIP scout fails", async () => {
    const call = vi.fn().mockRejectedValue(new Error("scout unavailable"));
    const classify = createClassifier({
      backend: { call } as never,
      vipScout: true,
      evaluateBoolean: vi.fn().mockResolvedValue({
        kind: "confident", pass: true, probability: 0.93, provider: "jev",
      }) as never,
      evaluateChoice: vi.fn().mockResolvedValue({
        kind: "choice", choice: "light",
        probabilities: { substantial: 0.03, light: 0.94, skip: 0.03 }, provider: "jev",
      }) as never,
    });
    expect(await classify.classifyObserved(post)).toMatchObject({
      provider: "jev", reply_kind: "light", vip: null,
    });
  });

  it("uses Jev to reject ordinary VIP candidates without a legacy scout call", async () => {
    const call = vi.fn();
    const evaluateBoolean = vi.fn().mockResolvedValue({
      kind: "confident", pass: false, probability: 0.08, provider: "jev",
    });
    const classify = createClassifier({
      backend: { call } as never,
      vipScout: true,
      evaluateBoolean: evaluateBoolean as never,
      evaluateChoice: vi.fn().mockResolvedValue({
        kind: "choice", choice: "substantial",
        probabilities: { substantial: 0.94, light: 0.03, skip: 0.03 }, provider: "jev",
      }) as never,
    });
    expect(await classify.classify(post)).toMatchObject({
      provider: "jev", reply_kind: "substantial", vip: null,
    });
    expect(evaluateBoolean).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });

  it("falls back only the uncertain VIP scout after Jev has qualified the post", async () => {
    const call = vi.fn().mockResolvedValue({
      text: JSON.stringify({ relationship: {
        vip: true, reason: "VC partner", tags: ["investor"],
        add_to_watchlist: true, dm_soon: false,
      } }),
      usage: { input_tokens: 8, output_tokens: 4 },
    });
    const classify = createClassifier({
      backend: { call } as never,
      vipScout: true,
      evaluateBoolean: vi.fn().mockResolvedValue({
        kind: "uncertain", probability: 0.6, provider: "jev",
      }) as never,
      evaluateChoice: vi.fn().mockResolvedValue({
        kind: "choice", choice: "light",
        probabilities: { substantial: 0.03, light: 0.94, skip: 0.03 }, provider: "jev",
      }) as never,
    });
    expect(await classify.classifyObserved(post)).toMatchObject({
      provider: "jev", reply_kind: "light", vip: { vip: true },
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it("does not run the VIP scout when primary Jev qualification is unavailable", async () => {
    const call = vi.fn();
    const evaluateBoolean = vi.fn();
    const classify = createClassifier({
      backend: { call } as never,
      vipScout: true,
      evaluateBoolean: evaluateBoolean as never,
      evaluateChoice: vi.fn().mockResolvedValue({ kind: "unavailable", provider: "jev" }) as never,
    });
    expect(await classify.classifyObserved(post)).toBeNull();
    expect(evaluateBoolean).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("does not spend a second Jev call scouting rejected browser observations", async () => {
    const evaluateBoolean = vi.fn();
    const call = vi.fn();
    const classify = createClassifier({
      backend: { call } as never,
      vipScout: true,
      evaluateBoolean: evaluateBoolean as never,
      evaluateChoice: vi.fn().mockResolvedValue({
        kind: "choice", choice: "skip",
        probabilities: { substantial: 0.03, light: 0.03, skip: 0.94 }, provider: "jev",
      }) as never,
    });
    expect(await classify.classifyObserved(post)).toMatchObject({ reply_kind: "skip", provider: "jev" });
    expect(evaluateBoolean).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
});
