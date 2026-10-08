import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateJevBoolean } from "./jev.js";

afterEach(() => vi.useRealTimers());

describe("Jev Gateway rate limit", () => {
  it("opens a brief circuit on 429 instead of retrying every observed post", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
    const limited = vi.fn(async () => {
      throw Object.assign(new Error("rate limited"), { name: "GatewayRateLimitError", statusCode: 429 });
    });
    const input = { state: "post", instructions: "Is this useful?", run: limited };
    expect((await evaluateJevBoolean(input)).kind).toBe("unavailable");
    expect((await evaluateJevBoolean(input)).kind).toBe("unavailable");
    expect(limited).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await evaluateJevBoolean(input);
    expect(limited).toHaveBeenCalledTimes(2);
  });
});
