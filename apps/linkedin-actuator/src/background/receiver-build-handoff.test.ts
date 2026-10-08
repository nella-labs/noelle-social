import { describe, expect, it, vi } from "vitest";
import { handoffBuildAtHealthyBrowse, recoverReceiverWithBuildHandoff, shouldReloadBuildAtReceiver } from "./receiver-build-handoff.js";

describe("healthy receiver build handoff", () => {
  const browse = {
    mode: "drain" as const, ambientBrowseSlot: true, discoveryEnabled: true,
    lastReadMs: 0, nowMs: 90_000, receiverHealthy: true,
  };
  it("checks the newer build during a paced ambient browse despite queued comments", async () => {
    const checkNewBuild = vi.fn(async () => true);
    expect(await handoffBuildAtHealthyBrowse({
      ...browse,
      isCurrent: async () => true, checkNewBuild,
    })).toBe(true);
    expect(checkNewBuild).toHaveBeenCalledTimes(1);
  });

  it("does not check a build outside the healthy serialized browse slot", async () => {
    for (const [override, current] of [
      [{ mode: "scheduled" as const }, true],
      [{ ambientBrowseSlot: false }, true],
      [{ discoveryEnabled: false }, true],
      [{ lastReadMs: 1 }, true],
      [{ receiverHealthy: false }, true],
      [{}, false],
    ] as const) {
      const checkNewBuild = vi.fn(async () => true);
      expect(await handoffBuildAtHealthyBrowse({
        ...browse, ...override,
        isCurrent: async () => current, checkNewBuild,
      })).toBe(false);
      expect(checkNewBuild).not.toHaveBeenCalled();
    }
  });
});

describe("missing receiver build handoff", () => {
  it("loads a newly served extension build before the same-stamp page recovery cooldown", async () => {
    const events: string[] = [];
    const checkNewBuild = vi.fn(async () => { events.push("build"); return true; });
    const recoverPage = vi.fn(async () => { events.push("page"); return false; });

    expect(await recoverReceiverWithBuildHandoff({
      isCurrent: async () => true, checkNewBuild, recoverPage,
    })).toBe(true);
    expect(events).toEqual(["build"]);
    expect(recoverPage).not.toHaveBeenCalled();
  });

  it("uses the existing page recovery when no newer build is available", async () => {
    const events: string[] = [];
    expect(await recoverReceiverWithBuildHandoff({
      isCurrent: async () => true,
      checkNewBuild: async () => { events.push("build"); return false; },
      recoverPage: async () => { events.push("page"); return true; },
    })).toBe(true);
    expect(events).toEqual(["build", "page"]);
  });

  it("does not check a build or reload a page after STOP", async () => {
    const checkNewBuild = vi.fn(async () => true);
    const recoverPage = vi.fn(async () => true);
    expect(await recoverReceiverWithBuildHandoff({
      isCurrent: async () => false, checkNewBuild, recoverPage,
    })).toBe(false);
    expect(checkNewBuild).not.toHaveBeenCalled();
    expect(recoverPage).not.toHaveBeenCalled();
  });

  it("does not recover the page if the run changed during the build check", async () => {
    let current = true;
    const recoverPage = vi.fn(async () => true);
    expect(await recoverReceiverWithBuildHandoff({
      isCurrent: async () => current,
      checkNewBuild: async () => { current = false; return false; },
      recoverPage,
    })).toBe(false);
    expect(recoverPage).not.toHaveBeenCalled();
  });
});

describe("new build decision at a serialized receiver slot", () => {
  const base = {
    runActive: true, poolsEmpty: false, hasResumePath: true,
    mode: "drain" as const, dmPoolSize: 0,
    embeddedStamp: "old", servedStamp: "new", lastAttemptedStamp: "older",
  };

  it("allows a queued draft to rehydrate after reload while the tick is browsing", () => {
    expect(shouldReloadBuildAtReceiver({ ...base, serializedReceiverSlot: true })).toBe(true);
  });

  it("keeps the periodic alarm from interrupting a run with loaded drafts", () => {
    expect(shouldReloadBuildAtReceiver({ ...base, serializedReceiverSlot: false })).toBe(false);
  });

  it("does not discard a timed Run's loaded work even if drain intent remains stored", () => {
    expect(shouldReloadBuildAtReceiver({ ...base, mode: "scheduled", serializedReceiverSlot: true })).toBe(false);
  });

  it("does not early-reload a timed Run with pending Like slots when its pools are empty", () => {
    expect(shouldReloadBuildAtReceiver({
      ...base, mode: "scheduled", poolsEmpty: true, serializedReceiverSlot: true,
    })).toBe(false);
  });

  it("does not discard queued DMs in a drain", () => {
    expect(shouldReloadBuildAtReceiver({ ...base, dmPoolSize: 1, serializedReceiverSlot: true })).toBe(false);
  });

  it("retains the periodic empty-pool behavior for a resumable scheduled Run", () => {
    expect(shouldReloadBuildAtReceiver({
      ...base, mode: "scheduled", poolsEmpty: true, serializedReceiverSlot: false,
    })).toBe(true);
  });

  it("never interrupts loaded work without a durable resume path", () => {
    expect(shouldReloadBuildAtReceiver({ ...base, serializedReceiverSlot: true, hasResumePath: false })).toBe(false);
  });

  it("does not reload the same or already attempted build", () => {
    expect(shouldReloadBuildAtReceiver({ ...base, serializedReceiverSlot: true, servedStamp: "old" })).toBe(false);
    expect(shouldReloadBuildAtReceiver({ ...base, serializedReceiverSlot: true, lastAttemptedStamp: "new" })).toBe(false);
  });
});
