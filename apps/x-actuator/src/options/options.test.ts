// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("retains the X-only option and saves the existing config fields", async () => {
  const config = {
    apiBaseUrl: "http://127.0.0.1:18791", token: "test-token", instanceId: "x-instance",
    caps: { likes: 40, comments: 30, dms: 0 }, preferWatchlistRatio: 0.7,
    deepNightTaper: true, ambientReadActions: true, replyAlsoLikes: false,
    autonomous: false, autoDrain: true, autoStartHour: 9, autoEndHour: 21, autoWindowHours: 8,
    autoTargetComments: 20, autoTargetLikes: 40, challengeCooldownDays: 3,
    autoChallengeBackoffDays: 0, healthGate: true,
    maxWritesPerHour: 3, engagementWeights: { like: 1, bookmark: 0, repost: 0 },
    bridgeSink: false, bridgeUrl: "http://127.0.0.1:18792",
    stallRecoverMinutes: 35, drainShortBandProb: 0.3,
  };
  const set = vi.fn(async () => {});
  vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => ({ "actuator.config": config })), set } } });
  await import("./options.js");
  await vi.waitFor(() => expect((document.getElementById("instanceId") as HTMLInputElement).value).toBe("x-instance"));
  expect(document.getElementById("replyAlsoLikes")).not.toBeNull();
  expect((document.getElementById("capDms") as HTMLInputElement).value).toBe("0");
  (document.getElementById("replyAlsoLikes") as HTMLInputElement).checked = true;
  document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(set).toHaveBeenCalledWith({
    "actuator.config": expect.objectContaining({ token: "test-token", replyAlsoLikes: true,
      caps: { likes: 40, comments: 30, dms: 0 },
      maxWritesPerHour: 3, engagementWeights: { like: 1, bookmark: 0, repost: 0 },
      bridgeSink: false, bridgeUrl: "http://127.0.0.1:18792",
      stallRecoverMinutes: 35, drainShortBandProb: 0.3 }),
  }));
});
