import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertOnce } from "./notifier.js";
import type { Notifier, NotifyResult } from "./notifier.js";

const target = { orgId: "org", instanceId: "instance" };
const accepted = { status: "sent", channel: "pushover", request: "receipt" } as const;
describe("receipt-aware alert ownership", () => {
  let at: number;
  let notify: ReturnType<typeof vi.fn<Notifier["notify"]>>;
  beforeEach(() => {
    at = 0;
    notify = vi.fn().mockResolvedValue(accepted);
  });
  function fixture() {
    const alert = createAlertOnce({
      notifier: { notify },
      kinds: ["lock"] as const,
      log: { error: vi.fn() },
      now: () => at,
    });
    alert.reconcileInstances([target]);
    return {
      alert,
      send: () =>
        alert.notify({
          ...target,
          kind: "lock",
          title: "Lock",
          message: "fixture",
          throttleMs: 1000,
        }),
    };
  }
  it("retains an accepted receipt through its completed interval, including a real zero clock", async () => {
    const f = fixture();
    expect((await f.send()).status).toBe("sent");
    at = 999;
    expect((await f.send()).status).toBe("throttled");
    at = 1000;
    expect((await f.send()).status).toBe("sent");
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it.each([
    { status: "error", channel: "pushover", detail: "rejected" },
    { status: "no_channel", channel: null, detail: "not configured" },
    { status: "sent", channel: "pushover", request: " " },
  ])("retains no successful timestamp for $status without a valid receipt", async (result) => {
    const f = fixture();
    notify.mockResolvedValueOnce(result as NotifyResult);
    await f.send();
    expect((await f.send()).status).toBe("sent");
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("contains credential failure and retries on the next caller poll", async () => {
    const f = fixture();
    notify.mockRejectedValueOnce(new Error("unavailable"));
    expect((await f.send()).status).toBe("error");
    expect((await f.send()).status).toBe("sent");
  });
  it("separates organization scope and rejects undeclared kinds/inactive targets before dispatch", async () => {
    const f = fixture();
    await f.send();
    f.alert.reconcileInstances([{ ...target, orgId: "other" }]);
    expect((await f.send()).status).toBe("inactive");
    await f.alert.notify({
      ...target,
      orgId: "other",
      kind: "lock",
      title: "Lock",
      message: "fixture",
    });
    await f.alert.notify({
      ...target,
      orgId: "other",
      kind: "unknown" as "lock",
      title: "Lock",
      message: "fixture",
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("holds pending delivery across expiry, removal and readd, stamping only its acceptance", async () => {
    const f = fixture();
    let complete!: (value: NotifyResult) => void;
    notify.mockImplementationOnce(
      () =>
        new Promise<NotifyResult>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = f.send();
    at = 5000;
    f.alert.reconcileInstances([]);
    f.alert.reconcileInstances([target]);
    expect((await f.send()).status).toBe("in_progress");
    expect(notify).toHaveBeenCalledOnce();
    complete(accepted);
    await pending;
    at = 5999;
    expect((await f.send()).status).toBe("throttled");
    at = 6000;
    expect((await f.send()).status).toBe("sent");
  });
  it("never resurrects a departed target after its pending delivery completes", async () => {
    const f = fixture();
    let complete!: (value: NotifyResult) => void;
    notify.mockImplementationOnce(
      () =>
        new Promise<NotifyResult>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = f.send();
    f.alert.reconcileInstances([]);
    complete(accepted);
    await pending;
    f.alert.reconcileInstances([target]);
    expect((await f.send()).status).toBe("sent");
  });
  it("admits every target in a stable ordered 129-instance roster on each due interval", async () => {
    const f = fixture();
    const roster = Array.from({ length: 129 }, (_, i) => ({ ...target, instanceId: String(i) }));
    for (let tick = 0; tick < 3; tick++) {
      f.alert.reconcileInstances(roster);
      for (const row of roster)
        expect(
          (
            await f.alert.notify({
              ...row,
              kind: "lock",
              title: "Lock",
              message: "fixture",
              throttleMs: 1000,
            })
          ).status,
        ).toBe("sent");
      at += 1000;
    }
    expect(notify).toHaveBeenCalledTimes(387);
  });
  it("drops completed departed and expired state rather than retaining historical targets", async () => {
    const f = fixture();
    await f.send();
    f.alert.reconcileInstances([]);
    f.alert.reconcileInstances([target]);
    expect((await f.send()).status).toBe("sent");
    at = 1000;
    f.alert.reconcileInstances([target]);
    expect((await f.send()).status).toBe("sent");
  });
  it("clears a thousand completed departed targets without fixed-cap eviction", async () => {
    const f = fixture();
    const roster = Array.from({ length: 1000 }, (_, i) => ({ ...target, instanceId: String(i) }));
    for (let cycle = 0; cycle < 2; cycle++) {
      f.alert.reconcileInstances(roster);
      for (const row of roster) {
        expect(
          (await f.alert.notify({ ...row, kind: "lock", title: "Lock", message: "fixture" }))
            .status,
        ).toBe("sent");
      }
      f.alert.reconcileInstances([]);
    }
    expect(notify).toHaveBeenCalledTimes(2000);
  });
});
