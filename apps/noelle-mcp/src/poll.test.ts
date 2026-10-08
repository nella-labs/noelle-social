import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil } from "./poll.js";

afterEach(() => vi.useRealTimers());

describe("pollUntil", () => {
  it("reads once without waiting when no wait was requested", async () => {
    const read = vi.fn().mockResolvedValue({ status: "pending" });
    expect(await pollUntil<{ status: string }>(read, (r) => r.status === "done", 0)).toEqual({ status: "pending" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns fresh completed output without another read", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce("pending").mockResolvedValueOnce("done");
    const result = pollUntil(read, (r) => r === "done", 10);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe("done");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns pending output at the deadline rather than claiming completion", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue("pending");
    const result = pollUntil(read, (r) => r === "done", 2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBe("pending");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("limits an unbounded caller to 45 seconds", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue("pending");
    const result = pollUntil(read, () => false, Infinity);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await result).toBe("pending");
    expect(read).toHaveBeenCalledTimes(46);
  });
});
