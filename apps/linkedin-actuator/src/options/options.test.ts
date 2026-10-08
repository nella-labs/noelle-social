// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.resetModules(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("keeps every saved LinkedIn option while showing a compact shared layout", async () => {
  const config = {
    apiBaseUrl: "http://127.0.0.1:18791", token: "test-token", instanceId: "li-instance",
    caps: { likes: 55, comments: 35, dms: 10 }, preferWatchlistRatio: 0.7,
    deepNightTaper: true, ambientReadActions: true, autonomous: false, autoDrain: true,
    autoStartHour: 9, autoEndHour: 21, autoWindowHours: 8,
    autoTargetComments: 20, autoTargetLikes: 40, challengeCooldownDays: 3,
    autoChallengeBackoffDays: 0, healthGate: true,
  };
  const set = vi.fn(async () => {});
  vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => ({ "actuator.config": config })), set } } });
  await import("./options.js");
  await vi.waitFor(() => expect((document.getElementById("instanceId") as HTMLInputElement).value).toBe("li-instance"));
  for (const id of ["apiBaseUrl", "token", "instanceId", "capLikes", "capComments", "capDms",
    "preferWatchlistRatio", "deepNightTaper", "ambientReadActions", "autonomous", "autoDrain",
    "autoStartHour", "autoEndHour", "autoWindowHours", "autoTargetComments", "autoTargetLikes",
    "challengeCooldownDays", "autoChallengeBackoffDays", "healthGate", "msg"]) {
    expect(document.getElementById(id), id).not.toBeNull();
  }
  expect(document.getElementById("replyAlsoLikes")).toBeNull();
  expect((document.getElementById("token") as HTMLInputElement).type).toBe("password");
  expect(document.querySelector("details")?.open).toBe(false);
  (document.getElementById("capComments") as HTMLInputElement).value = "42";
  document.getElementById("f")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(set).toHaveBeenCalledWith({
    "actuator.config": expect.objectContaining({ token: "test-token", caps: { likes: 55, comments: 42, dms: 10 } }),
  }));
});
