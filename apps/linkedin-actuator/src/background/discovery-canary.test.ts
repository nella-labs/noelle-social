import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverMissingDiscoveryReceiver, runBrowserObservation } from "./discovery-canary.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser observation receiver recovery", () => {
  it("waits for a content script returning from navigation, then submits once", async () => {
    const item = { urn: "urn:li:activity:7507125952691232768" };
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce({ ok: true, items: [item] });
    const submit = vi.fn().mockResolvedValue({ accepted: 1, duplicates: 0, invalid: 0 });
    const report = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    const status = await runBrowserObservation({
      tabId: 9, instanceId: "instance", seen: new Set(),
      stopped: () => false, enabled: async () => true,
      now: () => Date.parse("2026-09-19T21:59:10Z"),
      send, submit, report, wait,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledExactlyOnceWith([item]);
    expect(status).toMatchObject({ result: "submitted", observed: 1, accepted: 1 });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when discovery is stopped during the receiver gap", async () => {
    let stopped = false;
    const send = vi.fn().mockRejectedValue(new Error("Receiving end does not exist."));
    const report = vi.fn().mockResolvedValue(undefined);
    const status = await runBrowserObservation({
      tabId: 9, instanceId: "instance", seen: new Set(),
      stopped: () => stopped, enabled: async () => true,
      now: Date.now, send, submit: vi.fn(), report,
      wait: async () => { stopped = true; },
    });

    expect(status).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it("recovers a persistently missing page receiver during the paced observation slot", async () => {
    const item = {
      urn: "urn:li:activity:7507125952691232768",
      fingerprint: "v1-test", text: "A useful post about a product decision",
    };
    let receiverPresent = false;
    const send = vi.fn(async () => {
      if (!receiverPresent) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true, items: [item] };
    });
    const recoverReceiver = vi.fn(async () => { receiverPresent = true; return true; });
    const submit = vi.fn().mockResolvedValue({ accepted: 1, duplicates: 0, invalid: 0 });

    const status = await runBrowserObservation({
      tabId: 9, instanceId: "instance", seen: new Set(),
      stopped: () => false, enabled: async () => true,
      now: Date.now, send, submit, recoverReceiver,
      report: async () => {}, wait: async () => {},
    });

    expect(status).toMatchObject({ result: "submitted", observed: 1, accepted: 1 });
    expect(send).toHaveBeenCalledTimes(6);
    expect(recoverReceiver).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledExactlyOnceWith([item]);
  });

  it("never reloads the tab for an unrelated extraction error", async () => {
    const recoverReceiver = vi.fn(async () => true);
    const status = await runBrowserObservation({
      tabId: 9, instanceId: "instance", seen: new Set(),
      stopped: () => false, enabled: async () => true,
      now: Date.now, send: async () => { throw new Error("permission denied"); },
      recoverReceiver, submit: vi.fn(), report: async () => {}, wait: async () => {},
    });
    expect(status).toMatchObject({ result: "failed", stage: "extract", error: "permission denied" });
    expect(recoverReceiver).not.toHaveBeenCalled();
  });
});

describe("missing receiver tab recovery", () => {
  it("reloads a still-loading pinned feed after the receiver remains missing", async () => {
    const stored: Record<string, unknown> = {};
    const reload = vi.fn(async () => {});
    const waitForLoad = vi.fn(async () => {});
    vi.stubGlobal("chrome", {
      tabs: {
        get: async () => ({ url: "https://www.linkedin.com/feed/", status: "loading" }),
        reload,
      },
      storage: { local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (patch: Record<string, unknown>) => { Object.assign(stored, patch); },
      } },
    });

    const args = { tabId: 9, buildStamp: "new-build", now: () => 1_000_000,
      isCurrent: async () => true, waitForLoad };
    expect(await recoverMissingDiscoveryReceiver(args)).toBe(true);
    expect(await recoverMissingDiscoveryReceiver(args)).toBe(false);
    expect(reload).toHaveBeenCalledExactlyOnceWith(9);
    expect(waitForLoad).toHaveBeenCalledOnce();
  });

  it("does not reload a loading feed that is navigating to a checkpoint", async () => {
    const reload = vi.fn(async () => {});
    const onSkip = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: {
        get: async () => ({
          url: "https://www.linkedin.com/feed/", status: "loading",
          pendingUrl: "https://www.linkedin.com/checkpoint/challenge/",
        }),
        reload,
      },
      storage: { local: { get: async () => ({}), set: vi.fn() } },
    });

    expect(await recoverMissingDiscoveryReceiver({
      tabId: 9, buildStamp: "new-build", now: () => 1_000_000,
      isCurrent: async () => true, waitForLoad: async () => {}, onSkip,
    })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledExactlyOnceWith("pending_off_feed");
  });

  it("does not reload if a pending navigation appears during the storage check", async () => {
    let pendingUrl: string | undefined;
    const reload = vi.fn(async () => {});
    const onSkip = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { get: async () => ({ url: "https://www.linkedin.com/feed/", pendingUrl, status: "loading" }), reload },
      storage: { local: {
        get: async () => { pendingUrl = "https://www.linkedin.com/checkpoint/challenge/"; return {}; },
        set: vi.fn(),
      } },
    });

    expect(await recoverMissingDiscoveryReceiver({
      tabId: 9, buildStamp: "new-build", now: () => 1_000_000,
      isCurrent: async () => true, waitForLoad: async () => {}, onSkip,
    })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledExactlyOnceWith("tab_changed");
  });

  it("reloads a settled pinned feed tab once, then waits for the content script", async () => {
    const stored: Record<string, unknown> = {};
    const reload = vi.fn(async () => {});
    const waitForLoad = vi.fn(async () => {});
    vi.stubGlobal("chrome", {
      tabs: {
        get: async () => ({ url: "https://www.linkedin.com/feed/", status: "complete" }),
        reload,
      },
      storage: { local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (patch: Record<string, unknown>) => { Object.assign(stored, patch); },
      } },
    });

    const args = { tabId: 9, buildStamp: "new-build", now: () => 1_000_000,
      isCurrent: async () => true, waitForLoad };
    expect(await recoverMissingDiscoveryReceiver(args)).toBe(true);
    expect(await recoverMissingDiscoveryReceiver(args)).toBe(false);
    expect(reload).toHaveBeenCalledExactlyOnceWith(9);
    expect(waitForLoad).toHaveBeenCalledOnce();
  });

  it("does not reload after STOP or when the pinned tab is no longer on the feed", async () => {
    const reload = vi.fn(async () => {});
    let url = "https://www.linkedin.com/feed/";
    const stored: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      tabs: { get: async () => ({ url, status: "complete" }), reload },
      storage: { local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (patch: Record<string, unknown>) => { Object.assign(stored, patch); },
      } },
    });
    const args = { tabId: 9, buildStamp: "new-build", now: () => 1_000_000,
      isCurrent: async () => false, waitForLoad: async () => {} };
    expect(await recoverMissingDiscoveryReceiver(args)).toBe(false);
    url = "https://www.linkedin.com/checkpoint/challenge/";
    expect(await recoverMissingDiscoveryReceiver({ ...args, isCurrent: async () => true })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
