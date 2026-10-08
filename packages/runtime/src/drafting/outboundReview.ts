import type { OutboundIn } from "@noelle/contracts";
import type { DraftVerdict } from "./draftVerifier.js";

/** Convert a verdict to bounded outbound metadata without changing its scores. */
export function toOutboundVerifierMeta(
  verdict: DraftVerdict,
  attempts: number,
  options: { requireJudge?: boolean } = {},
): NonNullable<OutboundIn["verifierMeta"]> {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RangeError("Repair count must be a nonnegative integer");
  }
  const judgeOk = verdict.judgeOk === true;
  return {
    // Legacy queues may explicitly retain the verifier's fail-open pass. The
    // separate judge flag still records whether a semantic review succeeded.
    pass: verdict.pass && (options.requireJudge === false || judgeOk),
    judgeOk,
    judgeProvider: verdict.judgeProvider ?? "none",
    scores: verdict.scores,
    reasons: verdict.reasons.slice(0, 8),
    attempts,
  };
}
