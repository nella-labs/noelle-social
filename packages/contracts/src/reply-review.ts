/** The semantic review prerequisite for unattended replies. */
export function passesUnattendedReplyReview(
  value: unknown,
  voiceFloor?: number,
): boolean {
  if (!value || typeof value !== "object") return false;
  const review = value as {
    pass?: unknown;
    judgeOk?: unknown;
    scores?: { voice?: unknown };
  };
  if (review.pass !== true || review.judgeOk !== true) return false;
  if (voiceFloor === undefined) return true;
  return typeof review.scores?.voice === "number"
    && Number.isFinite(review.scores.voice)
    && review.scores.voice >= voiceFloor;
}
