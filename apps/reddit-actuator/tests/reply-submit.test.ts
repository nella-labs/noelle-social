import { describe, expect, it, vi } from "vitest";
import { submitRedditReply } from "../src/background/reply-submit.js";

function effects() {
  return {
    claim: vi.fn(async () => {}),
    checkStopped: vi.fn(),
    click: vi.fn(async () => {}),
    verify: vi.fn(async () => ({ cleared: true, present: true, empty: true })),
    challenge: vi.fn(async () => ({ observed: { challenge: false } })),
    sleep: vi.fn(async () => {}),
    delay: (min: number) => min,
    notCleared: "post-not-cleared",
  };
}
describe("one reserved Reddit submit", () => {
  it("reserves before the sole gesture and confirms observed emptiness", async () => {
    const e = effects();
    expect(await submitRedditReply(e)).toEqual({ kind: "ok" });
    expect(e.claim.mock.invocationCallOrder[0]).toBeLessThan(e.click.mock.invocationCallOrder[0]!);
    expect(e.click).toHaveBeenCalledTimes(1);
  });
  it.each(["claim", "checkStopped", "click"] as const)(
    "holds an ambiguous %s without replay",
    async (key) => {
      const e = effects();
      e[key].mockImplementation(() => {
        throw new Error("lost response");
      });
      expect(await submitRedditReply(e)).toMatchObject({ kind: "unknown" });
      expect(e.claim).toHaveBeenCalledTimes(1);
      expect(e.click).toHaveBeenCalledTimes(key === "click" ? 1 : 0);
    },
  );
  it.each([
    { cleared: true, present: false, empty: true },
    { cleared: true, present: true, empty: false },
    { cleared: false, present: true, empty: true },
  ])("holds incomplete composer evidence", async (evidence) => {
    const e = effects();
    e.verify.mockResolvedValue(evidence);
    expect(await submitRedditReply(e)).toEqual({ kind: "unknown", detail: "post-not-cleared" });
    expect(e.verify).toHaveBeenCalledTimes(9);
    expect(e.click).toHaveBeenCalledTimes(1);
  });
  it("allows delayed observed confirmation without a second click", async () => {
    const e = effects();
    e.verify.mockResolvedValueOnce({ cleared: false, present: true, empty: false });
    expect(await submitRedditReply(e)).toEqual({ kind: "ok" });
    expect(e.verify).toHaveBeenCalledTimes(2);
    expect(e.click).toHaveBeenCalledTimes(1);
  });
  it.each(["read-error", "challenge", "unknown"])("holds post-submit %s", async (mode) => {
    const e = effects();
    if (mode === "read-error") e.verify.mockRejectedValue(new Error("detached"));
    else if (mode === "challenge") e.challenge.mockResolvedValue({ observed: { challenge: true } });
    else e.challenge.mockRejectedValue(new Error("no observation"));
    expect(await submitRedditReply(e)).toMatchObject({ kind: "unknown" });
    expect(e.click).toHaveBeenCalledTimes(1);
  });
});
