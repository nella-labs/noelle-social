import { describe, expect, it } from "vitest";
import { waitForReplyComposer, type ComposerDeps, type ComposerLocation } from "../src/background/composer.js";

const readyBox: ComposerLocation = {
  ok: true, x: 70, y: 70, rect: { x: 50, y: 60, width: 40, height: 20 },
};

function fixture(overrides: Partial<ComposerDeps> = {}) {
  let time = 0;
  const sleeps: number[] = [];
  const d: ComposerDeps = {
    now: () => time,
    sleep: async (ms) => { sleeps.push(ms); time += ms; },
    stale: async () => false,
    onTarget: async () => true,
    postUnavailable: async () => false,
    replyRestricted: async () => false,
    locateBox: async () => ({ ok: false, skipReason: "selector-not-found" }),
    ...overrides,
  };
  return { d, sleeps };
}

describe("waitForReplyComposer", () => {
  it("waits for a late-mounted composer on the target permalink", async () => {
    let probes = 0;
    const { d, sleeps } = fixture({
      locateBox: async () => ++probes === 3 ? readyBox : { ok: false, skipReason: "selector-not-found" },
    });

    expect(await waitForReplyComposer(d, "123", 1600)).toEqual({ kind: "ready", box: readyBox });
    expect(probes).toBe(3);
    expect(sleeps).toEqual([400, 400]);
  });

  it("rechecks restrictions before a later composer probe and permanently skips a restricted post", async () => {
    let checks = 0;
    let probes = 0;
    const { d } = fixture({
      replyRestricted: async () => ++checks === 2,
      locateBox: async () => { probes++; return { ok: false, skipReason: "selector-not-found" }; },
    });

    expect(await waitForReplyComposer(d, "123", 1600)).toEqual({ kind: "unavailable", detail: "reply-restricted" });
    expect(probes).toBe(1);
  });

  it("rechecks the dead-post interstitial during hydration", async () => {
    let checks = 0;
    const { d } = fixture({ postUnavailable: async () => ++checks === 2 });

    expect(await waitForReplyComposer(d, "123", 1600)).toEqual({ kind: "unavailable", detail: "post-unavailable" });
  });

  it("stops if the pinned tab leaves the target permalink, without accepting a different composer", async () => {
    let checks = 0;
    let probes = 0;
    const { d } = fixture({
      onTarget: async () => ++checks < 2,
      locateBox: async () => { probes++; return readyBox; },
    });

    expect(await waitForReplyComposer(d, "123", 1600)).toEqual({ kind: "missing", detail: "target-url-changed(tweet=123)" });
    expect(probes).toBe(0);
  });

  it("bounds missing-composer polls and keeps the selector reason plus tweet ID in the reason text", async () => {
    let probes = 0;
    const { d, sleeps } = fixture({
      locateBox: async () => { probes++; return { ok: false, skipReason: "box-zero-rect" }; },
    });

    expect(await waitForReplyComposer(d, "123", 1200)).toEqual({
      kind: "missing", detail: "box-not-found(selector=box-zero-rect,tweet=123)",
    });
    expect(probes).toBe(4);
    expect(sleeps).toEqual([400, 400, 400]);
  });

  it("does not poll or accept a composer once the run is stale", async () => {
    let probes = 0;
    const { d, sleeps } = fixture({
      stale: async () => true,
      locateBox: async () => { probes++; return readyBox; },
    });

    expect(await waitForReplyComposer(d, "123", 1200)).toEqual({ kind: "stopped" });
    expect(probes).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("does not return a composer when the run stops during the locate probe", async () => {
    let checks = 0;
    const { d } = fixture({
      stale: async () => ++checks === 2,
      locateBox: async () => readyBox,
    });

    expect(await waitForReplyComposer(d, "123", 1200)).toEqual({ kind: "stopped" });
  });
});
