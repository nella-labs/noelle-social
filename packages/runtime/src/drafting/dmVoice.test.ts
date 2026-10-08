import { describe, expect, it, vi } from "vitest";
import { refineDmVoice, scoreFormat } from "./draftVerifier.js";

const stockPhrases = [
  "That's the part I keep getting stuck on: how did you choose permitting?",
  "The part I keep thinking about is measurement.",
  "The line that stuck with me: you started on infra and found the wedge in CI.",
  "Curious how you handle the judging side.",
  "Curious: what's been the biggest myth about diamonds?",
];
const dm = (body: string) => ({ kind: "dm" as const, angle: null, body });

describe("shared DM voice boundary", () => {
  it.each(stockPhrases)("rejects the reported stock framing: %s", (body) => {
    expect(scoreFormat(dm(body), 700, true, true).score).toBeLessThan(0.7);
  });

  it.each([
    "how did you choose the first test group?",
    "hey Maya\n\nthat checklist has more lines than the code 😭",
    "so real",
    "token roulette",
    "the curious dog ate the checklist",
    "the part I ordered arrived yesterday",
  ])("keeps casual reactions and actual content: %s", async (body) => {
    const regenerate = vi.fn();
    expect((await refineDmVoice({ body, regenerate })).body).toBe(body);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("rewrites only the DM once with the shared rejection reason", async () => {
    const body = "how did you choose the first test group?";
    const regenerate = vi.fn().mockResolvedValue(body);
    expect(await refineDmVoice({ body: stockPhrases[3]!, regenerate })).toMatchObject({ body, attempts: 1 });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate.mock.calls[0]![0]).toContain("curious");
  });

  it("never returns a still-bad second attempt", async () => {
    const regenerate = vi.fn().mockResolvedValue(stockPhrases[1]);
    expect(await refineDmVoice({ body: stockPhrases[3]!, regenerate })).toMatchObject({ body: null, attempts: 1 });
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", "   "])("blocks an unusable rewrite: %s", async (rewrite) => {
    expect((await refineDmVoice({ body: stockPhrases[3]!, regenerate: async () => rewrite })).body).toBeNull();
  });

  it("blocks the bad DM if its rewrite fails", async () => {
    expect((await refineDmVoice({ body: stockPhrases[3]!, regenerate: async () => { throw new Error("offline"); } })).body).toBeNull();
  });
});
