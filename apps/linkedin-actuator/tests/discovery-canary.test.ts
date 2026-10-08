import { describe, expect, it, vi } from "vitest";
import {
  DISCOVERY_CANARY_KEY, MAX_DEFERRED_OBSERVATIONS, discoveryReadDue, isBrowserDiscoveryEnabled, runBrowserObservation,
  withDiscoveryBrowseGate,
  type ObservationStatus,
} from "../src/background/discovery-canary.js";
import type { VisiblePost } from "../src/content/discovery.js";

const post = (urn: string) => ({ fingerprint: urn, urn, url: `https://www.linkedin.com/feed/update/${urn}/`, text: "A post", author: "Author" }) as VisiblePost;
const wait = async (_ms: number) => {};

describe("browser discovery canary", () => {
  it("paces discovery reads to the existing 90-second cadence while work is queued", () => {
    expect(discoveryReadDue(0, 90_000)).toBe(true);
    expect(discoveryReadDue(90_000, 179_999)).toBe(false);
    expect(discoveryReadDue(90_000, 180_000)).toBe(true);
  });

  it("keeps browser actions quiet between reads and at full capacity, but preserves legacy ambient when off", async () => {
    const browse = vi.fn(async (_available: number | null) => {});
    const capacity = vi.fn(async () => 0);
    const base = { lastReadMs: 90_000, nowMs: 179_999, capacity, browse };
    expect(await withDiscoveryBrowseGate({ ...base, enabled: true })).toEqual({ checked: false, browsed: false });
    expect(capacity).not.toHaveBeenCalled();
    expect(browse).not.toHaveBeenCalled();

    expect(await withDiscoveryBrowseGate({ ...base, nowMs: 180_000, enabled: true })).toEqual({ checked: true, browsed: false });
    expect(browse).not.toHaveBeenCalled();

    capacity.mockResolvedValueOnce(1);
    expect(await withDiscoveryBrowseGate({ ...base, nowMs: 180_000, enabled: true })).toEqual({ checked: true, browsed: true });
    expect(browse).toHaveBeenCalledWith(1);

    browse.mockClear();
    capacity.mockClear();
    expect(await withDiscoveryBrowseGate({ ...base, enabled: false })).toEqual({ checked: false, browsed: true });
    expect(capacity).not.toHaveBeenCalled();
    expect(browse).toHaveBeenCalledWith(null);
  });

  it("fails closed when the capacity API is unavailable", async () => {
    const browse = vi.fn(async (_available: number | null) => {});
    const onCapacityError = vi.fn(async (_error: unknown) => {});
    expect(await withDiscoveryBrowseGate({
      enabled: true, lastReadMs: 0, nowMs: 90_000,
      capacity: async () => { throw new Error("offline"); }, browse, onCapacityError,
    })).toEqual({ checked: true, browsed: false });
    expect(browse).not.toHaveBeenCalled();
    expect(onCapacityError).toHaveBeenCalledOnce();
  });

  it("does not browse if STOP lands while the capacity request is pending", async () => {
    const browse = vi.fn(async () => {});
    expect(await withDiscoveryBrowseGate({
      enabled: true, lastReadMs: 0, nowMs: 90_000,
      capacity: async () => 1, browse,
      stillCurrent: async () => false,
    })).toEqual({ checked: true, browsed: false });
    expect(browse).not.toHaveBeenCalled();
  });
  it("requires an explicit true storage value and fails closed on storage errors", async () => {
    const store = (value: unknown) => ({ get: async () => ({ [DISCOVERY_CANARY_KEY]: value }) });
    expect(await isBrowserDiscoveryEnabled(store(undefined))).toBe(false);
    expect(await isBrowserDiscoveryEnabled(store("true"))).toBe(false);
    expect(await isBrowserDiscoveryEnabled(store(true))).toBe(true);
    expect(await isBrowserDiscoveryEnabled({ get: async () => { throw new Error("storage failed"); } })).toBe(false);
  });

  it("reports observed, accepted, duplicate, and invalid counts without resending a seen URN", async () => {
    const seen = new Set<string>();
    const report = vi.fn(async (_status: ObservationStatus) => {});
    const send = vi.fn(async () => ({ ok: true, items: [post("urn:li:activity:1"), post("urn:li:activity:2")] }));
    const submit = vi.fn(async () => ({ accepted: 1, duplicates: 1, invalid: 0 }));
    const args = { tabId: 1, instanceId: "instance", send, submit, report, seen, stopped: () => false, enabled: async () => true, now: () => 1000, wait };
    expect(await runBrowserObservation(args)).toMatchObject({ result: "submitted", observed: 2, accepted: 1, duplicates: 1, invalid: 0 });
    expect(await runBrowserObservation(args)).toMatchObject({ result: "empty", observed: 0 });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("pauses extraction at capacity and submits only free slots, retaining later posts", async () => {
    const seen = new Set<string>();
    const deferred: VisiblePost[] = [];
    const send = vi.fn(async () => ({ ok: true, items: [post("urn:li:activity:1"), post("urn:li:activity:2"), post("urn:li:activity:3")] }));
    const submitted: string[][] = [];
    const submit = async (items: VisiblePost[]) => {
      submitted.push(items.map((item) => item.urn!));
      return { accepted: items.length, duplicates: 0, invalid: 0 };
    };
    const base = { tabId: 1, instanceId: "instance", seen, deferred, stopped: () => false,
      enabled: async () => true, now: () => 1000, wait, send, submit,
      report: async (_status: ObservationStatus) => {} };

    expect(await runBrowserObservation({ ...base, available: 0 })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(await runBrowserObservation({ ...base, available: 1 })).toMatchObject({ result: "submitted", accepted: 1 });
    expect(submitted).toEqual([["urn:li:activity:1"]]);
    expect(deferred.map((item) => item.urn)).toEqual(["urn:li:activity:2", "urn:li:activity:3"]);
    expect(await runBrowserObservation({ ...base, available: 1 })).toMatchObject({ result: "submitted", accepted: 1 });
    expect(submitted).toEqual([["urn:li:activity:1"], ["urn:li:activity:2"]]);
    expect(deferred.map((item) => item.urn)).toEqual(["urn:li:activity:3"]);
  });

  it("submits visible anonymous cards within capacity before canonical cards and never defers anonymous overflow", async () => {
    const anonymous = (id: string): VisiblePost => ({ fingerprint: id, text: `Visible ${id}` });
    const urlOnly = { ...anonymous("live-1"), url: "https://www.linkedin.com/posts/example" };
    const deferred: VisiblePost[] = [anonymous("stale"), post("urn:li:activity:9")];
    const submit = vi.fn(async (items: VisiblePost[]) => ({ accepted: items.length, duplicates: 0, invalid: 0 }));
    await runBrowserObservation({
      tabId: 1, instanceId: "instance", seen: new Set(), deferred, available: 2,
      stopped: () => false, enabled: async () => true, now: () => 1000, wait,
      send: async () => ({ ok: true, items: [post("urn:li:activity:1"), urlOnly, anonymous("live-2"), post("urn:li:activity:2")] }),
      submit, report: async (_status: ObservationStatus) => {},
    });
    expect(submit).toHaveBeenCalledWith([urlOnly, anonymous("live-2")]);
    expect(deferred.map((item) => item.urn)).toEqual(["urn:li:activity:1", "urn:li:activity:2", "urn:li:activity:9"]);
  });

  it("stages at most five distinct anonymous cards from one browser read", async () => {
    const items = Array.from({ length: 7 }, (_, index): VisiblePost => ({
      fingerprint: `v1-${index}`, text: `Visible post ${index}`,
    }));
    const send = vi.fn(async () => ({ ok: true, items }));
    const submit = vi.fn(async (batch: VisiblePost[]) => ({ accepted: batch.length, duplicates: 0, invalid: 0 }));
    const seen = new Set(["instance:v1-0"]);
    const base = { tabId: 1, instanceId: "instance", seen, available: 5,
      stopped: () => false, enabled: async () => true, now: () => 1000, wait,
      send, submit, report: async (_status: ObservationStatus) => {} };
    expect(await runBrowserObservation(base)).toMatchObject({ observed: 5, accepted: 5 });
    expect(submit).toHaveBeenCalledExactlyOnceWith(items.slice(1, 6));
    expect(send).toHaveBeenCalledTimes(1);
    expect(await runBrowserObservation({ ...base, available: 1 })).toMatchObject({ observed: 1, accepted: 1 });
    expect(submit).toHaveBeenLastCalledWith([items[6]]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("drains canonical deferred cards without harvesting the browser again", async () => {
    const deferred: VisiblePost[] = [{ fingerprint: "stale", text: "Off-screen" }, post("urn:li:activity:1"), post("urn:li:activity:2")];
    const send = vi.fn(async () => { throw new Error("must not harvest"); });
    const submit = vi.fn(async (items: VisiblePost[]) => ({ accepted: items.length, duplicates: 0, invalid: 0 }));
    const status = await runBrowserObservation({
      tabId: 1, instanceId: "instance", seen: new Set(), deferred, available: 1, deferredOnly: true,
      stopped: () => false, enabled: async () => true, now: () => 1000, wait, send, submit,
      report: async (_status: ObservationStatus) => {},
    });
    expect(status).toMatchObject({ accepted: 1, observed: 2 });
    expect(send).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith([post("urn:li:activity:1")]);
    expect(deferred.map((item) => item.urn)).toEqual(["urn:li:activity:2"]);
  });

  it("bounds canonical deferred storage on stop and excludes anonymous cards", async () => {
    let stopped = false;
    const deferred: VisiblePost[] = [];
    const items = Array.from({ length: MAX_DEFERRED_OBSERVATIONS + 5 }, (_, index) => post(`urn:li:activity:${index + 1}`));
    items.unshift({ fingerprint: "anonymous", text: "Visible only" });
    await runBrowserObservation({
      tabId: 1, instanceId: "instance", seen: new Set(), deferred, available: 1,
      stopped: () => stopped, enabled: async () => true, now: () => 1000, wait,
      send: async () => { stopped = true; return { ok: true, items }; },
      submit: async () => ({ accepted: 1, duplicates: 0, invalid: 0 }),
      report: async (_status: ObservationStatus) => {},
    });
    expect(deferred).toHaveLength(MAX_DEFERRED_OBSERVATIONS);
    expect(deferred.every((item) => Boolean(item.urn && item.url))).toBe(true);
  });

  it("keeps extracted cards for retry when a stop lands before submission", async () => {
    let stopped = false;
    const deferred: VisiblePost[] = [];
    const submit = vi.fn(async () => ({ accepted: 1, duplicates: 0, invalid: 0 }));
    await runBrowserObservation({
      tabId: 1, instanceId: "instance", seen: new Set(), deferred, available: 1,
      stopped: () => stopped, enabled: async () => true, now: () => 1000, wait,
      send: async () => { stopped = true; return { ok: true, items: [post("urn:li:activity:1")] }; },
      submit, report: async (_status: ObservationStatus) => {},
    });
    expect(submit).not.toHaveBeenCalled();
    expect(deferred.map((item) => item.urn)).toEqual(["urn:li:activity:1"]);
  });

  it("deduplicates text-only DOM observations by fingerprint", async () => {
    const seen = new Set<string>();
    const submit = vi.fn(async () => ({ accepted: 1, duplicates: 0, invalid: 0 }));
    const args = {
      tabId: 1, instanceId: "instance", seen, stopped: () => false,
      enabled: async () => true, now: () => 1000, wait,
      send: async () => ({ ok: true, items: [{ fingerprint: "author:body", text: "Full visible post", reactionCount: 12, commentCount: 3 }] as VisiblePost[] }),
      submit, report: async (_status: ObservationStatus) => {},
    };
    expect(await runBrowserObservation(args)).toMatchObject({ result: "submitted", observed: 1, accepted: 1 });
    expect(await runBrowserObservation(args)).toMatchObject({ result: "empty", observed: 0 });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("shares fingerprints from the existing read even when the post was already observed", async () => {
    const onVisible = vi.fn();
    const send = vi.fn(async () => ({ ok: true, items: [{ fingerprint: "already-seen", text: "Full visible post" }] as VisiblePost[] }));
    const submit = vi.fn();
    const status = await runBrowserObservation({
      tabId: 1, instanceId: "instance", seen: new Set(["instance:already-seen"]),
      stopped: () => false, enabled: async () => true, now: () => 1000, wait, send, submit, onVisible,
      report: async (_status: ObservationStatus) => {},
    });
    expect(status).toMatchObject({ result: "empty", observed: 0 });
    expect(onVisible).toHaveBeenCalledWith([{ fingerprint: "already-seen", text: "Full visible post" }]);
    expect(send).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports an extraction failure without submitting posts", async () => {
    const report = vi.fn(async (_status: ObservationStatus) => {});
    const submit = vi.fn(async () => ({ accepted: 1, duplicates: 0, invalid: 0 }));
    const status = await runBrowserObservation({
      tabId: 1, instanceId: "instance", seen: new Set(), stopped: () => false, enabled: async () => true, now: () => 1000, wait,
      send: async () => { throw new Error("content script unavailable"); }, submit, report,
    });
    expect(status).toMatchObject({ result: "failed", stage: "extract", error: "content script unavailable" });
    expect(submit).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
  });

  it("reports submission failure and retries the same URN on the next read", async () => {
    const seen = new Set<string>();
    const report = vi.fn(async (_status: ObservationStatus) => {});
    const send = async () => ({ ok: true, items: [post("urn:li:activity:1")] });
    const submit = vi.fn().mockRejectedValueOnce(new Error("HTTP 503")).mockResolvedValue({ accepted: 1, duplicates: 0, invalid: 0 });
    const args = { tabId: 1, instanceId: "instance", seen, stopped: () => false, enabled: async () => true, now: () => 1000, wait, send, submit, report };
    expect(await runBrowserObservation(args)).toMatchObject({ result: "failed", stage: "submit", observed: 1, error: "HTTP 503" });
    expect(seen.size).toBe(0);
    expect(await runBrowserObservation(args)).toMatchObject({ result: "submitted", observed: 1, accepted: 1 });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("stops before extraction or further batches", async () => {
    const send = vi.fn(async () => ({ ok: true, items: [post("urn:li:activity:1")] }));
    const report = vi.fn(async (_status: ObservationStatus) => {});
    const submit = vi.fn(async () => ({ accepted: 1, duplicates: 0, invalid: 0 }));
    expect(await runBrowserObservation({ tabId: 1, instanceId: "instance", seen: new Set(), stopped: () => true, enabled: async () => true, now: () => 1000, wait, send, submit, report })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("does no extraction or submission while the canary is off", async () => {
    const send = vi.fn(async () => ({ ok: true, items: [post("urn:li:activity:1")] }));
    const submit = vi.fn(async () => ({ accepted: 1, duplicates: 0, invalid: 0 }));
    const report = vi.fn(async (_status: ObservationStatus) => {});
    expect(await runBrowserObservation({
      tabId: 1, instanceId: "instance", seen: new Set(), stopped: () => false,
      enabled: async () => false, now: () => 1000, wait, send, submit, report,
    })).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});
