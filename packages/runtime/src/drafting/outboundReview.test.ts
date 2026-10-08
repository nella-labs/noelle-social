import { describe, expect, it } from "vitest";
import { OutboundVerifierMetaSchema } from "@noelle/contracts";
import type { DraftVerdict } from "./draftVerifier.js";
import { toOutboundVerifierMeta } from "./outboundReview.js";

const verdict: DraftVerdict = {
  pass: true, judgeOk: true, judgeProvider: "legacy", fix: null,
  reasons: ["Supported source detail"],
  scores: { voice: 0.9, grounding: 0.8, relevance: 0.9, format: 1, novelty: 1, diversity: 1 },
};

describe("toOutboundVerifierMeta", () => {
  it.each([-1, 1.5, NaN, Infinity])("rejects an invalid repair count %s rather than inventing one", (attempts) => {
    expect(() => toOutboundVerifierMeta(verdict, attempts)).toThrow(RangeError);
  });

  it("preserves a reviewed verdict, score components and repair count on the wire", () => {
    const result = toOutboundVerifierMeta(verdict, 2);
    expect(result).toMatchObject({ pass: true, judgeOk: true, judgeProvider: "legacy",
      scores: verdict.scores, reasons: verdict.reasons, attempts: 2 });
    expect(OutboundVerifierMetaSchema.safeParse(result).success).toBe(true);
  });

  it.each([false, undefined])("requires a successful judge by default when judgeOk is %s", (judgeOk) => {
    const { judgeOk: _judgeOk, judgeProvider: _provider, ...unreviewed } = verdict;
    const result = toOutboundVerifierMeta(judgeOk === false ? { ...unreviewed, judgeOk } : unreviewed, 0);
    expect(result).toMatchObject({ pass: false, judgeOk: false, judgeProvider: "none", attempts: 0 });
  });

  it("keeps legacy fail-open behavior only when explicitly selected", () => {
    const result = toOutboundVerifierMeta({ ...verdict, judgeOk: false }, 1, { requireJudge: false });
    expect(result).toMatchObject({ pass: true, judgeOk: false, judgeProvider: "legacy", attempts: 1 });
    expect(toOutboundVerifierMeta({ ...verdict, pass: false }, 1, { requireJudge: false }).pass).toBe(false);
  });

  it("bounds reasons to the existing wire limit without mutating the verdict", () => {
    const source = { ...verdict, reasons: Array.from({ length: 12 }, (_, n) => `reason ${n}`) };
    const result = toOutboundVerifierMeta(source, 3);
    expect(result.reasons).toEqual(source.reasons.slice(0, 8));
    expect(source.reasons).toHaveLength(12);
    expect(OutboundVerifierMetaSchema.safeParse(result).success).toBe(true);
  });
});
