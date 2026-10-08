export type ReplySubmitOutcome = { kind: "ok" } | { kind: "unknown"; detail: string };

interface SubmitEffects {
  claim(): Promise<void>;
  checkStopped(): void;
  click(): Promise<void>;
  verify(): Promise<{ cleared?: boolean; present?: boolean; empty?: boolean } | null>;
  challenge(): Promise<{ observed?: { challenge?: boolean } } | null>;
  sleep(ms: number): Promise<void>;
  delay(min: number, max: number): number;
  notCleared: string;
}

/** One admitted gesture. A lost claim response or any later ambiguity retains the reservation. */
export async function submitRedditReply(effects: SubmitEffects): Promise<ReplySubmitOutcome> {
  try {
    await effects.claim();
    effects.checkStopped();
    // Dispatch may occur before an effect throws; never retry this await.
    await effects.click();
    let cleared = false;
    for (let i = 0; i < 9; i++) {
      await effects.sleep(effects.delay(i === 8 ? 1200 : 300, i === 8 ? 2000 : 500));
      const evidence = await effects.verify().catch(() => null);
      if (evidence?.present === true && evidence.empty === true && evidence.cleared === true) {
        cleared = true;
        break;
      }
    }
    if (!cleared) return { kind: "unknown", detail: effects.notCleared };
    const post = await effects.challenge().catch(() => null);
    if (!post?.observed || typeof post.observed.challenge !== "boolean") {
      return { kind: "unknown", detail: "post-submit-challenge-unreadable" };
    }
    return post.observed.challenge
      ? { kind: "unknown", detail: "post-submit-challenge" }
      : { kind: "ok" };
  } catch {
    return { kind: "unknown", detail: "claim-or-submit-unconfirmed" };
  }
}
