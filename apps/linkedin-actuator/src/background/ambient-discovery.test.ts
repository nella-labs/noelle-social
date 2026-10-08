import { describe, expect, it, vi } from "vitest";
import { runAmbient, type AmbientDeps } from "./ambient.js";

describe("ambient navigation discovery", () => {
  it("uses one existing away-and-back slot and reads the target before returning", async () => {
    const navigate = vi.fn(async () => {});
    const onPageRead = vi.fn(async () => {});
    const deps = {
      cdp: {},
      rng: { int: () => 0, gamma: () => 10 },
      sleep: async () => {},
      send: async () => ({}),
      wpm: 250,
      navigate,
      navigationTarget: "https://www.linkedin.com/in/ada/recent-activity/all/",
      onPageRead,
    } as unknown as AmbientDeps;
    expect(await runAmbient(9, "navigate", deps)).toBe("navigate");
    expect(navigate.mock.calls).toEqual([
      [9, "https://www.linkedin.com/in/ada/recent-activity/all/"],
      [9, "https://www.linkedin.com/feed/"],
    ]);
    expect(onPageRead).toHaveBeenCalledExactlyOnceWith(9);
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(onPageRead.mock.invocationCallOrder[0]!);
    expect(onPageRead.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[1]!);
  });
});
